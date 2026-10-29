"""Revised-plan eligibility from fresh fake risk, never live financial authority."""
from datetime import datetime,timezone
from decimal import Decimal
from types import SimpleNamespace
from app.domains.order_intents.contracts import OrderDenied,digest
from app.domains.order_intents.execution_risk import fresh_risk,ExecutionLimits
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.analysis_workflows.action_plan import project
from app.domains.runs.analysis_workflows.plan_revisions import select_plan,records

REVISION_PROVENANCE=('revision_version','revision_math_hash','revision_risk_basis_hash')


def require_current_base(db,analysis,owner,workflow_id,evidence):
    """A saved amendment supersedes unconsumed base-plan authority.

    completed_analysis/Workflows.owned already use the workflow row fence;
    this adds no new lock order or permission. Past effects keep their receipt.
    """
    from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
    try:
        service=Workflows(db,analysis.runtime);row=service.owned(owner,workflow_id)
        original=project(evidence,workflow=row,source=row.execution_json['source'])
        if select_plan(service.stages(row)[-1],original)['version']!=original['version']:
            raise OrderDenied('CURRENT_SAVED_BASE_PLAN_REQUIRED')
    except (WorkflowDenied,KeyError,TypeError,ValueError):
        raise OrderDenied('CURRENT_SAVED_BASE_PLAN_REQUIRED') from None


def selected(db,analysis,owner,workflow_id,version,*,latest=True,now=None):
    service=Workflows(db,analysis.runtime);row=service.owned(owner,workflow_id)
    evidence=analysis.completed_analysis(db,owner,workflow_id,now=now)
    original=project(evidence,workflow=row,source=row.execution_json['source']);stage=service.stages(row)[-1]
    plan=select_plan(stage,original,version)
    if not plan.get('revision_parent') or latest and select_plan(stage,original)['version']!=version:
        raise OrderDenied('CURRENT_SAVED_REVISION_REQUIRED')
    record=next((item['record'] for item in records(stage,original) if item['record']['version']==version),None)
    if record is None:raise OrderDenied('REVISION_RECEIPT_REQUIRED')
    return evidence,plan,record


def derived(plan):
    if plan['portfolio']!='india' or plan['simulation'] is not True or plan['orders_authorized'] is not False:raise OrderDenied('SIMULATED_INDIA_REVISION_REQUIRED')
    legs=[]
    for action in plan['actions']:
        change=Decimal(action['final_units'])-Decimal(action['current_units'])
        if not change:continue
        if action['instrument']!='NSE:SYNTHETIC0' or not change.is_finite() or abs(change)>3 or change!=change.to_integral_value():raise OrderDenied('BOUNDED_SYNTHETIC_REVISION_REQUIRED')
        legs.append({'exchange':'NSE','symbol':'SYNTHETIC0','side':'BUY' if change>0 else 'SELL','quantity':int(abs(change)),'limit_price':'10.01','product':'CNC','order_type':'LIMIT'})
    if len(legs)!=1:raise OrderDenied('ONE_EXACT_REVISED_FAKE_INSTRUCTION_REQUIRED')
    return {'sequencing':'listed','legs':legs}


