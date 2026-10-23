"""Bounded persisted fake-order tasks; no approval or submission replay path."""
from datetime import timedelta
from pathlib import Path
from uuid import UUID
from sqlalchemy import select,func,or_
from app.domains.auth.models import User
from app.domains.runs.models import AutoRebalanceWorkflow
from app.domains.order_intents.contracts import OrderDenied
from app.domains.order_intents.service import TOPIC, orders_for_runtime
from app.domains.order_intents.models import OrderIntent
from app.domains.order_intents.execution_models import ExecutionRun, ExecutionAttempt
from app.domains.order_intents.execution import ExecutionWorker, venue_binding
from app.domains.order_intents.journal_fake import JournalBrokerFake
from app.domains.runs.analysis_workflows.contracts import naive, WorkflowDenied
from app.infrastructure.database.outbox.models import OutboxMessage
from .analysis_worker import SimulationAnalysisWorker, QUEUE, CONTROL_QUEUE
from .synthetic_orders import SyntheticOrders, TOPIC as PREPARATION_TOPIC

EXECUTION_QUEUE = 'uat2_orders'
RECONCILIATION_QUEUE = 'uat2_reconcile'

PREPARE = 'uat2.orders.prepare.v1'
DISPATCH = 'uat2.orders.dispatch.v1'
RECONCILE = 'uat2.orders.reconcile.v1'
RELAY = 'uat2.orders.relay.v1'


