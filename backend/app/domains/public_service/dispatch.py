"""Durable separate lanes wired to EXISTING guarded synthetic domain workers.

No Celery/Beat registration, process, environment flag or live adapter binding.
A crash after claim is uncertain, never permission to repeat a paid/order effect.
"""
from dataclasses import replace
from datetime import datetime,timezone,timedelta
from uuid import UUID,uuid4
from time import monotonic
from sqlalchemy import select,update
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.domains.modules.models import UserModule
from app.domains.order_intents.models import OrderIntent
from app.domains.order_intents.service import Orders,TOPIC as ORDER_TOPIC
from app.domains.order_intents.execution import ExecutionWorker,venue_binding
from app.domains.ai_limits.jobs import execute_governed_job,SyntheticGovernance
from app.domains.ai_limits.contracts import BoundaryDenied,digest,utc
from .operations import POLICIES,admission
from .store import control,owner
from .residency import SyntheticResidencyProducer
TOPIC='public_service.operational_queue.synthetic.v1'
IMMUTABLE=('owner_id','lane','resource','binding','created_at')

class SyntheticWorkBindings:
    def __init__(self,db,*,residency,analysis=None,execution=None):
        if type(residency)is not SyntheticResidencyProducer:raise BoundaryDenied('REVIEWED_SYNTHETIC_PRODUCER_REQUIRED')
        self.db,self.residency=db,residency;self.analysis=analysis;self.execution=execution;self.executions={};self.effect_fence=lambda:None
        if analysis is not None:
            if type(analysis.governance)is not SyntheticGovernance:raise BoundaryDenied('SYNTHETIC_ANALYSIS_REQUIRED')
            policy=analysis.policy
            def reviewed(session,id,portfolio,**kwargs):
                self.effect_fence()
                self.residency.resolve(session,id,now=self.now)
                return policy(session,id,portfolio,**kwargs)
            self.analysis=replace(analysis,policy=reviewed)
        if execution is not None:
            workers=execution if type(execution)is tuple else (execution,)
            for worker in workers:
                if type(worker)is not ExecutionWorker or worker.db is not db or worker.broker.binding in self.executions:raise BoundaryDenied('SYNTHETIC_EXECUTION_REQUIRED')
                original=worker.orders
                def reviewed_order(session,identity,_original=original):
                    self.effect_fence()
                    self.residency.resolve(session,identity.owner_id,now=self.now)
                    return _original.policy(session,identity)
                orders=Orders(db,policy=reviewed_order,risk=original.risk,clock=original.clock)
                self.executions[worker.broker.binding]=ExecutionWorker(orders,worker.broker,worker.market,limits=worker.limits)
        self.now=datetime.now(timezone.utc)
    def resource(self,id,lane,key,*,check=True,now=None):
        owner(self.db,id,verified=True);self.now=utc(now or datetime.now(timezone.utc))
        if lane=='analysis':
            if self.analysis is None:raise BoundaryDenied('ANALYSIS_BINDING_UNAVAILABLE')
            job=self.db.scalar(select(Job).where(Job.id==int(key),Job.user_id==id).execution_options(populate_existing=True))
            if job is None:raise BoundaryDenied('OWNED_JOB_REQUIRED')
            value={'owner':id,'job':job.id,'module':job.module_id,'version':job.module_version,'context':job.request_context_json,'prompt':job.prompt,'provider':job.provider,'model':job.model}
        elif lane in {'execution','reconciliation'}:
            if self.execution is None:raise BoundaryDenied('EXECUTION_BINDING_UNAVAILABLE')
            if lane=='execution':
                event=self.db.get(OutboxMessage,UUID(str(key)),populate_existing=True)
                if event is None or event.topic!=ORDER_TOPIC or event.payload.get('owner_id')!=id:raise BoundaryDenied('OWNED_ORDER_EVENT_REQUIRED')
                intent=event.payload['intent_id']
            else:intent=key
            row=self.db.scalar(select(OrderIntent).where(OrderIntent.id==intent,OrderIntent.owner_id==id).execution_options(populate_existing=True))
            if row is None:raise BoundaryDenied('OWNED_INTENT_REQUIRED')
            if venue_binding(row) not in self.executions:raise BoundaryDenied('REGISTERED_SYNTHETIC_ACCOUNT_REQUIRED')
            value={'owner':id,'intent':row.id,'module':row.module_id,'version':row.module_version,'account':row.account_id,'connection':row.connection_id,'connection_version':row.connection_version,'payload':row.request_digest,'approval':row.approval_digest}
        else:raise BoundaryDenied('UNKNOWN_LANE')
        if check and lane!='reconciliation':
            self.residency.resolve(self.db,id,now=self.now)
            module=self.db.scalar(select(UserModule).where(UserModule.user_id==id,UserModule.module_id==value['module']).execution_options(populate_existing=True))
            if module is None or not module.enabled or module.version!=value['version']:raise BoundaryDenied('CURRENT_MODULE_REQUIRED')
        return digest(value)
    def run(self,id,lane,key,now,*,fence=lambda:None):
        previous=self.effect_fence;self.effect_fence=fence
        try:return self._run(id,lane,key,now,fence)
        finally:self.effect_fence=previous
    def _run(self,id,lane,key,now,fence):
        fence()
        self.resource(id,lane,key,now=now)
        if lane=='analysis':return execute_governed_job(self.db,int(key),self.analysis,now=now,effect_fence=fence)
        intent=self.db.get(OutboxMessage,UUID(key)).payload['intent_id'] if lane=='execution' else key
        owned=self.db.scalar(select(OrderIntent).where(OrderIntent.id==intent,OrderIntent.owner_id==id))
        worker=self.executions[venue_binding(owned)]
        if lane=='execution':row=worker.dispatch(key,before_effect=fence,effect_fence=fence)
        else:row=worker.reconcile(id,key)
        return {'status':row.state,'intent_id':row.id}