def assess(orders,db,owner,workflow_id,version,*,now=None,latest=True):
    now=now or datetime.now(timezone.utc)
    evidence,plan,record=selected(db,orders.analysis,owner,workflow_id,version,latest=latest,now=now)
    order=derived(plan);connection=evidence['source']['connection']
    row=SimpleNamespace(owner_id=owner,account_id=connection['account'],connection_id=connection['id'],connection_version=connection['version'],app_mode=connection['mode'],payload_json=order)
    from sqlalchemy import select
    from app.domains.order_intents.models import OrderIntent
    from app.domains.modules.lifecycle import WorkIdentity
    orders.policy(db,WorkIdentity(owner,evidence['module_id'],evidence['module_version']))
    if db.scalar(select(OrderIntent.id).where(OrderIntent.owner_id==owner,OrderIntent.account_id==row.account_id,OrderIntent.state.in_(['submitting','unknown','partial','acknowledged'])).limit(1)) is not None:raise OrderDenied('RECONCILE_EXISTING_ACCOUNT_OUTCOME_FIRST')
    market=orders.market(db,row,now);data=market.read()
    # A completed earlier trade makes the old research holdings stale. Reconcile
    # and acquire a matching source; never reinterpret the target as a delta.
    for action in plan['actions']:
        if action['instrument']=='NSE:SYNTHETIC0' and Decimal(action['current_units'])!=data['instruments']['NSE:SYNTHETIC0']['holdings']:
            raise OrderDenied('REVISION_HOLDINGS_CHANGED')
    risk_hash=fresh_risk(market,row,0,now,ExecutionLimits())
    leg=order['legs'][0];value=Decimal(leg['limit_price'])*leg['quantity'];funds=Decimal(data['funds']);exposure=Decimal(data['exposure']);equity=funds+exposure
    cash=funds-value if leg['side']=='BUY' else funds+value
    after=exposure+value if leg['side']=='BUY' else exposure-value
    options=Workflows(db,orders.analysis.runtime).owned(owner,workflow_id).execution_json.get('research_setup',{})
    policy=options.get('constraints',{'minimum_cash':'0','maximum_position_percent':'100','maximum_turnover_percent':'100'})
    if cash<Decimal(policy['minimum_cash']) or after<0 or equity<=0 or after/equity*100>Decimal(policy['maximum_position_percent']) or value/equity*100>Decimal(policy['maximum_turnover_percent']):raise OrderDenied('REVISION_RESEARCH_CONSTRAINTS_CHANGED')
    return evidence,plan,record,order,{'eligible':True,'simulation_only':True,'live_funds_verified':False,'revision_version':version,'revision_math_hash':record['math_hash'],
        'cash_before':str(funds),'cash_after':str(cash),'exposure_before':str(exposure),'exposure_after':str(after),'turnover_percent':str(value/equity*100),
        'estimated_charges':'0','charge_basis':'zero-fee fake venue only; live charges/taxes are not established','risk_observation_hash':risk_hash,
        'risk_basis_hash':digest({k:v for k,v in data.items() if k!='as_of'}),'checked_at':now.isoformat(),
        'requires_new_exact_approval':True,'orders_authorized':False}


def annotate(db,analysis,plan):
    if plan['portfolio']=='indmoney_us':
        from sqlalchemy import select
        from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
        from app.domains.indmoney_us.import_validation import require_recommendation_snapshot
        from app.domains.runs.analysis_workflows.planning_cash import project_cash
        execution=Workflows(db,analysis.runtime).owned(plan['owner_id'],plan['workflow_id']).execution_json;source=execution['source']
        snapshot=db.scalar(select(IndMoneyUsPortfolioSnapshot).where(IndMoneyUsPortfolioSnapshot.id==source['snapshot_id'],IndMoneyUsPortfolioSnapshot.user_id==plan['owner_id']))
        if snapshot is None:raise OrderDenied('CURRENT_MANUAL_CASH_SOURCE_REQUIRED')
        require_recommendation_snapshot(snapshot)
        if snapshot.content_hash!=source['content_hash']:raise OrderDenied('MANUAL_CASH_SOURCE_CHANGED')
        return project_cash(plan,snapshot.wallet_balance,snapshot_hash=snapshot.content_hash,policy=execution.get('research_setup',{}).get('constraints'))
    if not plan.get('revision_parent'):
        versions=plan.get('versions') or []
        if versions and versions[-1]['version']!=plan['version']:
            return {**plan,'review_available':False}
        return plan
    from .synthetic_orders import SyntheticOrders
    from app.domains.ai_limits.contracts import BoundaryDenied
    try:
        *_,assessment=assess(SyntheticOrders(analysis),db,plan['owner_id'],plan['workflow_id'],plan['version'])
    except (OrderDenied,PermissionError,BoundaryDenied):
        assessment={'eligible':False,'simulation_only':True,'live_funds_verified':False,'orders_authorized':False,'requires_new_exact_approval':True,
            'notice':'Current revised fake-order source, account, funds, holdings, quotes or scope did not verify. No review or approval is available.'}
    return {**plan,'execution_assessment':assessment,'review_available':assessment['eligible'],
        **({'cash_before':assessment['cash_before'],'cash_after':assessment['cash_after']} if assessment['eligible'] else {})}
