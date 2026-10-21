"""Analysis adapters enqueue existing jobs. They never call brokers/providers."""
from copy import deepcopy
from decimal import Decimal
from sqlalchemy import select
from app.domains.jobs.models import Job
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.types import JobStatus
from .contracts import digest,PermanentAnalysisError,TransientAnalysisError

class QueuedAI:
    def __call__(self,db,row,stage,dependencies,now):
        e=row.execution_json
        if stage.stage=='sync':return {'owner_id':row.user_id,'source_hash':e['source_hash'],'plan_hash':e['plan_hash'],'data':deepcopy(e['source']),'cost_usd':'0'}
        if stage.job_id is None:
            target=e['plan']['stages'][stage.stage]
            if not all(isinstance(target.get(k),str) and target[k] for k in ['provider','model','prompt_version','template']):raise PermanentAnalysisError('Approved model/prompt plan required')
            # Analysis is queued using the same Stage04 dispatcher and worker.
            # Export/mail/order flags are deliberately absent/disabled.
            job=Job(user_id=row.user_id,module_id=row.module_id,module_version=row.module_version,module_cancel_requested=False,prompt=target['template']+'\n'+__import__('json').dumps({'immutable_source':e['source'],'dependencies':dependencies},sort_keys=True),provider=target['provider'],model=target['model'],status=JobStatus.PENDING,auto_rebalance_portfolio=row.portfolio,auto_rebalance_sequence=row.sequence,auto_rebalance_label=row.label,export_status='disabled',request_context_json={'kind':'durable_analysis_v1','workflow_id':row.id,'stage':stage.stage,'source_hash':e['source_hash'],'plan_hash':e['plan_hash'],'analysis_only':True,'orders_authorized':False},runtime_metadata_json={'prompt_version':target['prompt_version'],'plan_version':e['plan']['version']})
            db.add(job);db.flush();stage.job_id=job.id
            checkpoint=deepcopy(stage.checkpoint_json);checkpoint['job_history']=[*checkpoint.get('job_history',[]),{'job_id':job.id,'attempt':stage.attempt_count}];stage.checkpoint_json=checkpoint
            db.add(OutboxMessage(topic='job.created.v2',payload={'job_id':job.id,'user_id':row.user_id}));db.flush();return None
        job=db.scalar(select(Job).where(Job.id==stage.job_id,Job.user_id==row.user_id).execution_options(populate_existing=True))
        context=job.request_context_json if job else {}
        if not job or job.module_id!=row.module_id or job.module_version!=row.module_version or context.get('workflow_id')!=row.id or context.get('stage')!=stage.stage or context.get('source_hash')!=e['source_hash'] or context.get('plan_hash')!=e['plan_hash']:raise PermanentAnalysisError('Job result ownership/provenance failed')
        if job.module_cancel_requested:raise PermanentAnalysisError('Job cancelled')
        if job.status in JobStatus.active():return None
        if job.status!=JobStatus.COMPLETED:
            error=PermanentAnalysisError('Persisted analysis job failed')
            error.cost_usd=str(job.estimated_cost) if job.estimated_cost is not None else None;error.job_id=job.id;raise error
        return {'owner_id':row.user_id,'source_hash':e['source_hash'],'plan_hash':e['plan_hash'],'data':{'job_id':job.id,'response':job.response,'tokens_in':job.tokens_in,'tokens_out':job.tokens_out},'cost_usd':str(job.estimated_cost) if job.estimated_cost is not None else None}

class DeterministicAnalysis:
    """Only explicitly injected by isolated tests/preview; no environment fallback."""
    def __call__(self,db,row,stage,dependencies,now):
        e=row.execution_json
        return {'owner_id':row.user_id,'source_hash':e['source_hash'],'plan_hash':e['plan_hash'],'data':{'simulation':True,'stage':stage.stage,'checkpoint':digest([row.id,stage.stage,e['source_hash'],dependencies]),'financial_execution':False},'cost_usd':'0'}
