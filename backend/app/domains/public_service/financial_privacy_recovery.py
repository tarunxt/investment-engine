"""Exact disposable confirmed-order recovery with persisted owner stop fences.

Restores evidence for read-only reconciliation, never trading authority. No
runtime binding, connection credential restoration or real deletion is provided.
"""
from datetime import datetime,timezone
from sqlalchemy import select, update, exists
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from app.domains.connections.models import IntegrationConnection
from app.domains.ai_limits.contracts import BoundaryDenied,utc
from app.domains.order_intents.models import OrderIntent,OrderLeg
from app.domains.order_intents.execution_models import ExecutionRun,ExecutionAttempt,ExecutionFence
from .quarantined_privacy import QuarantinedFixturePrivacy,CONTRACTS
from .canonical_privacy_resolvers import _fence_keys

FINANCIAL={model.__tablename__:model.__table__ for model in
    (OrderIntent,OrderLeg,ExecutionRun,ExecutionAttempt)}
REFERENCE='synthetic:stopped-financial-recovery-v1'


class StoppedFinancialFixturePrivacy(QuarantinedFixturePrivacy):
    reference=REFERENCE
    contracts={**CONTRACTS,**FINANCIAL,'order_execution_fences':ExecutionFence.__table__,
        'integration_connections':IntegrationConnection.__table__}

    def _restorable(self,name):
        if name in {'order_execution_fences','integration_connections'}:
            # Shared platform/other-owner controls are never deleted/restored.
            return False
        if name in FINANCIAL:
            if self.scope.reference!=self.reference:
                raise BoundaryDenied('EXPLICIT_STOPPED_FINANCIAL_SCOPE_REQUIRED')
            for related in FINANCIAL:self._contract(related)
            for required in ('user_modules','user_module_preferences','order_execution_fences','integration_connections'):
                self._contract(required)
        return super()._restorable(name)

    def _integrity(self,owner):
        intents=self._contract('confirmed_order_intents');connections=self._contract('integration_connections')
        legs=self._contract('confirmed_order_legs');attempts=self._contract('order_execution_attempts')
        matching=exists(select(1).select_from(connections).where(connections.c.id==intents.c.connection_id,
            connections.c.owner_id==owner)).correlate(intents)
        if self.db.scalar(select(1).select_from(intents).where(intents.c.owner_id==owner,~matching).limit(1)) is not None:
            raise BoundaryDenied('FINANCIAL_RECOVERY_RELATIONSHIP_HELD')
        matching_leg=exists(select(1).select_from(legs).where(legs.c.id==attempts.c.leg_id,
            legs.c.intent_id==attempts.c.intent_id)).correlate(attempts)
        if self.db.scalar(select(1).select_from(attempts).where(attempts.c.intent_id.in_(
                select(intents.c.id).where(intents.c.owner_id==owner)),~matching_leg).limit(1)) is not None:
            raise BoundaryDenied('FINANCIAL_RECOVERY_RELATIONSHIP_HELD')

    def execute(self,owner,request_id,*,now=None):
        now=utc(now or datetime.now(timezone.utc))
        self._fence(owner,request_id,now)
        self.reader.validate()
        self._integrity(owner)
        return super().execute(owner,request_id,now=now)

    def _after_restore(self,owner,counts,now):
        self._integrity(owner)
        controls=super()._after_restore(owner,counts,now)
        if not any(counts.get(name,0) for name in FINANCIAL):return controls
        intents=self._contract('confirmed_order_intents')
        fences=self._contract('order_execution_fences')
        rows=self.db.execute(select(intents.c.connection_id,intents.c.account_id)
            .where(intents.c.owner_id==owner).limit(1001)).all()
        if len(rows)>1000:raise BoundaryDenied('FINANCIAL_RECOVERY_LIMIT')
        keys=_fence_keys(owner,sorted({row[0] for row in rows}),sorted({row[1] for row in rows}))
        insert={'sqlite':sqlite_insert,'postgresql':pg_insert}.get(self.db.get_bind().dialect.name)
        if insert is None:raise BoundaryDenied('FINANCIAL_RECOVERY_DATABASE_REQUIRED')
        for key in sorted(keys):
            self.db.execute(insert(fences).values(key=key,stopped=True)
                .on_conflict_do_update(index_elements=['key'],set_={'stopped':True}))
        # Frozen in-flight approvals/attempts/receipts remain byte-for-byte for
        # reconciliation. Never erase evidence or pretend a venue order rejected.
        self.db.execute(update(intents).where(intents.c.owner_id==owner,
            intents.c.state.in_(['draft','validated','awaiting_approval','approved']))
            .values(state='invalidated'))
        return {**controls,'financial_authority_restored':False,
            'financial_recovery':'stopped_read_only_reconciliation',
            'owner_stop_persisted':True,'stop_count':len(keys),
            'inflight_receipts_preserved':True,'reservations_restored':False}
