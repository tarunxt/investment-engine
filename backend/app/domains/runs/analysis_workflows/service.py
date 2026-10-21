"""Transaction-owned state machine. Broker deliveries are hints, never authority."""
from copy import deepcopy
from datetime import datetime,timezone,timedelta
from uuid import UUID
from zoneinfo import ZoneInfo
from sqlalchemy import select,func
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow,AutoRebalanceWorkflowStage as Stage
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.exceptions import NotFoundException,ConflictException,ValidationException
from .contracts import STAGES,TOPIC,MAX_ATTEMPTS,MAX_WAIT_SECONDS,digest,utc,naive,WorkflowDenied,TransientAnalysisError,PermanentAnalysisError


def now_utc():return datetime.now(timezone.utc)

class Workflows:
    def __init__(self,session,runtime):self.db,self.runtime=session,runtime

    def owned(self,owner,id):
        row=self.db.scalar(select(Workflow).where(Workflow.id==id,Workflow.user_id==owner,Workflow.orchestration_kind=='analysis_v1').execution_options(populate_existing=True).with_for_update())
        if row is None:raise NotFoundException('Owned analysis workflow not found')
        return row

    def stages(self,row):
        self.db.flush()  # SyncSessionLocal disables autoflush; never reload dirty checkpoints.
        rows=list(self.db.scalars(select(Stage).where(Stage.workflow_id==row.id).execution_options(populate_existing=True)))
        if {s.stage for s in rows}!=set(STAGES) or len(rows)!=len(STAGES):raise WorkflowDenied('Persisted stage graph is incomplete')
        return sorted(rows,key=lambda s:STAGES.index(s.stage))

    def enqueue(self,row,stage,*,at=None):
        message=OutboxMessage(topic=TOPIC,payload={'owner_id':row.user_id,'workflow_id':row.id,'stage':stage.stage,'generation':row.control_version},available_at=naive(at or now_utc()))
        self.db.add(message);self.db.flush();return message

    def validate_current(self,row):
        e=row.execution_json
        if not isinstance(e,dict) or digest(e['source'])!=e['source_hash'] or digest(e['plan'])!=e['plan_hash']:raise WorkflowDenied('Input receipt integrity failed')
        self.runtime.policy(self.db,row.user_id,row.portfolio,version=row.module_version,scheduled=e['scheduled'])
        source=self.runtime.source(self.db,row.user_id,row.portfolio,e['snapshot_id'])
        if source.get('owner_id')!=row.user_id or digest(source)!=e['source_hash']:raise WorkflowDenied('Portfolio or connection input version changed; start a new workflow')
        if digest(self.runtime.plan(row.portfolio))!=e['plan_hash']:raise WorkflowDenied('Prompt/model version changed; start a new workflow')
        if row.module_cancel_requested:raise WorkflowDenied('Module cancellation requested')

    def create(self,owner,portfolio,key,*,snapshot_id=None,scheduled_at=None,schedule_id=None,now=None):
        now=utc(now or now_utc())
        if portfolio not in {'indmoney_us','india'} or not isinstance(key,str) or not 8<=len(key)<=96:raise ValidationException('Known portfolio and scoped request key required')
        scheduled=scheduled_at is not None
        if scheduled and (scheduled_at.tzinfo is None or not schedule_id):raise ValidationException('Aware scheduled time and schedule ID required')
        due=utc(scheduled_at) if scheduled else now
        identity=self.runtime.policy(self.db,owner,portfolio,version=None,scheduled=scheduled)
        source=deepcopy(self.runtime.source(self.db,owner,portfolio,snapshot_id));plan=deepcopy(self.runtime.plan(portfolio))
        if source.get('owner_id')!=owner:raise WorkflowDenied('Source owner mismatch')
        source_hash,plan_hash=digest(source),digest(plan)
        calendar=deepcopy(self.runtime.calendar(portfolio,due,now));ZoneInfo(calendar['timezone'])
        if calendar.get('missed_policy')!='skip' or not 0<=calendar['max_lateness_seconds']<=3600 or not calendar.get('calendar_version'):raise ValidationException('Bounded calendar/missed-run policy required')
        request_key=('tick:'+digest([str(schedule_id),due.isoformat()])) if scheduled else key
        intent=digest([portfolio,source_hash,plan_hash,snapshot_id,scheduled,due.isoformat() if scheduled else None,calendar])
        prior=self.db.scalar(select(Workflow).where(Workflow.user_id==owner,Workflow.request_key==request_key))
        if prior:
            if prior.orchestration_kind!='analysis_v1' or prior.execution_json['intent_hash']!=intent:raise ConflictException('Request key already binds different immutable inputs')
            return prior
        active=self.db.scalar(select(func.count()).select_from(Workflow).where(Workflow.user_id==owner,Workflow.orchestration_kind=='analysis_v1',Workflow.status.in_(['queued','processing'])))
        if active>=2:raise ConflictException('At most two active analysis workflows per owner')
        seq=self.db.scalar(select(func.max(Workflow.sequence)).where(Workflow.user_id==owner,Workflow.portfolio==portfolio)) or 0
        row=Workflow(user_id=owner,portfolio=portfolio,sequence=seq+1,label='Server analysis '+str(seq+1),status='queued',current_stage='sync',module_id=identity.module_id,module_version=identity.version,module_cancel_requested=False,orchestration_kind='analysis_v1',request_key=request_key,control_version=0,execution_json={'source':source,'source_hash':source_hash,'plan':plan,'plan_hash':plan_hash,'intent_hash':intent,'snapshot_id':snapshot_id,'scheduled':scheduled,'scheduled_at':due.isoformat() if scheduled else None,'calendar':calendar,'approvals_valid':False,'orders_authorized':False})
        self.db.add(row);self.db.flush()
        for i,name in enumerate(STAGES):self.db.add(Stage(workflow_id=row.id,stage=name,status='queued' if i==0 else 'pending',attempt_count=0,checkpoint_json={'dependencies':list(STAGES[:i]),'attempts':[]}))
        self.db.flush()
        missed=scheduled and (not calendar['market_open'] or (now-due).total_seconds()>calendar['max_lateness_seconds'])
        if missed:row.status='skipped';row.error_message='Scheduled tick skipped by calendar or lateness policy';row.completed_at=naive(now)
        else:self.enqueue(row,self.stages(row)[0],at=due)
        return row

    def control(self,owner,id,action,expected_version,*,now=None):
        # Selection first, workflow second: same lock order as disable and worker.
        hint=self.db.scalar(select(Workflow.portfolio).where(Workflow.id==id,Workflow.user_id==owner))
        if hint is None:raise NotFoundException()
        if action not in {'cancel','pause','resume','retry'}:raise ValidationException('Unknown workflow control')
        from app.domains.modules.lifecycle import sync_owner_fence
        sync_owner_fence(self.db,owner)
        row=self.owned(owner,id)
        if row.control_version!=expected_version:raise ConflictException('Workflow control version changed')
        if row.status in {'completed','cancelled','skipped'}:raise ConflictException('Terminal workflow cannot be resumed or rewritten')
        if action in {'cancel','pause'}:
            row.status='cancelled' if action=='cancel' else 'paused'
            row.error_message='Explicit owner '+action
            for stage in self.stages(row):
                if stage.status!='completed':
                    stage.status=row.status
                    if stage.job_id:
                        from app.domains.jobs.models import Job
                        job=self.db.scalar(select(Job).where(Job.id==stage.job_id,Job.user_id==owner))
                        if job:job.module_cancel_requested=True
        else:
            self.validate_current(row)
            if action=='resume' and row.status!='paused' or action=='retry' and row.status not in {'failed','partial'}:raise ConflictException('Control does not match persisted workflow state')
            stage=next((s for s in self.stages(row) if s.status!='completed'),None)
            if stage is None:raise ConflictException('No failed or paused stage')
            # A queued old job is never recycled after cancellation/pause.
            stage.job_id=None;stage.status='queued';stage.error_message=None;stage.started_at=None;stage.completed_at=None
            checkpoint=deepcopy(stage.checkpoint_json);checkpoint['cycle_attempts']=0;stage.checkpoint_json=checkpoint
            row.status='queued';row.error_message=None;row.completed_at=None
        row.control_version+=1
        if action in {'resume','retry'}:self.enqueue(row,stage,at=now)
        return row

    def consume(self,message_id,*,now=None,fault=lambda point:None):
        now=utc(now or now_utc())
        try:id=UUID(str(message_id))
        except ValueError:return 'invalid_delivery'
        hint=self.db.get(OutboxMessage,id)
        if hint is None or hint.topic!=TOPIC:return 'invalid_delivery'
        payload=deepcopy(hint.payload)
        from app.domains.modules.lifecycle import sync_owner_fence
        if type(payload.get('owner_id')) is not int:return 'invalid_delivery'
        try:sync_owner_fence(self.db,payload['owner_id'])
        except PermissionError:return 'invalid_delivery'
        message=self.db.scalar(select(OutboxMessage).where(OutboxMessage.id==id).execution_options(populate_existing=True).with_for_update())
        if message.execution_attempts:return 'duplicate'
        if message.available_at and utc(message.available_at)>now:return 'not_due'
        try:row=self.owned(payload.get('owner_id'),payload.get('workflow_id'))
        except NotFoundException:return 'invalid_delivery'
        if payload.get('generation')!=row.control_version or row.status not in {'queued','processing'}:message.execution_attempts+=1;return 'obsolete'
        stage=next((s for s in self.stages(row) if s.stage==payload.get('stage')),None)
        if stage is None or stage.stage!=row.current_stage:message.execution_attempts+=1;return 'obsolete'
        prior=self.stages(row)[:STAGES.index(stage.stage)]
        if any(s.status!='completed' or not s.checkpoint_json.get('result_hash') or digest(s.checkpoint_json.get('result'))!=s.checkpoint_json['result_hash'] for s in prior):raise WorkflowDenied('Stage dependencies are incomplete or corrupted')
        try:self.validate_current(row)
        except (WorkflowDenied,PermissionError) as error:
            row.status='paused';row.error_message='Policy/input validation denied; explicit review required';row.control_version+=1;stage.status='paused';message.execution_attempts+=1;return 'policy_denied'
        e=row.execution_json
        if e['scheduled'] and stage.stage=='sync' and not stage.started_at and (now-utc(datetime.fromisoformat(e['scheduled_at']))).total_seconds()>e['calendar']['max_lateness_seconds']:
            row.status='skipped';row.error_message='Missed scheduled tick; no catch-up replay';message.execution_attempts+=1;return 'missed'
        message.execution_attempts+=1
        fault('before_stage')
        row.status='processing';stage.status='processing';row.current_stage=stage.stage
        first=stage.started_at is None
        if first:
            stage.started_at=naive(now);stage.attempt_count+=1
            cp=deepcopy(stage.checkpoint_json);cp['cycle_attempts']=cp.get('cycle_attempts',0)+1;stage.checkpoint_json=cp
        checkpoint=deepcopy(stage.checkpoint_json)
        try:
            # The adapter can only create a durable AI job/outbox or return a
            # deterministic fake. No HTTP/API/provider I/O belongs here.
            try:result=self.runtime.adapter(self.db,row,stage,[s.checkpoint_json['result'] for s in prior],now)
            except (TransientAnalysisError,PermanentAnalysisError):raise
            except Exception:raise PermanentAnalysisError('Unexpected adapter failure') from None
            checkpoint=deepcopy(stage.checkpoint_json)
            fault('after_adapter')
            if result is None:
                if (now-utc(stage.started_at)).total_seconds()>MAX_WAIT_SECONDS:raise PermanentAnalysisError('Analysis job exceeded bounded wait')
                self.enqueue(row,stage,at=now+timedelta(seconds=5));return 'waiting'
            if not isinstance(result,dict):raise PermanentAnalysisError('Invalid stage result')
            if result.get('owner_id')!=row.user_id or result.get('source_hash')!=e['source_hash'] or result.get('plan_hash')!=e['plan_hash']:raise PermanentAnalysisError('Unbound stage result')
            from decimal import Decimal
            try:cost=Decimal(str(result['cost_usd'])) if result.get('cost_usd') is not None else None
            except Exception:raise PermanentAnalysisError('Invalid persisted cost') from None
            if cost is not None and (not cost.is_finite() or cost<0):raise PermanentAnalysisError('Invalid persisted cost')
            checkpoint['attempts']=[*checkpoint['attempts'],{'number':stage.attempt_count,'outcome':'completed','cost_usd':str(cost) if cost is not None else None,'at':now.isoformat()}]
            try:result_hash=digest(result)
            except (TypeError,ValueError):raise PermanentAnalysisError('Non-JSON stage result') from None
            checkpoint.update(result=deepcopy(result),result_hash=result_hash)
            stage.checkpoint_json=checkpoint;stage.status='completed';stage.completed_at=naive(now);stage.summary_json={'server_owned':True,'analysis_only':True,'cost_usd':str(cost) if cost is not None else None,'attempt':stage.attempt_count};stage.error_message=None
            index=STAGES.index(stage.stage)
            if index==len(STAGES)-1:row.status='completed';row.completed_at=naive(now)
            else:
                next_stage=self.stages(row)[index+1];next_stage.status='queued';row.current_stage=next_stage.stage;self.enqueue(row,next_stage,at=now)
            fault('after_checkpoint')
            return 'completed'
        except (TransientAnalysisError,PermanentAnalysisError) as error:
            transient=isinstance(error,TransientAnalysisError)
            checkpoint=deepcopy(stage.checkpoint_json)
            checkpoint['attempts']=[*checkpoint['attempts'],{'number':stage.attempt_count,'outcome':'transient_failure' if transient else 'failed','cost_usd':getattr(error,'cost_usd',None),'job_id':getattr(error,'job_id',stage.job_id),'at':now.isoformat()}]
            stage.checkpoint_json=checkpoint;stage.error_message='Transient analysis failure' if transient else 'Analysis stage failed; inspect owned receipt'
            if transient and checkpoint.get('cycle_attempts',stage.attempt_count)<MAX_ATTEMPTS:
                stage.status='queued';stage.started_at=None;stage.job_id=None;self.enqueue(row,stage,at=now+timedelta(seconds=2**min(checkpoint.get('cycle_attempts',stage.attempt_count),MAX_ATTEMPTS)));return 'retry_scheduled'
            stage.status='failed';stage.completed_at=naive(now);row.status='partial' if prior else 'failed';row.error_message=stage.error_message;return 'failed'

    def detail(self,owner,id):
        row=self.owned(owner,id)
        return {'id':row.id,'owner_id':row.user_id,'portfolio':row.portfolio,'status':row.status,'stage':row.current_stage,'version':row.control_version,'error':row.error_message,'inputs':row.execution_json,'stages':[{'stage':s.stage,'status':s.status,'attempts':s.attempt_count,'job_id':s.job_id,'checkpoint':s.checkpoint_json,'error':s.error_message} for s in self.stages(row)]}
