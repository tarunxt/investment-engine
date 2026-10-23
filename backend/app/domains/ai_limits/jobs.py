"""Stage13 composition of EXISTING durable jobs, never normal runtime activation.

Only the exact server-owned synthetic composition is supported here. Real model
adapters, tariffs/tools and customer limits remain separate product/provider
gates. Legacy jobs keep their existing lifecycle; no new task queue is created.
"""
from dataclasses import dataclass
from datetime import datetime,timezone
import json
from sqlalchemy import select
from app.domains.jobs.models import Job
from app.domains.modules.lifecycle import WorkIdentity
from app.domains.runs.analysis_workflows.bindings import validate_job_request,dependency_results
from app.domains.runs.analysis_workflows.service import Workflows
from app.shared.types import JobStatus
from .budget import Budgets,request_binding
from .contracts import BoundaryDenied,Limits,digest
from .runner import FakeProvider,run_next
from .validation import validate_recommendations,validate_source
from .projection import frozen_projection,projection


@dataclass(frozen=True)
class SyntheticGovernance:
    limits:Limits
    source:object # trusted owned recommendation source resolver
    instruments:object # trusted catalogue resolver, never model output
    provider:object # explicit FakeProvider factory; no live fallback


def job_request(row,job):
    return {'job_id':job.id,'prompt_hash':digest(job.prompt),'input_hash':row.execution_json['source_hash'],'plan_hash':row.execution_json['plan_hash'],'provider':job.provider,'model':job.model}


def recommendation_source(db,row,job,governance,now):
    frozen=frozen_projection(row)
    source=governance.source(db,row,job,now)
    validate_source(source,owner_id=job.user_id,module_id=job.module_id,now=now)
    if source['content_hash']!=row.execution_json['source_hash'] or source['provenance']!={'provider':job.provider,'model':job.model,'prompt_hash':digest(job.prompt),'input_hash':row.execution_json['source_hash'],'prompt_version':job.request_context_json['prompt_version']}:
        raise BoundaryDenied('GOVERNED_PROVENANCE_MISMATCH')
    if set(source)!={'owner_id','module_id','currency','captured_at','holdings','content_hash','provenance'} or projection(source,owner=job.user_id,module=job.module_id)!=frozen:
        raise BoundaryDenied('GOVERNED_SOURCE_PROJECTION_MISMATCH')
    # Return only facts derived from the frozen bytes. A correct hash label
    # never licenses a resolver's substituted or additional context.
    return {**frozen,'content_hash':row.execution_json['source_hash'],'provenance':dict(source['provenance'])}


def validate_completed_job(db,row,job,governance,now):
    """Revalidate actual bytes and receipt at checkpoint consumption, not badges."""
    from app.domains.recommendation_audit.models import SpendAttempt,SpendAccount
    if type(governance) is not SyntheticGovernance:raise BoundaryDenied('GOVERNED_RUNTIME_UNAVAILABLE')
    source=recommendation_source(db,row,job,governance,now)
    try:document=json.loads(job.response)
    except (ValueError,TypeError):raise BoundaryDenied('GOVERNED_RESPONSE_SCHEMA') from None
    verdict=validate_recommendations(document,source=source,owner_id=job.user_id,module_id=job.module_id,now=now,allowed_instruments=governance.instruments(db,row,job))
    metadata=job.runtime_metadata_json or {}
    attempt=db.get(SpendAttempt,metadata.get('budget_attempt_id'),populate_existing=True) if metadata.get('budget_attempt_id') else None
    account=db.get(SpendAccount,attempt.account_id,populate_existing=True) if attempt is not None else None
    expected=request_binding(WorkIdentity(job.user_id,job.module_id,job.module_version),job_request(row,job),governance.limits,len(job.prompt.encode()),governance.limits.max_output_tokens,1)
    if (metadata.get('guardrails')!=verdict or attempt is None or account is None or account.user_id!=job.user_id or attempt.user_id!=job.user_id
        or attempt.operation_key!='analysis-job:'+str(job.id) or attempt.module_id!=job.module_id
        or attempt.module_version!=job.module_version or attempt.status!='settled'
        or attempt.actual_usd!=0 or job.estimated_cost!=0 or attempt.request_hash!=expected):
        raise BoundaryDenied('GOVERNED_BUDGET_OR_OUTPUT_RECEIPT')
    return verdict