class OperationalQueues:
    def __init__(self,db,bindings):
        if type(bindings)is not SyntheticWorkBindings or bindings.db is not db:raise BoundaryDenied('EXACT_SYNTHETIC_BINDINGS_REQUIRED')
        self.db,self.bindings=db,bindings
    def rows(self):return list(self.db.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC).with_for_update().execution_options(populate_existing=True)))
    def validate(self,row):
        p=row.payload
        if digest({k:p[k] for k in IMMUTABLE})!=p.get('seal'):raise BoundaryDenied('QUEUE_BINDING_CHANGED')
        return p
    def enqueue(self,id,lane,key,*,now=None):
        now=utc(now or datetime.now(timezone.utc));control(self.db,'queues')
        if lane not in POLICIES:raise BoundaryDenied('UNKNOWN_LANE')
        key=str(key);binding=self.bindings.resource(id,lane,key,now=now)
        rows=self.rows()
        for row in rows:
            p=self.validate(row)
            if (p['owner_id'],p['lane'],p['resource'])==(id,lane,key):
                if p['binding']!=binding:raise BoundaryDenied('QUEUE_REPLAY_CONFLICT')
                return row
        if sum(r.payload['state']in {'queued','running','uncertain'} for r in rows)>=128 or sum(r.payload['owner_id']==id and r.payload['state']in {'queued','running','uncertain'} for r in rows)>=16:raise BoundaryDenied('QUEUE_CAPACITY')
        p={'owner_id':id,'lane':lane,'resource':key,'binding':binding,'created_at':now.isoformat()};row=OutboxMessage(topic=TOPIC,payload={**p,'seal':digest(p),'state':'queued','attempts':0,'outcome':'not_started','available_at':now.isoformat()});self.db.add(row);self.db.flush();return row
    def claim(self,lane,*,now=None):
        now=utc(now or datetime.now(timezone.utc));mutex=control(self.db,'queues');policy=POLICIES.get(lane)
        if policy is None:raise BoundaryDenied('UNKNOWN_LANE')
        rows=self.rows();active={};candidates=[]
        for row in rows:
            p=self.validate(row)
            if p['lane']!=lane:continue
            if p['state']=='running' and utc(datetime.fromisoformat(p['deadline']))<=now:
                row.payload=p={**p,'state':'uncertain','outcome':'uncertain'}
            if p['state']in {'running','uncertain'}:active[p['owner_id']]=active.get(p['owner_id'],0)+1
            if p['state']=='queued' and utc(datetime.fromisoformat(p['available_at']))<=now:candidates.append(row)
        last=mutex.payload.get('last_owner',{}).get(lane)
        candidates.sort(key=lambda r:(r.payload['owner_id']==last,r.payload['created_at'],str(r.id)))
        for row in candidates:
            p=row.payload
            if sum(active.values())>=policy.concurrency:break
            if active.get(p['owner_id'],0)>=policy.per_owner:continue
            admission(lane,attempt=p['attempts'],outcome=p['outcome'])
            row.payload={**p,'state':'running','attempts':p['attempts']+1,'lease':str(uuid4()),'deadline':(now+timedelta(seconds=policy.timeout_seconds)).isoformat()}
            mutex.payload={**mutex.payload,'last_owner':{**mutex.payload.get('last_owner',{}),lane:p['owner_id']}}
            self.db.commit();return row.id,row.payload['lease']
        self.db.commit();return None
    def retry(self,id,owner_id,*,now=None):
        now=utc(now or datetime.now(timezone.utc));control(self.db,'queues');owner(self.db,owner_id,verified=True);row=self.db.scalar(select(OutboxMessage).where(OutboxMessage.id==id,OutboxMessage.topic==TOPIC).with_for_update())
        if row is None or row.payload.get('owner_id')!=owner_id:raise BoundaryDenied('OWNED_QUEUE_REQUIRED')
        p=self.validate(row)
        if p['state']!='uncertain' or p['lane']!='reconciliation':raise BoundaryDenied('NO_AUTOMATIC_REPLAY')
        options=admission(p['lane'],attempt=p['attempts'],outcome='uncertain')
        row.payload={**p,'state':'queued','available_at':(now+timedelta(seconds=options['retry_delay_seconds'])).isoformat()};self.db.commit()
    def fence(self,id,lease,*,now):
        # Lock only this queue row, never the global scheduling control. Domain
        # workers retain this transaction through I/O and commit afterwards.
        # Their own durable claim commits release it, so every effect policy
        # and the execution before_effect hook must reacquire and revalidate.
        if self.db.get_bind().dialect.name=='sqlite':
            self.db.execute(update(OutboxMessage).where(OutboxMessage.id==id,OutboxMessage.topic==TOPIC).values(execution_attempts=OutboxMessage.execution_attempts))
        row=self.db.scalar(select(OutboxMessage).where(OutboxMessage.id==id,OutboxMessage.topic==TOPIC).with_for_update().execution_options(populate_existing=True))
        if row is None:raise BoundaryDenied('QUEUE_LEASE_CHANGED')
        p=self.validate(row)
        # Evaluate the clock AFTER lock acquisition; lock waits do not extend a
        # lease. Explicit timestamps remain useful to direct synthetic callers.
        checked_at=utc(now() if callable(now) else now)
        if p.get('lease')!=lease or p['state']!='running' or utc(datetime.fromisoformat(p['deadline']))<=checked_at:raise BoundaryDenied('QUEUE_LEASE_CHANGED')
        return p
    def work_once(self,lane,*,now=None,after_claim=lambda:None):
        now=utc(now or datetime.now(timezone.utc));started_at=monotonic()
        # Explicit synthetic time remains supported; elapsed real time is never
        # frozen while waiting for admission/domain locks or doing preparation.
        def current_time():return now+timedelta(seconds=max(0,monotonic()-started_at))
        claim=self.claim(lane,now=now)
        if claim is None:return None
        id,lease=claim;after_claim() # a BaseException simulates process loss; lease persists
        def fence():
            p=self.fence(id,lease,now=current_time);self.bindings.now=current_time();return p
        try:p=fence()
        except BaseException:
            self.db.rollback();raise
        started=False
        try:
            if self.bindings.resource(p['owner_id'],lane,p['resource'],now=now)!=p['binding']:raise BoundaryDenied('QUEUE_RESOURCE_CHANGED')
            self.db.commit();started=True
            result=self.bindings.run(p['owner_id'],lane,p['resource'],current_time(),fence=fence)
            state='uncertain' if result['status']in {'uncertain','unknown','submitting','cancelled_uncertain'} else ('queued' if result['status']=='waiting_for_admission' else 'completed')
        except Exception:
            self.db.rollback();result={'status':'uncertain' if started else 'blocked'};state=result['status']
        control(self.db,'queues');row=self.db.scalar(select(OutboxMessage).where(OutboxMessage.id==id).with_for_update().execution_options(populate_existing=True))
        if row.payload.get('lease')!=lease or row.payload['state']!='running':
            self.db.rollback();raise BoundaryDenied('QUEUE_LEASE_CHANGED')
        if state=='queued':
            try:options=admission(lane,attempt=row.payload['attempts'],outcome='safe_failure')
            except BoundaryDenied:state='blocked';options={'retry_delay_seconds':0}
            row.payload={**row.payload,'available_at':(now+timedelta(seconds=options['retry_delay_seconds'])).isoformat()}
        row.payload={**row.payload,'state':state,'outcome':'uncertain' if state=='uncertain' else ('safe_failure' if state=='queued' else 'completed'),'result_hash':digest(result)}
        if lane=='reconciliation' and result.get('status')in {'filled','rejected','cancelled'}:
            for old in self.rows():
                if old.payload['owner_id']==p['owner_id'] and old.payload['lane']=='execution' and old.payload['state']=='uncertain':
                    event=self.db.get(OutboxMessage,UUID(old.payload['resource']))
                    if event and event.payload.get('intent_id')==p['resource'] and self.bindings.resource(p['owner_id'],'execution',old.payload['resource'],check=False,now=now)==old.payload['binding']:
                        old.payload={**old.payload,'state':'reconciled','outcome':'completed'}
        self.db.commit()
        from .monitoring import OperationalMonitor
        OperationalMonitor(self.db).observe(p['owner_id'],correlation_id=lease,now=now)
        return {'queue_id':str(id),'state':state,'result':result}
