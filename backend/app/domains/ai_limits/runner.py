"""Explicit synthetic runner. No registration into normal provider runtime."""
from .contracts import BoundaryDenied
from copy import deepcopy
from .private_effects import LocalSink


class FakeProvider:
    def __init__(self,document):self.document=document;self.calls=0
    def generate(self,request,*,max_input_tokens,max_output_tokens,tools):
        if tools:raise BoundaryDenied('TOOLS_DISABLED')
        self.calls+=1
        return {'document':self.document,'actual_usd':'0','input_tokens':min(10,max_input_tokens),'output_tokens':min(10,max_output_tokens)}


def run_next(budgets, provider, *, validate, now=None, expected_id=None,before_call=lambda:None,effect_fence=lambda:None):
    """Durable reservation precedes any call, even the zero-cost fake.

    Unknown outcomes remain reserved, not replayed. A real transport and tariff
    contract are deliberately absent and require separate implementation review.
    """
    if type(provider) is not FakeProvider:raise BoundaryDenied('FAKE_PROVIDER_REQUIRED')
    row=budgets.claim_next(now=now,expected_id=expected_id)
    if row is None:return {'status':'quota_or_concurrency_or_no_work','partial_analysis':True}
    try:
        from sqlalchemy import select
        from app.domains.recommendation_audit.models import SpendAttempt
        from app.domains.modules.lifecycle import WorkIdentity
        # Recheck after queue/admission waits; selection lock spans actual I/O.
        budgets.policy(budgets.db,WorkIdentity(row.user_id,row.module_id,row.module_version))
        before_call()
        current=budgets.db.scalar(select(SpendAttempt).where(SpendAttempt.id==row.id).with_for_update().execution_options(populate_existing=True))
        if current.status!='started':raise BoundaryDenied('ATTEMPT_CANCELLED')
        effect_fence()  # last admission check, same transaction through I/O
        result=provider.generate({'request_hash':row.request_hash},max_input_tokens=row.input_tokens,max_output_tokens=row.output_tokens,tools=[])
        budgets.db.commit()  # release module fence before platform settlement lock
        # A successful invocation is charged even if deterministic validation
        # rejects its response. Only a trusted receipt settles the reservation.
        receipt=budgets.settle(row.user_id,row.id,result['actual_usd'],now=now)
        if receipt.status!='settled':raise BoundaryDenied('BUDGET_CANCELLED_OR_TARIFF_BREACH')
        if result['input_tokens']>row.input_tokens or result['output_tokens']>row.output_tokens:
            raise BoundaryDenied('TOKEN_RECEIPT_EXCEEDS_BOUND')
        document=deepcopy(result['document']);verdict=validate(document)
        return {'status':'completed','attempt_id':row.id,'validation':verdict,'document':document,'orders_authorized':False}
    except BaseException:
        budgets.db.rollback()
        # settle(None) preserves reservations; already-settled receipts remain.
        budgets.settle(row.user_id,row.id,None,now=now)
        raise
