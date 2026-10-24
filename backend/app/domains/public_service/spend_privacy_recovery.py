"""Disposable spend recovery: preserve money, retire dispatch authority."""
from datetime import datetime,timezone
from sqlalchemy import select,update,exists,func
from app.domains.ai_limits.contracts import BoundaryDenied,utc
from app.domains.recommendation_audit.models import SpendAccount,SpendAttempt,VerificationRecord
from .quarantined_privacy import QuarantinedFixturePrivacy,CONTRACTS

LEDGER={model.__tablename__:model.__table__ for model in (SpendAccount,SpendAttempt,VerificationRecord)}
REFERENCE='synthetic:held-spend-recovery-v1'


class HeldSpendFixturePrivacy(QuarantinedFixturePrivacy):
    reference=REFERENCE
    contracts={**CONTRACTS,**LEDGER}

    def _restorable(self,name):
        if name in LEDGER:
            for related in LEDGER:self._contract(related)
            for control in ('user_modules','user_module_preferences'):self._contract(control)
        return super()._restorable(name)

    def _integrity(self,subject):
        accounts=self._contract('recommendation_spend_accounts')
        attempts=self._contract('recommendation_spend_attempts')
        owned=exists(select(1).select_from(accounts).where(accounts.c.id==attempts.c.account_id,
            accounts.c.user_id==subject)).correlate(attempts)
        if self.db.scalar(select(1).select_from(attempts).where(attempts.c.user_id==subject,~owned).limit(1)) is not None:
            raise BoundaryDenied('SPEND_RECOVERY_RELATIONSHIP_HELD')
        for table in (accounts,attempts):
            # Reject malformed amounts; never repair, refund or settle by guess.
            columns=('cap_usd','spent_usd','reserved_usd') if table is accounts else ('upper_bound_usd',)
            for name in columns:
                if self.db.scalar(select(1).select_from(table).where(table.c.user_id==subject,
                    (table.c[name]<0)|table.c[name].is_(None)).limit(1)) is not None:
                    raise BoundaryDenied('SPEND_RECOVERY_BALANCE_HELD')

    def execute(self,subject,request_id,*,now=None):
        now=utc(now or datetime.now(timezone.utc));self._fence(subject,request_id,now)
        if self.scope.reference!=self.reference:raise BoundaryDenied('EXPLICIT_HELD_SPEND_SCOPE_REQUIRED')
        self.reader.validate();self._integrity(subject)
        return super().execute(subject,request_id,now=now)

    def _after_restore(self,subject,counts,now):
        self._integrity(subject)
        controls=super()._after_restore(subject,counts,now)
        if not any(counts.get(name,0) for name in LEDGER):return controls
        attempts=self._contract('recommendation_spend_attempts')
        verification=self._contract('recommendation_verifications')
        self.db.execute(update(attempts).where(attempts.c.user_id==subject,attempts.c.status=='queued').values(status='cancelled'))
        self.db.execute(update(attempts).where(attempts.c.user_id==subject,
            attempts.c.status.in_(['started','uncertain','reserved'])).values(status='cancelled_uncertain'))
        self.db.execute(update(verification).where(verification.c.user_id==subject).values(
            dispatch_pending=False,lease_until=None,fence=verification.c.fence+1))
        self.db.execute(update(verification).where(verification.c.user_id==subject,
            verification.c.status.in_(['queued','processing'])).values(status='cancelled'))
        header=self._contract('user_module_preferences');modules=self._contract('user_modules')
        version=self.db.scalar(select(header.c.version).where(header.c.user_id==subject)) or 0
        attempted=self.db.scalar(select(func.max(attempts.c.module_version)).where(attempts.c.user_id==subject)) or 0
        floor=max(version,attempted)+1
        self.db.execute(update(header).where(header.c.user_id==subject).values(version=floor))
        self.db.execute(update(modules).where(modules.c.user_id==subject).values(version=floor,enabled=False,schedules_paused=True))
        return {**controls,'module_version_floor':floor,'spend_authority_restored':False,
            'balances_preserved':True,'uncertain_reservations_released':False,
            'verification_dispatch_disabled':True}
