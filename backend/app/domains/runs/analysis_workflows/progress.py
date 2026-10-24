"""Owner-scoped, read-only progress facts. No guessed provider completion/cost."""
from datetime import datetime,timezone
from sqlalchemy import select
from app.domains.jobs.models import Job
from app.shared.types import JobStatus
from .contracts import utc

FAILURES={'source_partial','invalid_input','budget_stop','unknown_spend','policy_stopped','failed'}
BUDGET_CODES={'TOKEN_OR_FANOUT_LIMIT','TARIFF_BREACH_REQUIRES_REVIEW','QUEUE_CAPACITY_LIMIT','ATTEMPT_LIMIT','BUDGET_CANCELLED_OR_TARIFF_BREACH','ACCOUNT_UNAVAILABLE'}
UNRESOLVED_SPEND={'started','uncertain','cancelled_uncertain','tariff_breach'}

def operation_facts(db,row,stages):
    ids=set()
    for stage in stages:
        if stage.job_id:ids.add(stage.job_id)
        for entry in (stage.checkpoint_json or {}).get('job_history',[]):
            if type(entry.get('job_id')) is int:ids.add(entry['job_id'])
    complete=len(ids)<=256
    jobs=list(db.scalars(select(Job).where(Job.user_id==row.user_id,Job.id.in_(sorted(ids)[:256])))) if ids else []
    complete=complete and len(jobs)==len(ids)
    unresolved=not complete
    unknown=not complete
    settled_spend=0
    if row.execution_json.get('plan',{}).get('guardrails_version')=='stage13-v1' and ids:
        from app.domains.recommendation_audit.models import SpendAttempt
        attempts=list(db.scalars(select(SpendAttempt).where(SpendAttempt.user_id==row.user_id,SpendAttempt.operation_key.in_(['analysis-job:'+str(id) for id in sorted(ids)[:256]]))))
        unresolved=unresolved or any(attempt.status in UNRESOLVED_SPEND for attempt in attempts)
        unknown=unknown or any(attempt.status in {'uncertain','cancelled_uncertain','tariff_breach'} for attempt in attempts)
        settled_spend=sum(attempt.status in {'settled','cancelled_settled'} for attempt in attempts)
        receipt_ids={str(attempt.id) for attempt in attempts}
        missing_receipt=any((job.runtime_metadata_json or {}).get('budget_attempt_id') and str(job.runtime_metadata_json['budget_attempt_id']) not in receipt_ids for job in jobs)
        unknown=unknown or missing_receipt;unresolved=unresolved or missing_receipt
    kind='failed'
    for stage in reversed(stages):
        value=(stage.checkpoint_json or {}).get('failure_kind')
        if value in FAILURES:kind=value;break
    unknown=unknown or row.status in {'failed','partial','completed'} and unresolved
    if unknown:kind='unknown_spend'
    cancellation_pending=(row.status=='cancelled' or row.module_cancel_requested) and (any(job.status==JobStatus.PROCESSING for job in jobs) or unresolved)
    return {'jobs':jobs,'history_complete':complete,'unresolved_spend':unresolved,'unknown_spend':unknown,'failure_kind':kind,'cancellation_pending':cancellation_pending,'settled_spend':settled_spend,'stop_cost_possible':(row.status in {'paused','cancelled'} or row.module_cancel_requested) and (any(job.status==JobStatus.PROCESSING for job in jobs) or unresolved)}

def permitted_actions(row,stages,facts=None):
    safe=facts is not None and facts['history_complete'] and not facts['unresolved_spend'] and not row.module_cancel_requested
    reasons={(stage.checkpoint_json or {}).get('pause_reason') for stage in stages if stage.status!='completed'}
    resumable=safe and (('owner_pause' in reasons and facts['failure_kind']=='failed') or ('input_or_policy' in reasons and facts['failure_kind']=='policy_stopped'))
    return {'pause':row.status in {'queued','processing'},'cancel':row.status in {'queued','processing','paused','failed','partial'},'resume':row.status=='paused' and resumable,'retry':row.status in {'failed','partial'} and safe and facts['failure_kind']=='failed'}

def progress_view(db,row,stages):
    facts=operation_facts(db,row,stages);now=datetime.now(timezone.utc)
    created=utc(row.created_at);started=min((utc(s.started_at) for s in stages if s.started_at),default=created)
    finished=utc(row.completed_at) if row.completed_at else now
    elapsed=(finished-started).total_seconds()
    updated=max([utc(row.updated_at),*[utc(s.updated_at) for s in stages]])
    owner_paused=any((stage.checkpoint_json or {}).get('pause_reason')=='owner_pause' for stage in stages)
    state='unknown_spend' if facts['unknown_spend'] else 'cancel_requested' if facts['cancellation_pending'] or row.module_cancel_requested and row.status not in {'completed','cancelled'} else facts['failure_kind'] if row.status in {'failed','partial','paused'} and facts['failure_kind']!='failed' else 'paused' if row.status=='paused' and owner_paused else row.status

    return {'display_state':state,'created_at':created.isoformat(),'started_at':started.isoformat(),'updated_at':updated.isoformat(),'completed_at':utc(row.completed_at).isoformat() if row.completed_at else None,
        'observed_at':now.isoformat(),'elapsed_seconds':elapsed if elapsed>=0 else None,'elapsed_definition':'Wall time from first start (or queue time) to completion/observation, including waits and pauses',
        'history_complete':facts['history_complete'],'unresolved_spend':facts['unresolved_spend'],'inflight_cost_possible':facts['stop_cost_possible'] or facts['unresolved_spend'],
        'actions':permitted_actions(row,stages,facts),
        'progress_rank':[row.control_version,sum(s.status=='completed' for s in stages),sum(len((s.checkpoint_json or {}).get('attempts',[])) for s in stages),sum(s.attempt_count for s in stages),sum(len((s.checkpoint_json or {}).get('job_history',[])) for s in stages),sum(job.status not in JobStatus.active() for job in facts['jobs']),facts['settled_spend'],{'queued':0,'processing':1,'paused':2,'skipped':3,'failed':3,'partial':3,'cancelled':3,'completed':4}.get(row.status,0)]}
