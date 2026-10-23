"""Local-only linked analysis, using real source and Stage13 governance guards.

This module is installed only by the network-denied disposable preview. It does
not register a production runtime, accept imports, enable modules or authorize
orders. Fake acquisition is explicit; source reads never manufacture provenance.
"""
import json
import os
import re
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select

if os.environ.get('STAGE01_PREVIEW') != 'synthetic-only':
    raise RuntimeError('Local synthetic preview only')

from app.domains.ai_limits.contracts import BoundaryDenied, Limits
from app.domains.ai_limits.jobs import SyntheticGovernance, execute_governed_job, validate_completed_job
from app.domains.ai_limits.projection import frozen_projection, projection
from app.domains.ai_limits.runner import FakeProvider
from app.domains.connections.models import IntegrationConnection
from app.domains.jobs.models import Job
from app.domains.modules.policy import ModuleFacts
from app.domains.recommendation_audit.models import SpendAccount, SpendAttempt
from app.domains.runs.analysis_router import router, optional_analysis_runtime
from app.domains.runs.analysis_workflows.acquisition import acquisition_payload, validate_acquisition
from app.domains.runs.analysis_workflows.adapters import QueuedAI
from app.domains.runs.analysis_workflows.bindings import dependency_results, validate_job_request
from app.domains.runs.analysis_workflows.contracts import Runtime, STAGES, TOPIC, WorkflowDenied, digest, naive, utc
from app.domains.runs.analysis_workflows.runtime import owned_source, policy
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.types import JobStatus

TABLES = (SpendAccount.__table__, SpendAttempt.__table__, ZerodhaPortfolioSnapshot.__table__)
CATALOGUE = frozenset({'US:UATA', 'US:UATB', 'NSE:SYNTHETIC0'})
FACTS = ModuleFacts(jurisdiction='allowed', plan='allowed', connection='not_required')


def source(db, owner, portfolio, snapshot_id=None):
    """Actual accepted/imported bytes and current version, never a fixed source."""
    result = owned_source(db, owner, portfolio, snapshot_id)
    if portfolio == 'india':
        receipt = result['acquisition']
        if receipt.get('simulation') is not True or not result['connection']['account'].startswith('FAKE'):
            raise WorkflowDenied('Explicit synthetic acquisition required')
    module = 'indmoney_us' if portfolio == 'indmoney_us' else 'zerodha_rebalance'
    facts = projection(result, owner=owner, module=module)
    if not facts['holdings'] or not set(facts['holdings']) <= CATALOGUE:
        raise WorkflowDenied('Only the documented synthetic preview instruments are allowed')
    return result


def synthetic_acquire(db, owner, *, now=None):
    """Create new fake source evidence, never bless a legacy/manual snapshot.

    No provider/token/credential is read. Repeated setup returns only an already
    matching fake acquisition; reconnect/version changes fail closed. A fresh
    disposable store is required for another same-day acquisition scenario.
    """
    now = utc(now or datetime.now(timezone.utc))
    connection = db.scalar(select(IntegrationConnection).where(
        IntegrationConnection.owner_id == owner, IntegrationConnection.provider == 'zerodha',
        IntegrationConnection.is_current.is_(True)).execution_options(populate_existing=True))
    if (connection is None or connection.status != 'active' or not connection.token_expires_at
            or utc(connection.token_expires_at) <= now
            or not (connection.provider_account_id or '').startswith('FAKE')):
        raise WorkflowDenied('Current synthetic connection required')
    existing = db.scalar(select(ZerodhaPortfolioSnapshot).where(
        ZerodhaPortfolioSnapshot.user_id == owner, ZerodhaPortfolioSnapshot.snapshot_date == now.date()))
    if existing is not None:
        if not isinstance(existing.acquisition_json, dict) or existing.acquisition_json.get('simulation') is not True:
            raise WorkflowDenied('Existing snapshot cannot be relabelled as synthetic acquisition')
        validate_acquisition(existing, connection, owner, now=now)
        return existing
    snapshot = ZerodhaPortfolioSnapshot(
        user_id=owner, snapshot_date=now.date(), captured_at=now, source='connection_sync',
        holdings_count=1, holdings_market_value=30.03, holdings_invested_value=30.03,
        holdings=[{'exchange': 'NSE', 'tradingsymbol': 'SYNTHETIC0', 'quantity': 3,
                   'last_price': '10.01', 'currency': 'INR'}], net_positions=[], day_positions=[])
    db.add(snapshot)
    db.flush()
    snapshot.acquisition_json = {
        'schema_version': 1, 'kind': 'connection_acquisition_v1', 'simulation': True,
        'owner_id': owner, 'snapshot_id': snapshot.id, 'connection_id': connection.id,
        'connection_version': connection.version, 'provider': 'zerodha',
        'provider_account_id': connection.provider_account_id, 'app_mode': connection.app_ownership_mode,
        'captured_at': utc(snapshot.captured_at).isoformat(), 'content_hash': digest(acquisition_payload(snapshot))}
    db.flush()
    return snapshot


