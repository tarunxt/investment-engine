"""Reviewed queue/diagnostic contracts; no worker, provider or replay activation.

Execution never retries an uncertain effect; reconciliation is a separate
read-only lane. Existing Orders/Budgets own durable admission and settlement.
"""
from dataclasses import dataclass
from datetime import datetime,timezone
from decimal import Decimal,InvalidOperation
from uuid import UUID
from app.domains.ai_limits.contracts import BoundaryDenied

@dataclass(frozen=True)
class QueuePolicy:
    queue:str
    concurrency:int
    per_owner:int
    max_attempts:int
    timeout_seconds:int
    prefetch:int=1

POLICIES={
 'analysis':QueuePolicy('ai',2,1,3,120),
 'execution':QueuePolicy('financial_execution',1,1,1,30),
 'reconciliation':QueuePolicy('financial_reconciliation',1,1,3,30),
}

def admission(kind,*,attempt,outcome):
    if kind not in POLICIES or type(attempt)is not int or attempt<0:raise BoundaryDenied('UNKNOWN_QUEUE_ATTEMPT')
    policy=POLICIES[kind]
    if outcome not in {'not_started','safe_failure','uncertain','completed'}:raise BoundaryDenied('UNKNOWN_OUTCOME')
    if (kind=='execution' and outcome!='not_started') or attempt>=policy.max_attempts or outcome=='completed' or (kind!='reconciliation' and outcome=='uncertain'):raise BoundaryDenied('NO_AUTOMATIC_REPLAY')
    return {'queue':policy.queue,'retry_delay_seconds':min(60,2**attempt),'timeout_seconds':policy.timeout_seconds,'prefetch':1}


def fair_ready(kind,rows,*,active_by_owner,now):
    """Pure scheduling plan only. Durable budgets/order fences still arbitrate.

    One owner gets at most its residual slot per batch. Queue cardinality is
    bounded; caller must derive owner/time/status from locked owned rows.
    """
    if kind not in POLICIES or len(rows)>128 or now.tzinfo is None:raise BoundaryDenied('QUEUE_PLAN_BOUNDARY')
    p=POLICIES[kind];active=dict(active_by_owner)
    if any(type(k)is not int or k<=0 or type(v)is not int or v<0 for k,v in active.items()):raise BoundaryDenied('QUEUE_ACTIVE_COUNTS')
    chosen=[];ids=set()
    for row in sorted(rows,key=lambda r:(r['created_at'],r['id'])):
        if type(row['owner_id'])is not int or row['owner_id']<=0 or row['created_at'].tzinfo is None or row['created_at']>now or row['id'] in ids:raise BoundaryDenied('QUEUE_ROW_BINDING')
        ids.add(row['id'])
        if row['state']!='queued':continue
        if sum(active.values())>=p.concurrency:break
        if active.get(row['owner_id'],0)>=p.per_owner:continue
        active[row['owner_id']]=active.get(row['owner_id'],0)+1;chosen.append(row['id'])
    return chosen


def diagnostics(*,correlation_id,stale_seconds,unknown_orders,cost_usd,cap_usd):
    try:
        correlation_id=str(UUID(str(correlation_id)))
        if type(stale_seconds)is not int or stale_seconds<0 or type(unknown_orders)is not int or unknown_orders<0:raise ValueError
        cost,cap=Decimal(str(cost_usd)),Decimal(str(cap_usd))
        if not cost.is_finite() or not cap.is_finite() or cost<0 or cap<0:raise ValueError
    except (ValueError,TypeError,InvalidOperation):raise BoundaryDenied('DIAGNOSTIC_INPUT_INVALID') from None
    return {'correlation_id':correlation_id,'stale_data':stale_seconds>900,'unknown_orders':unknown_orders>0,'cost_spike':cost>cap,'action':'pause_and_review' if stale_seconds>900 or unknown_orders or cost>cap else 'observe'}
