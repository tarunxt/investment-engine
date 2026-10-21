"""Durable admission using existing accounts/attempts; uncertain I/O stays held.

No in-process semaphore, auto-expiring paid lease or blind paid retry. The
platform account serializes Stage13 admission. Caller commits enqueue; claim and
settlement commit receipts before/after I/O. This gate is not yet composed into
legacy provider entry points and cannot be advertised as a live global cap.
"""
from dataclasses import asdict
from datetime import datetime, timezone
from decimal import Decimal
from sqlalchemy import select, func, update
from sqlalchemy.exc import IntegrityError
from app.domains.recommendation_audit.models import SpendAccount, SpendAttempt
from .contracts import BoundaryDenied, Limits, digest, money, utc

ACTIVE=('started','uncertain','cancelled_uncertain')

def request_binding(identity,request,limits,input_tokens,output_tokens,fanout):
    return digest({'identity':[identity.owner_id,identity.module_id,identity.version],'request':request,'input_tokens':input_tokens,'output_tokens':output_tokens,'fanout':fanout,'limits':asdict(limits)})


class Budgets:
    def __init__(self, db, limits, policy):
        self.db,self.limits,self.policy=db,limits.validate(),policy

    def _account(self, owner, day, cap):
        row=self.db.scalar(select(SpendAccount).where(SpendAccount.user_id==owner,SpendAccount.day==day).with_for_update().execution_options(populate_existing=True))
        if row is None:
            try:
                with self.db.begin_nested():
                    self.db.add(SpendAccount(user_id=owner,day=day,cap_usd=money(cap),spent_usd=0,reserved_usd=0));self.db.flush()
            except IntegrityError:pass
            row=self.db.scalar(select(SpendAccount).where(SpendAccount.user_id==owner,SpendAccount.day==day).with_for_update().execution_options(populate_existing=True))
        if row is None:raise BoundaryDenied('ACCOUNT_UNAVAILABLE')
        return row

    def _lock(self, now):
        if self.db.get_bind().dialect.name=='postgresql':
            self.db.execute(select(func.set_config('lock_timeout','2000',True)))
            self.db.execute(select(func.set_config('statement_timeout','5000',True)))
        elif self.db.get_bind().dialect.name=='sqlite':
            # Disposable preview/tests only: acquire SQLite's writer lock before
            # reading account state. PostgreSQL uses row locks, not this branch.
            self.db.execute(update(SpendAccount).where(SpendAccount.user_id==0).values(reserved_usd=SpendAccount.reserved_usd))
        return self._account(0,utc(now).date().isoformat(),self.limits.platform_daily_usd)

    def enqueue(self, identity, operation, attempt_key, request, *, input_tokens, output_tokens, fanout, now=None):
        now=utc(now or datetime.now(timezone.utc));self._lock(now)
        if type(identity.owner_id)is not int or identity.owner_id<=0 or not isinstance(operation,str) or not 1<=len(operation)<=128 or not isinstance(attempt_key,str) or not 1<=len(attempt_key)<=128:
            raise BoundaryDenied('INVALID_ATTEMPT_IDENTITY')
        self.policy(self.db,identity)
        for value,bound in [(input_tokens,self.limits.max_input_tokens),(output_tokens,self.limits.max_output_tokens),(fanout,self.limits.max_fanout)]:
            if type(value)is not int or not 0<=value<=bound:raise BoundaryDenied('TOKEN_OR_FANOUT_LIMIT')
        bound=request_binding(identity,request,self.limits,input_tokens,output_tokens,fanout)
        old=self.db.scalar(select(SpendAttempt).where(SpendAttempt.user_id==identity.owner_id,SpendAttempt.operation_key==operation,SpendAttempt.attempt_key==attempt_key))
        if old:
            if old.request_hash!=bound:raise BoundaryDenied('IDEMPOTENCY_CONFLICT')
            return old
        if self.db.scalar(select(SpendAttempt.id).where(SpendAttempt.operation_key.is_not(None),SpendAttempt.status=='tariff_breach').limit(1)):
            raise BoundaryDenied('TARIFF_BREACH_REQUIRES_REVIEW')
        queued=list(self.db.scalars(select(SpendAttempt.user_id).where(SpendAttempt.operation_key.is_not(None),SpendAttempt.status=='queued')))
        if len(queued)>=self.limits.max_queued_platform or queued.count(identity.owner_id)>=self.limits.max_queued_per_user:
            raise BoundaryDenied('QUEUE_CAPACITY_LIMIT')
        siblings=list(self.db.scalars(select(SpendAttempt).where(SpendAttempt.user_id==identity.owner_id,SpendAttempt.operation_key==operation)))
        if len(siblings)>=self.limits.max_attempts:raise BoundaryDenied('ATTEMPT_LIMIT')
        if any(s.status in ('queued',*ACTIVE) for s in siblings):raise BoundaryDenied('PRIOR_ATTEMPT_UNRESOLVED')
        account=self._account(identity.owner_id,now.date().isoformat(),self.limits.user_daily_usd)
        row=SpendAttempt(verification_id=None,user_id=identity.owner_id,account_id=account.id,operation_key=operation,attempt_key=attempt_key,module_id=identity.module_id,module_version=identity.version,adapter='stage13-bound-analysis',tariff_version=self.limits.tariff_version,upper_bound_usd=money(self.limits.attempt_usd),status='queued',request_hash=bound,limits_json=asdict(self.limits),input_tokens=input_tokens,output_tokens=output_tokens,created_at=now)
        self.db.add(row);self.db.flush();return row

    def claim_next(self, *, now=None, expected_id=None):
        """Round robin among eligible owners; per-owner slots preserve neighbors."""
        now=utc(now or datetime.now(timezone.utc));platform=self._lock(now)
        if self.db.scalar(select(SpendAttempt.id).where(SpendAttempt.operation_key.is_not(None),SpendAttempt.status=='tariff_breach').limit(1)):
            self.db.commit();return None
        active=list(self.db.scalars(select(SpendAttempt).where(SpendAttempt.operation_key.is_not(None),SpendAttempt.status.in_(ACTIVE))))
        if len(active)>=self.limits.platform_concurrency:return None
        queued=list(self.db.scalars(select(SpendAttempt).where(SpendAttempt.operation_key.is_not(None),SpendAttempt.status=='queued').order_by(SpendAttempt.created_at,SpendAttempt.id).with_for_update().execution_options(populate_existing=True)))
        owners=sorted({r.user_id for r in queued});cursor=platform.last_admitted_owner or 0
        owners=[o for o in owners if o>cursor]+[o for o in owners if o<=cursor]
        for owner in owners:
            if sum(a.user_id==owner for a in active)>=self.limits.user_concurrency:continue
            row=next(r for r in queued if r.user_id==owner)
            if row.limits_json!=asdict(self.limits):
                row.status='cancelled';continue
            from app.domains.modules.lifecycle import WorkIdentity,ModuleLifecycleDenied
            try:self.policy(self.db,WorkIdentity(row.user_id,row.module_id,row.module_version))
            except (BoundaryDenied,PermissionError):row.status='cancelled';continue
            # A queued request cannot silently consume tomorrow's cap.
            account=self.db.get(SpendAccount,row.account_id,populate_existing=True)
            if account is None or account.user_id!=owner:
                row.status='cancelled';continue
            if account.day!=now.date().isoformat():row.status='expired';continue
            account=self._account(owner,account.day,self.limits.user_daily_usd)
            amount=row.upper_bound_usd
            operation=list(self.db.scalars(select(SpendAttempt).where(SpendAttempt.user_id==owner,SpendAttempt.operation_key==row.operation_key,SpendAttempt.id!=row.id)))
            op_spend=sum((a.actual_usd if a.actual_usd is not None else a.upper_bound_usd if a.status in ACTIVE else Decimal(0) for a in operation),Decimal(0))
            totals=self.db.execute(select(func.coalesce(func.sum(SpendAccount.spent_usd+SpendAccount.reserved_usd),0)).where(SpendAccount.day==account.day,SpendAccount.user_id>0)).scalar_one()
            if op_spend+amount>money(self.limits.operation_usd) or account.spent_usd+account.reserved_usd+amount>min(account.cap_usd,money(self.limits.user_daily_usd)) or totals+amount>min(platform.cap_usd,money(self.limits.platform_daily_usd)):
                row.status='quota_blocked';continue
            if expected_id is not None and row.id!=expected_id:
                self.db.commit();return None # This delivery must not leapfrog the fair turn.
            account.reserved_usd+=amount;row.status='started';platform.last_admitted_owner=owner
            self.db.commit();return row
        self.db.commit();return None

    def settle(self, owner, attempt_id, actual=None, *, now=None):
        """Only a trusted adapter receipt may supply actual; never browser input."""
        now=utc(now or datetime.now(timezone.utc));self._lock(now)
        row=self.db.scalar(select(SpendAttempt).where(SpendAttempt.id==attempt_id,SpendAttempt.user_id==owner,SpendAttempt.operation_key.is_not(None)).with_for_update().execution_options(populate_existing=True))
        if row is None:raise BoundaryDenied('OWNED_ATTEMPT_REQUIRED')
        linked=self.db.get(SpendAccount,row.account_id,populate_existing=True)
        if linked is None or linked.user_id!=owner:raise BoundaryDenied('OWNED_SPEND_ACCOUNT_REQUIRED')
        if row.status in ('settled','cancelled_settled','tariff_breach'):
            if actual is None or money(actual)==row.actual_usd:
                self.db.commit();return row
            raise BoundaryDenied('SETTLEMENT_CONFLICT')
        if row.status not in ACTIVE:raise BoundaryDenied('ATTEMPT_NOT_STARTED')
        cancelled=row.status=='cancelled_uncertain'
        if actual is None:row.status='cancelled_uncertain' if cancelled else 'uncertain'
        else:
            actual=money(actual);account=self._account(owner,linked.day,self.limits.user_daily_usd)
            account.reserved_usd-=row.upper_bound_usd;account.spent_usd+=actual
            row.actual_usd=actual;row.status=('cancelled_settled' if cancelled else 'settled') if actual<=row.upper_bound_usd else 'tariff_breach';row.finished_at=now
        self.db.commit();return row

    def cancel(self, owner, attempt_id, *, now=None):
        self._lock(utc(now or datetime.now(timezone.utc)))
        row=self.db.scalar(select(SpendAttempt).where(SpendAttempt.id==attempt_id,SpendAttempt.user_id==owner,SpendAttempt.operation_key.is_not(None)).with_for_update())
        if not row:raise BoundaryDenied('OWNED_ATTEMPT_REQUIRED')
        # No assumption that an already-started call did not spend money.
        if row.status=='queued':row.status='cancelled'
        elif row.status in ('started','uncertain'):row.status='cancelled_uncertain'
        self.db.commit();return row