def recommendation_source(db, row, job, now):
    facts = frozen_projection(row)
    return {**facts, 'content_hash': row.execution_json['source_hash'], 'provenance': {
        'provider': job.provider, 'model': job.model, 'prompt_hash': digest(job.prompt),
        'input_hash': row.execution_json['source_hash'],
        'prompt_version': job.request_context_json['prompt_version']}}


def fake_provider(facts):
    recommendations = []
    for instrument, units in facts['holdings'].items():
        # A deterministic advisory change for the documented India fixture lets
        # the separate exact-approval scenario derive its basket from real output.
        trim = instrument == 'NSE:SYNTHETIC0' and Decimal(units) == 3
        final = '1' if trim else units
        recommendations.append({'instrument': instrument, 'action': 'trim' if trim else 'hold',
            'current_units': units, 'final_units': final,
            'allocation': '.1' if Decimal(final) else '0'})
    return FakeProvider({'schema_version': 1, 'currency': facts['currency'],
                         'recommendations': recommendations, 'provenance': deepcopy(facts['provenance'])})


governance = SyntheticGovernance(
    # Actual snapshot and dependency bytes are larger than the old fixed source.
    # Every call still reserves/settles and enforces finite input/output bounds.
    Limits(version='synthetic-linked-preview-v1', max_input_tokens=32768),
    recommendation_source, lambda db, row, job: set(CATALOGUE), fake_provider)


def plan(portfolio):
    return {'version': 'synthetic-linked-plan-1', 'guardrails_version': 'stage13-v1',
            'stages': {stage: {'provider': 'fake', 'model': 'offline', 'prompt_version': 'synthetic-1',
                              'template': 'Synthetic advisory analysis only. No tools or order authorization.'}
                       for stage in STAGES[1:]}}


runtime = Runtime(
    lambda db, owner, portfolio, **kw: policy(db, owner, portfolio, facts=FACTS, **kw),
    source, plan, QueuedAI(governance),
    lambda portfolio, due, now: {'timezone': 'Asia/Kolkata', 'calendar_version': 'synthetic-all-open-1',
                                'market_open': True, 'max_lateness_seconds': 60, 'missed_policy': 'skip'},
    governance)


