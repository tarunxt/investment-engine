"""Explicit server factories and disabled/synthetic consumer composition.

Nothing registers itself with the application, Celery or Beat. Real policy,
inventory, retention, adapter and operator decisions remain unconfigured.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from app.domains.ai_limits.contracts import BoundaryDenied, utc
from app.domains.connections.crypto import ConnectionKeyring
from app.domains.modules.policy import ModuleFacts
from .reviewed_residency import ReviewedResidencyProducer, ResidencyReviewPolicy
from .sql_account import SQLAccountReader, AccountInventory
from .sql_privacy_plan import SQLPrivacyPlanner, RetentionSchedule
from .dispatch import OperationalQueues, SyntheticWorkBindings
from .operations import POLICIES


@dataclass(frozen=True)
class ServerBindings:
    residency_policy: ResidencyReviewPolicy | None = None
    account_inventory: AccountInventory | None = None
    retention_schedule: RetentionSchedule | None = None


class PublicServiceServer:
    def __init__(self, *, bindings=None, keyring=None):
        if bindings is not None and type(bindings) is not ServerBindings:
            raise BoundaryDenied('SERVER_BINDINGS_REQUIRED')
        self.bindings = bindings or ServerBindings()
        self.keyring = keyring

    def residency(self):
        if type(self.keyring) is not ConnectionKeyring or type(self.bindings.residency_policy) is not ResidencyReviewPolicy:
            raise BoundaryDenied('REVIEWED_RESIDENCY_BINDING_UNAVAILABLE')
        self.bindings.residency_policy.fingerprint()
        return ReviewedResidencyProducer(self.keyring, self.bindings.residency_policy)

    def onboarding(self, db, owner_id, *, now=None):
        try: proof = self.residency().resolve(db, owner_id, now=now)
        except BoundaryDenied:
            return {'owner_id': owner_id, 'eligible': False, 'status': 'review_required', 'runtime_binding': False}
        return {**proof, 'status': 'reviewed_evidence', 'runtime_binding': False}

    def module_facts(self, db, owner_id, facts, *, now=None):
        if type(facts) is not ModuleFacts: raise BoundaryDenied('SERVER_FACTS_REQUIRED')
        try: producer = self.residency()
        except BoundaryDenied: return facts.model_copy(update={'jurisdiction': 'unknown'})
        try: return producer.apply_to_facts(db, owner_id, facts, now=now)
        except BoundaryDenied: return facts.model_copy(update={'jurisdiction': 'denied'})

    def account_reader(self, db, metadata):
        if type(self.bindings.account_inventory) is not AccountInventory:
            raise BoundaryDenied('REVIEWED_ACCOUNT_INVENTORY_UNAVAILABLE')
        return SQLAccountReader(db, metadata, self.bindings.account_inventory).validate()

    def deletion_planner(self, db, metadata):
        if type(self.keyring) is not ConnectionKeyring or type(self.bindings.retention_schedule) is not RetentionSchedule:
            raise BoundaryDenied('REVIEWED_PRIVACY_BINDING_UNAVAILABLE')
        return SQLPrivacyPlanner(db, self.account_reader(db, metadata), self.keyring,
                                 self.bindings.retention_schedule)


class IsolatedConsumerComposition:
    """No real adapters. Explicit fake-only composition uses existing SQL fences.

    Unbound tasks return disabled without opening a session. Registration is
    explicit on a caller-owned app and never creates a periodic schedule.
    """
    def __init__(self, *, session_factory=None, bindings_factory=None, clock=None):
        if (session_factory is None) != (bindings_factory is None):
            raise BoundaryDenied('COMPLETE_CONSUMER_BINDING_REQUIRED')
        self.session_factory, self.bindings_factory = session_factory, bindings_factory
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.registrations = {}
        self.app = None

    def consume(self, lane):
        if lane not in POLICIES: raise BoundaryDenied('UNKNOWN_LANE')
        if self.session_factory is None:
            return {'state': 'disabled', 'lane': lane, 'synthetic_only': True}
        with self.session_factory() as db:
            try:
                bindings = self.bindings_factory(db)
                if type(bindings) is not SyntheticWorkBindings or bindings.db is not db:
                    raise BoundaryDenied('EXACT_SYNTHETIC_CONSUMER_BINDING_REQUIRED')
                result = OperationalQueues(db, bindings).work_once(lane, now=utc(self.clock()))
                return {'state': 'idle', 'lane': lane, 'synthetic_only': True} if result is None else result
            except BaseException:
                db.rollback()
                raise  # No Celery automatic retry or financial resubmission.

    def register(self, app):
        if self.app is not None and app is not self.app:
            raise BoundaryDenied('SINGLE_CONSUMER_APP_REQUIRED')
        routes = app.conf.task_routes or {}
        if not isinstance(routes, dict): raise BoundaryDenied('EXPLICIT_CONSUMER_ROUTE_MAP_REQUIRED')
        names = {lane: 'public_service.consume.' + lane for lane in POLICIES}
        if any(name in app.tasks and self.registrations.get(name) is not app.tasks[name] for name in names.values()):
            raise BoundaryDenied('CONSUMER_TASK_NAME_COLLISION')
        updated = dict(routes)
        def handler_for(kind):
            def handler(): return self.consume(kind)
            return handler
        for lane, name in names.items():
            policy = POLICIES[lane]
            if name not in self.registrations:
                task = app.task(name=name, shared=False, queue=policy.queue, acks_late=True,
                    reject_on_worker_lost=True, max_retries=0, autoretry_for=(),
                    soft_time_limit=policy.timeout_seconds, time_limit=policy.timeout_seconds + 5)(handler_for(lane))
                self.registrations[name] = task
            updated[name] = {'queue': policy.queue}
        app.conf.task_routes = updated
        self.app = app
        return {name: self.registrations[name] for name in names.values()}
