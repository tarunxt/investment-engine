"""Caller-owned fake analysis worker and bounded relay/scheduler composition.

Uses existing PostgreSQL work/outbox state and the existing UAT2 Redis queue.
Nothing imports production tasks or registers a global runtime. Registration is
explicit; the hosted app must install the same scoped policy on HTTP sessions.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
from uuid import UUID
from sqlalchemy import select, and_
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied, naive
from app.domains.runs.analysis_workflows.runtime import policy
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
from app.domains.runs.analysis_workflows.synthetic_composition import SyntheticAnalysis
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.analysis_workflows.dispatch import dispatch
from app.infrastructure.database.outbox.job_dispatch import dispatch_jobs_due
from app.infrastructure.database.outbox.models import OutboxMessage
from .policy_bindings import SESSION, install_session_binding

QUEUE = 'uat2_simulation'
STAGE = 'uat2.analysis.stage.v1'
JOB = 'uat2.analysis.job.v1'
RELAY = 'uat2.analysis.relay.v1'


class SimulationAnalysisWorker:
    def __init__(self, session_factory, *, scope, clock=None):
        if not callable(session_factory) or type(scope) is not SimulationSourceScope:
            raise WorkflowDenied('Explicit scoped simulation worker binding required')
        self.factory, self.scope = session_factory, scope
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.analysis = SyntheticAnalysis(scope=scope, policy=policy)
        self.app, self.tasks = None, {}

    @contextmanager
    def session(self):
        with self.factory() as db:
            install_session_binding(db, self.scope)
            try: yield db
            except BaseException:
                db.rollback(); raise
            finally: db.info.pop(SESSION, None)

    def stage(self, message_id):
        try: message_id = UUID(str(message_id))
        except (ValueError, TypeError): raise WorkflowDenied('Persisted stage dispatch required') from None
        with self.session() as db:
            message = db.get(OutboxMessage, message_id)
            if message is None: return 'invalid_delivery'
            self.scope.validate(db, message.payload.get('owner_id'))
            result = Workflows(db, self.analysis.runtime).consume(message_id, now=self.clock())
            db.commit()
            return result

    def job(self, job_id, dispatch_id):
        if type(job_id) is not int or job_id < 1:
            raise WorkflowDenied('Persisted governed job required')
        with self.session() as db:
            row = db.get(Job, job_id)
            if row is None: raise WorkflowDenied('Persisted governed job required')
            self.scope.validate(db, row.user_id)
            result = self.analysis.publish_governed_job(db, job_id, dispatch_id, now=self.clock())
            db.commit()
            return result

    def relay(self):
        if self.app is None: raise WorkflowDenied('Explicit simulation task app required')
        self.check_transport(self.app)
        with self.session() as db:
            from app.core.uat2 import OWNER_EMAIL
            emails = {OWNER_EMAIL} if self.scope.mode == 'hosted' else {
                'usera@stage01.example.com', 'userb@stage01.example.com'}
            owners = list(db.scalars(select(User.id).where(User.email.in_(emails),
                User.is_active.is_(True), User.is_verified.is_(True)).limit(3)))
            for owner in owners: self.scope.validate(db, owner)
            workflow = dispatch(db, lambda message: self.tasks[STAGE].apply_async(
                args=[message], queue=QUEUE, retry=False), self.analysis.runtime, limit=2, now=self.clock(),
                message_predicate=OutboxMessage.payload['owner_id'].as_integer().in_(owners))
            jobs = dispatch_jobs_due(db, lambda job, message: self.tasks[JOB].apply_async(
                args=[job, message], queue=QUEUE, retry=False), limit=2, now=naive(self.clock()),
                job_predicate=and_(Job.user_id.in_(owners),
                    Job.request_context_json['kind'].as_string() == 'durable_analysis_v1'))
            db.commit()
            return {'simulation': True, 'workflows': workflow, 'jobs': jobs}

    def check_transport(self, app):
        if self.scope.mode == 'hosted':
            from app.core.uat2 import uat2_mode, validate_uat2_startup
            from app.core.config import settings
            if not uat2_mode(): raise WorkflowDenied('Dedicated UAT2 worker required')
            try: validate_uat2_startup()
            except RuntimeError: raise WorkflowDenied('Dedicated UAT2 worker required') from None
            if app.conf.broker_url != settings.redis_url or app.conf.result_backend != settings.redis_url:
                raise WorkflowDenied('Dedicated UAT2 Redis transport required')
            if (app.conf.task_always_eager or app.conf.worker_prefetch_multiplier != 1
                    or type(app.conf.result_expires) is not int or not 0 < app.conf.result_expires <= 3600):
                raise WorkflowDenied('Bounded dedicated UAT2 worker settings required')
        elif self.scope.mode == 'preview':
            import os
            if (os.getenv('ENVIRONMENT') != 'test' or os.getenv('STAGE01_PREVIEW') != 'synthetic-only'
                    or app.conf.broker_url != 'memory://' or app.conf.result_backend not in {None, 'cache+memory://'}):
                raise WorkflowDenied('Disposable in-memory test transport required')
        else: raise WorkflowDenied('Known simulation worker scope required')
        if app.conf.task_serializer != 'json' or app.conf.result_serializer != 'json':
            raise WorkflowDenied('JSON-only simulation task transport required')
        if set(app.conf.accept_content or ()) != {'json'}:
            raise WorkflowDenied('JSON-only simulation task transport required')

    def register(self, app):
        self.check_transport(app)
        if self.app is not None and self.app is not app:
            raise WorkflowDenied('Single simulation worker app required')
        if any(name in app.tasks and self.tasks.get(name) is not app.tasks[name] for name in (STAGE, JOB, RELAY)):
            raise WorkflowDenied('Simulation task name collision')
        routes = app.conf.task_routes or {}
        if type(routes) is not dict: raise WorkflowDenied('Explicit simulation route map required')
        if not self.tasks:
            options = dict(shared=False, queue=QUEUE, acks_late=True, reject_on_worker_lost=True,
                max_retries=0, autoretry_for=(), soft_time_limit=10, time_limit=15)
            @app.task(name='uat2.analysis.stage.v1', **options)
            def consume_stage(message_id):
                return self.stage(message_id)
            @app.task(name='uat2.analysis.job.v1', **options)
            def consume_job(job_id, dispatch_id):
                return self.job(job_id, dispatch_id)
            @app.task(name='uat2.analysis.relay.v1', **options)
            def relay_analysis():
                return self.relay()
            self.tasks = {STAGE: consume_stage, JOB: consume_job, RELAY: relay_analysis}
        app.conf.task_routes = {**routes, **{name: {'queue': QUEUE} for name in self.tasks}}
        self.app = app
        return dict(self.tasks)

    def schedule(self, app):
        self.register(app)
        schedule = dict(app.conf.beat_schedule or {})
        value = {'task': 'uat2.analysis.relay.v1', 'schedule': 5.0, 'options': {'queue': QUEUE, 'expires': 5}}
        key = 'uat2-scoped-analysis-relay'
        if key in schedule and schedule[key] != value:
            raise WorkflowDenied('Simulation relay schedule collision')
        schedule[key] = value
        app.conf.beat_schedule = schedule
        return value
