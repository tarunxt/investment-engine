"""Persisted analysis binding rechecked inside the existing side-effect fence."""
from contextvars import ContextVar
from contextlib import contextmanager
from app.domains.modules.lifecycle import ModuleLifecycleDenied

_job = ContextVar('durable_analysis_effect_job', default=None)

@contextmanager
def job_scope(job_id):
    token = _job.set(job_id)
    try:
        yield
    finally:
        _job.reset(token)

def validate_effect(session):
    job_id = _job.get()
    if job_id is None:
        return
    from app.domains.jobs.models import Job
    job = session.get(Job, job_id, populate_existing=True)
    if job is None:
        raise ModuleLifecycleDenied('Analysis job disappeared before effect')
    context = job.request_context_json
    if not isinstance(context,dict) or context.get('kind') != 'durable_analysis_v1':
        from sqlalchemy import select
        from app.domains.runs.models import AutoRebalanceWorkflow, AutoRebalanceWorkflowStage
        linked=session.scalar(select(AutoRebalanceWorkflow.id).join(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflow.orchestration_kind=='analysis_v1',AutoRebalanceWorkflowStage.job_id==job.id))
        if linked is not None:
            raise ModuleLifecycleDenied('Persisted analysis job lost its binding')
        return  # Existing unrelated job behavior is unchanged.
    from .runtime import configured_runtime
    from .service import Workflows
    runtime = configured_runtime()
    if runtime is None:
        raise ModuleLifecycleDenied('Durable analysis runtime unavailable')
    service = Workflows(session, runtime)
    from app.shared.exceptions import NotFoundException
    try:row = service.owned(job.user_id, context.get('workflow_id'))
    except NotFoundException:raise ModuleLifecycleDenied('Owned analysis workflow binding unavailable') from None
    service.validate_current(row)
    stage = next((s for s in service.stages(row) if s.stage == context.get('stage')), None)
    if (row.status != 'processing' or stage is None or stage.job_id != job.id
            or stage.status != 'processing' or job.module_cancel_requested
            or context.get('source_hash') != row.execution_json['source_hash']
            or context.get('plan_hash') != row.execution_json['plan_hash']):
        raise ModuleLifecycleDenied('Analysis job no longer binds current owned work')

    from .bindings import dependency_results,validate_job_request
    validate_job_request(row,stage,job,dependency_results(service.stages(row),stage))
