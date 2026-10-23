"""Scoped fake-only governed analysis composition over existing durable services.

No route, provider, worker or scheduler is registered. Both callers supply the
canonical policy and an explicit source scope. This keeps hosted composition
independent of the disposable preview while preserving its frozen receipts.
"""
import json
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID
from sqlalchemy import select
from app.domains.ai_limits.contracts import BoundaryDenied, Limits
from app.domains.ai_limits.jobs import SyntheticGovernance, execute_governed_job, validate_completed_job
from app.domains.ai_limits.projection import frozen_projection, projection
from app.domains.ai_limits.runner import FakeProvider
from app.domains.jobs.models import Job
from app.domains.connections.models import IntegrationConnection
from app.domains.modules.lifecycle import WorkIdentity
from app.domains.runs.analysis_workflows.adapters import QueuedAI
from app.domains.runs.analysis_workflows.bindings import dependency_results, validate_job_request
from app.domains.runs.analysis_workflows.contracts import Runtime, STAGES, TOPIC, WorkflowDenied, digest, naive, utc
from app.domains.runs.analysis_workflows.runtime import owned_source
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.types import JobStatus

CATALOGUE = frozenset({'US:UATA', 'US:UATB', 'NSE:SYNTHETIC0'})


class SyntheticAnalysis:
    def __init__(self, *, scope, policy):
        if type(scope) is not SimulationSourceScope or not callable(policy):
            raise WorkflowDenied('Explicit synthetic source scope and canonical policy required')
        self.scope, self.policy = scope, policy
        self.governance = SyntheticGovernance(
            Limits(version='synthetic-linked-preview-v1', max_input_tokens=32768),
            self.recommendation_source, lambda db, row, job: set(CATALOGUE), self.fake_provider)
        self.runtime = Runtime(self.authorize, self.source, self.plan, QueuedAI(self.governance),
            lambda portfolio, due, now: {'timezone': 'Asia/Kolkata', 'calendar_version': 'synthetic-all-open-1',
                'market_open': True, 'max_lateness_seconds': 60, 'missed_policy': 'skip'}, self.governance)

    def authorize(self, db, owner, portfolio, **kwargs):
        self.scope.validate(db, owner)
        identity = self.policy(db, owner, portfolio, **kwargs)
        expected = {'india': 'zerodha_rebalance', 'indmoney_us': 'indmoney_us'}.get(portfolio)
        if (type(identity) is not WorkIdentity or identity.owner_id != owner
            or identity.module_id != expected or type(identity.version) is not int or identity.version < 1):
            raise WorkflowDenied('Current canonical module identity required')
        return identity

    def source(self, db, owner, portfolio, snapshot_id=None):
        """Actual accepted/imported bytes and current version, never a fixed source."""
        self.scope.validate(db, owner)
        result = owned_source(db, owner, portfolio, snapshot_id)
        if portfolio == 'india':
            receipt = result['acquisition']
            connection = db.get(IntegrationConnection, result['connection']['id'], populate_existing=True)
            if (connection is None or not self.scope.credentials_allowed(db, connection)
                    or receipt.get('simulation') is not True or not result['connection']['account'].startswith('FAKE')):
                raise WorkflowDenied('Explicit synthetic acquisition required')
        module = 'indmoney_us' if portfolio == 'indmoney_us' else 'zerodha_rebalance'
        facts = projection(result, owner=owner, module=module)
        if not facts['holdings'] or not set(facts['holdings']) <= CATALOGUE:
            raise WorkflowDenied('Only the documented synthetic instruments are allowed')
        return result

    def recommendation_source(self, db, row, job, now):
        facts = frozen_projection(row)
        return {**facts, 'content_hash': row.execution_json['source_hash'], 'provenance': {
            'provider': job.provider, 'model': job.model, 'prompt_hash': digest(job.prompt),
            'input_hash': row.execution_json['source_hash'],
            'prompt_version': job.request_context_json['prompt_version']}}

    def fake_provider(self, facts):
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

    def plan(self, portfolio):
        return {'version': 'synthetic-linked-plan-1', 'guardrails_version': 'stage13-v1',
                'stages': {stage: {'provider': 'fake', 'model': 'offline', 'prompt_version': 'synthetic-1',
                                  'template': 'Synthetic advisory analysis only. No tools or order authorization.'}
                           for stage in STAGES[1:]}}

    def publish_governed_job(self, db, job_id, dispatch_id, *, now=None):
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
            result = execute_governed_job(db, job.id, self.runtime, now=now)
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

    def completed_analysis(self, db, owner, workflow_id, *, now=None):
        """Verified advisory receipt for separate fake basket preparation, not approval."""
        now = utc(now or datetime.now(timezone.utc))
        service = Workflows(db, self.runtime)
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
            validate_completed_job(db, row, job, self.governance, now)
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

    def advance(self, session, *, now=None):
        now = utc(now or datetime.now(timezone.utc))
        row = session.scalar(select(OutboxMessage).where(
            OutboxMessage.topic == TOPIC, OutboxMessage.execution_attempts == 0,
            OutboxMessage.available_at <= naive(now)).order_by(OutboxMessage.created_at, OutboxMessage.id).limit(1))
        return Workflows(session, self.runtime).consume(row.id, now=now) if row else None