def publish_governed_job(db, job_id, dispatch_id, *, now=None):
    """Fake worker entry for the existing job outbox, not direct route execution."""
    now = utc(now or datetime.now(timezone.utc))
    job = db.get(Job, job_id, populate_existing=True)
    message = db.get(OutboxMessage, UUID(str(dispatch_id)), populate_existing=True)
    if (job is None or message is None or message.topic != 'job.created.v2'
            or message.payload != {'job_id': job.id, 'user_id': job.user_id}):
        raise WorkflowDenied('Owned job dispatch binding required')
    if job.status in JobStatus.terminal():
        return {'status': 'terminal', 'job_id': job.id}
    try:
        result = execute_governed_job(db, job.id, runtime, now=now)
    except (BoundaryDenied, PermissionError):
        # Preserve spend evidence on uncertain/invalid results and stop, never
        # fall back to the ungoverned fake or any live provider.
        db.rollback()
        job = db.get(Job, job_id, populate_existing=True)
        job.status = JobStatus.FAILED
        job.error_message = 'Governed synthetic analysis denied; inspect owned workflow receipt'
        result = {'status': 'denied', 'job_id': job_id}
    message = db.get(OutboxMessage, UUID(str(dispatch_id)), populate_existing=True)
    if result['status'] == 'waiting_for_admission':
        message.available_at = naive(now + timedelta(seconds=5))
        message.published_at = None
    else:
        if job.status in JobStatus.active():
            job.status = JobStatus.PARTIAL
            job.error_message = 'Governed synthetic analysis requires explicit review'
        message.execution_attempts += 1
        message.available_at = None
    db.flush()
    return result


def completed_analysis(db, owner, workflow_id, *, now=None):
    """Verified advisory receipt for separate fake basket preparation, not approval."""
    now = utc(now or datetime.now(timezone.utc))
    service = Workflows(db, runtime)
    row = service.owned(owner, workflow_id)
    service.validate_current(row)
    stages = service.stages(row)
    if row.status != 'completed' or any(stage.status != 'completed' for stage in stages):
        raise WorkflowDenied('Completed governed analysis required')
    for stage in stages:
        checkpoint = stage.checkpoint_json
        if digest(checkpoint.get('result')) != checkpoint.get('result_hash'):
            raise WorkflowDenied('Persisted analysis result integrity failed')
        if stage.stage == 'sync':
            continue
        job = db.get(Job, stage.job_id, populate_existing=True)
        validate_job_request(row, stage, job, dependency_results(stages, stage))
        if job.status != JobStatus.COMPLETED or job.module_cancel_requested:
            raise WorkflowDenied('Completed uncancelled governed job required')
        validate_completed_job(db, row, job, governance, now)
        if checkpoint['result']['data'] != {
                'job_id': job.id, 'response': job.response, 'tokens_in': job.tokens_in, 'tokens_out': job.tokens_out}:
            raise WorkflowDenied('Persisted checkpoint differs from governed job')
    actionables = stages[-1].checkpoint_json['result']
    return {'workflow_id': row.id, 'owner_id': owner, 'module_id': row.module_id,
            'module_version': row.module_version, 'source_hash': row.execution_json['source_hash'],
            'plan_hash': row.execution_json['plan_hash'], 'source': deepcopy(row.execution_json['source']),
            'actionables_result_hash': stages[-1].checkpoint_json['result_hash'],
            'recommendations': json.loads(actionables['data']['response'])['recommendations'],
            'orders_authorized': False, 'simulation': True}


def allowed(method, path):
    return (method == 'GET' and re.fullmatch(r'/runs/analysis-workflows(?:/config|/[1-9][0-9]*)?', path) is not None
            or method == 'POST' and re.fullmatch(r'/runs/analysis-workflows(?:/[1-9][0-9]*/controls)?', path) is not None)


def install(app):
    app.dependency_overrides[optional_analysis_runtime] = lambda: runtime
    app.include_router(router)


def advance(session, *, now=None):
    now = utc(now or datetime.now(timezone.utc))
    row = session.scalar(select(OutboxMessage).where(
        OutboxMessage.topic == TOPIC, OutboxMessage.execution_attempts == 0,
        OutboxMessage.available_at <= naive(now)).order_by(OutboxMessage.created_at, OutboxMessage.id).limit(1))
    return Workflows(session, runtime).consume(row.id, now=now) if row else None


async def tick(db):
    await db.run_sync(advance)
    await db.commit()