class SimulationOrderWorker:
    def __init__(self, analysis_worker, venue_engine):
        if type(analysis_worker) is not SimulationAnalysisWorker:
            raise WorkflowDenied('Exact scoped analysis worker required')
        self.analysis_worker, self.venue_engine = analysis_worker, venue_engine
        self.orders = SyntheticOrders(analysis_worker.analysis)
        self.tasks, self.app = {}, None
        with analysis_worker.session() as db:
            url = db.get_bind().url
            if db.get_bind() is venue_engine: raise OrderDenied('SEPARATE_VENUE_TRANSACTION_ENGINE_REQUIRED')
            if analysis_worker.scope.mode == 'hosted':
                if url != venue_engine.url or venue_engine.dialect.name != 'postgresql':
                    raise OrderDenied('SAME_DEDICATED_POSTGRESQL_JOURNAL_REQUIRED')
            elif (venue_engine.dialect.name != 'sqlite' or not url.database or not venue_engine.url.database
                    or Path(url.database).resolve().parent != Path(venue_engine.url.database).resolve().parent):
                raise OrderDenied('SAME_DISPOSABLE_FIXTURE_DIRECTORY_REQUIRED')

    def runner(self, db, row, *, outcomes=()):
        now = self.analysis_worker.clock()
        broker = JournalBrokerFake(self.venue_engine, venue_binding(row), outcomes)
        return ExecutionWorker(orders_for_runtime(db, self.orders, clock=lambda: now), broker, self.orders.market(db, row, now))

    def prepare(self, workflow_id):
        if type(workflow_id) is not int or workflow_id < 1: raise OrderDenied('PERSISTED_WORKFLOW_REQUIRED')
        with self.analysis_worker.session() as db:
            flow = db.get(AutoRebalanceWorkflow, workflow_id)
            if flow is None: raise OrderDenied('PERSISTED_WORKFLOW_REQUIRED')
            self.analysis_worker.scope.validate(db, flow.user_id)
            row = self.orders.prepare(db, flow.user_id, workflow_id, now=self.analysis_worker.clock())
            result = {'id': row.id, 'state': row.state, 'simulation_only': True}
            db.commit(); return result

    def dispatch(self, outbox_id):
        try: identifier = UUID(str(outbox_id))
        except (ValueError, TypeError): raise OrderDenied('PERSISTED_APPROVAL_EVENT_REQUIRED') from None
        with self.analysis_worker.session() as db:
            event = db.get(OutboxMessage, identifier)
            if event is None or event.topic != TOPIC: raise OrderDenied('PERSISTED_APPROVAL_EVENT_REQUIRED')
            owner = event.payload.get('owner_id')
            self.analysis_worker.scope.validate(db, owner)
            row = db.get(OrderIntent, event.payload.get('intent_id'))
            if row is None or row.owner_id != owner: raise OrderDenied('OWNED_APPROVAL_EVENT_REQUIRED')
            runner = self.runner(db, row, outcomes=[self.orders.scenario])
            try: result = runner.dispatch(identifier)
            except TimeoutError:
                # The durable state machine has committed uncertainty. Neither
                # task retry nor a lost HTTP result can authorize resubmission.
                result = db.get(OrderIntent, row.id, populate_existing=True)
            return {'id': result.id, 'state': result.state, 'simulation_only': True}

    def reconcile(self, intent_id):
        with self.analysis_worker.session() as db:
            row = db.get(OrderIntent, intent_id)
            if row is None: raise OrderDenied('OWNED_EXECUTION_REQUIRED')
            self.analysis_worker.scope.validate(db, row.owner_id)
            self.orders.provenance(db, row, self.analysis_worker.clock(), current=False)
            result = self.runner(db, row).reconcile(row.owner_id, row.id)
            return {'id': result.id, 'state': result.state, 'simulation_only': True}

    def relay(self):
        if self.app is None: raise OrderDenied('EXPLICIT_ORDER_TASK_APP_REQUIRED')
        self.analysis_worker.check_transport(self.app)
        with self.analysis_worker.session() as db:
            from app.core.uat2 import OWNER_EMAIL
            emails = {OWNER_EMAIL} if self.analysis_worker.scope.mode == 'hosted' else {
                'usera@stage01.example.com', 'userb@stage01.example.com'}
            owners = list(db.scalars(select(User.id).where(User.email.in_(emails), User.is_active.is_(True),
                User.is_verified.is_(True)).limit(3)))
            for owner in owners: self.analysis_worker.scope.validate(db, owner)
            now = self.analysis_worker.clock()
            prepared = select(OutboxMessage.id).where(OutboxMessage.topic == PREPARATION_TOPIC,
                OutboxMessage.payload['provenance']['workflow_id'].as_integer() == AutoRebalanceWorkflow.id).exists()
            flows = list(db.scalars(select(AutoRebalanceWorkflow.id).where(
                AutoRebalanceWorkflow.user_id.in_(owners), AutoRebalanceWorkflow.orchestration_kind == 'analysis_v1',
                AutoRebalanceWorkflow.portfolio == 'india', AutoRebalanceWorkflow.status == 'completed', ~prepared)
                .order_by(AutoRebalanceWorkflow.id).limit(2)))
            events = list(db.scalars(select(OutboxMessage).join(OrderIntent,
                OutboxMessage.payload['intent_id'].as_string() == OrderIntent.id).where(
                OutboxMessage.topic == TOPIC, OrderIntent.owner_id.in_(owners), OrderIntent.state == 'approved',
                OrderIntent.expires_at > now, OutboxMessage.execution_attempts == 0,
                or_(OutboxMessage.available_at.is_(None), OutboxMessage.available_at <= naive(now))).order_by(OutboxMessage.created_at).limit(2)
                .with_for_update(skip_locked=True)))
            recovering = list(db.scalars(select(OrderIntent.id).join(ExecutionRun).join(ExecutionAttempt,
                ExecutionAttempt.intent_id == OrderIntent.id).where(OrderIntent.owner_id.in_(owners),
                OrderIntent.state.in_(['unknown', 'partial', 'submitting', 'acknowledged']),
                ExecutionAttempt.polls < 5, ExecutionAttempt.next_poll_at <= now,
                ExecutionAttempt.claimed_at >= now - timedelta(minutes=10))
                .group_by(OrderIntent.id).order_by(func.min(ExecutionAttempt.next_poll_at)).limit(2)))
            for flow in flows: self.tasks[PREPARE].apply_async(args=[flow], queue=QUEUE, retry=False)
            for event in events:
                self.tasks[DISPATCH].apply_async(args=[str(event.id)], queue=EXECUTION_QUEUE, retry=False)
                event.published_at = naive(now)
                event.available_at = naive(now + timedelta(seconds=30))
            for intent in recovering: self.tasks[RECONCILE].apply_async(args=[intent], queue=RECONCILIATION_QUEUE, retry=False)
            db.commit()
            return {'simulation_only': True, 'prepare': len(flows), 'dispatch': len(events), 'reconcile': len(recovering)}

    def register(self, app):
        self.analysis_worker.check_transport(app)
        if self.app is not None and self.app is not app: raise OrderDenied('ORDER_TASK_APP_ALREADY_BOUND')
        if self.tasks: return dict(self.tasks)
        if any(name in app.tasks for name in (PREPARE, DISPATCH, RECONCILE, RELAY)):
            raise OrderDenied('ORDER_TASK_NAME_COLLISION')
        options = dict(shared=False, queue=QUEUE, acks_late=True, reject_on_worker_lost=True,
            max_retries=0, autoretry_for=(), soft_time_limit=10, time_limit=15)
        @app.task(name='uat2.orders.prepare.v1', **options)
        def prepare_order(workflow_id): return self.prepare(workflow_id)
        @app.task(name='uat2.orders.dispatch.v1', **{**options,'queue':EXECUTION_QUEUE})
        def dispatch_order(message_id): return self.dispatch(message_id)
        @app.task(name='uat2.orders.reconcile.v1', **{**options,'queue':RECONCILIATION_QUEUE})
        def reconcile_order(intent_id): return self.reconcile(intent_id)
        @app.task(name='uat2.orders.relay.v1', **{**options,'queue':CONTROL_QUEUE})
        def relay_orders(): return self.relay()
        self.tasks = {PREPARE: prepare_order, DISPATCH: dispatch_order, RECONCILE: reconcile_order, RELAY: relay_orders}
        queues={PREPARE:QUEUE,DISPATCH:EXECUTION_QUEUE,RECONCILE:RECONCILIATION_QUEUE,RELAY:CONTROL_QUEUE}
        app.conf.task_routes = {**(app.conf.task_routes or {}), **{name: {'queue': queue} for name,queue in queues.items()}}
        self.app = app
        return dict(self.tasks)

    def schedule(self, app):
        self.register(app)
        value = {'task': 'uat2.orders.relay.v1', 'schedule': 5.0, 'options': {'queue': CONTROL_QUEUE, 'expires': 5}}
        previous = dict(app.conf.beat_schedule or {})
        key = 'uat2-scoped-orders-relay'
        if key in previous and previous[key] != value: raise OrderDenied('ORDER_SCHEDULE_COLLISION')
        app.conf.beat_schedule = {**previous, key: value}
        return value