def execute_governed_job(db,job_id,runtime,*,now=None,effect_fence=lambda:None):
    now=now or datetime.now(timezone.utc)
    if runtime is None or type(runtime.governance) is not SyntheticGovernance:
        raise BoundaryDenied('GOVERNED_RUNTIME_UNAVAILABLE')
    governance=runtime.governance
    def bound():
        job=db.scalar(select(Job).where(Job.id==job_id).execution_options(populate_existing=True))
        context=job.request_context_json if job else None
        if not isinstance(context,dict) or context.get('guardrails_version')!='stage13-v1' or job.module_cancel_requested:
            raise BoundaryDenied('GOVERNED_JOB_BINDING')
        workflows=Workflows(db,runtime);row=workflows.owned(job.user_id,context.get('workflow_id'));workflows.validate_current(row)
        if row.execution_json['plan'].get('guardrails_version')!='stage13-v1':
            raise BoundaryDenied('GOVERNED_PLAN_REQUIRED')
        stage=next((s for s in workflows.stages(row) if s.job_id==job.id),None)
        if stage is None or row.status!='processing' or stage.status!='processing':raise BoundaryDenied('GOVERNED_STAGE_NOT_ACTIVE')
        validate_job_request(row,stage,job,dependency_results(workflows.stages(row),stage))
        return job,row
    job,row=bound()
    if job.status==JobStatus.COMPLETED:
        validate_completed_job(db,row,job,governance,now)
        return {'status':'already_completed','job_id':job.id}
    if job.status not in JobStatus.active():raise BoundaryDenied('GOVERNED_JOB_NOT_ACTIVE')
    request=job_request(row,job)
    # Bound source/plan facts were read under the existing owner lock. Release
    # before platform admission, then recheck after every wait and before I/O.
    identity=WorkIdentity(job.user_id,job.module_id,job.module_version)
    source=recommendation_source(db,row,job,governance,now)
    provider=governance.provider(source)
    if type(provider) is not FakeProvider:raise BoundaryDenied('FAKE_PROVIDER_REQUIRED')
    prompt_bytes=len(job.prompt.encode());db.commit()
    def policy(session,current):
        portfolio={'indmoney_us':'indmoney_us','zerodha_rebalance':'india'}.get(current.module_id)
        if portfolio is None:raise BoundaryDenied('GOVERNED_OWNER_MODULE_MISMATCH')
        actual=runtime.policy(session,current.owner_id,portfolio,version=current.version)
        if actual!=current:raise BoundaryDenied('GOVERNED_OWNER_MODULE_MISMATCH')
    budget=Budgets(db,governance.limits,policy)
    attempt=budget.enqueue(identity,'analysis-job:'+str(job.id),'generation-1',request,input_tokens=prompt_bytes,output_tokens=governance.limits.max_output_tokens,fanout=1,now=now)
    db.commit()
    # Duplicate/uncertain deliveries cannot repeat paid work. Known zero-cost
    # synthetic result loss still requires explicit review, never hidden replay.
    if attempt.status not in {'queued'}:return {'status':attempt.status,'partial_analysis':True,'job_id':job.id}
    def validate(document):
        bound()
        current_source=recommendation_source(db,row,job,governance,now)
        return validate_recommendations(document,source=current_source,owner_id=job.user_id,module_id=job.module_id,now=now,allowed_instruments=governance.instruments(db,row,job))
    def before_call():
        bound();recommendation_source(db,row,job,governance,now)
    result=run_next(budget,provider,validate=validate,now=now,expected_id=attempt.id,before_call=before_call,effect_fence=effect_fence)
    if result['status']=='quota_or_concurrency_or_no_work':
        result={**result,'status':'waiting_for_admission' if attempt.status=='queued' else attempt.status}
    if result['status']=='completed':
        job,row=bound();job.response=json.dumps(result['document'],sort_keys=True,allow_nan=False)
        job.status=JobStatus.COMPLETED;job.estimated_cost=0;job.tokens_in=min(10,attempt.input_tokens);job.tokens_out=min(10,attempt.output_tokens)
        job.runtime_metadata_json={**(job.runtime_metadata_json or {}),'guardrails':result['validation'],'budget_attempt_id':attempt.id}
        db.commit()
    return {**result,'job_id':job.id}
