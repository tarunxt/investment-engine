"""Mandatory budget context for every automated rebalance worker invocation."""
from contextvars import ContextVar
from dataclasses import dataclass

from . import policy, execution
from .ledger import SpendCapBlocked, bind_scope, require_reconciled_job, reserve, settle


def sessions():
    from app.infrastructure.database.sync_session import SyncSessionLocal
    return SyncSessionLocal()


@dataclass
class SpendContext:
    scope_id: int
    user_id: int
    job_id: int
    retry: int
    fence_token: str
    ordinal: int = 0


_context: ContextVar[SpendContext | None] = ContextVar("rebalance_spend_context", default=None)


def configure_job(job, retry):
    values = [getattr(job, name, None) for name in (
        "auto_rebalance_portfolio", "auto_rebalance_sequence", "auto_rebalance_label")]
    if all(value is None for value in values):
        return _context.set(None)  # unrelated workers keep existing behavior
    portfolio, sequence, label = values
    if not isinstance(label, str) or not label.strip():
        raise SpendCapBlocked("Automated rebalance workflow identity is incomplete")
    user_id, job_id = getattr(job, "user_id", None), getattr(job, "id", None)
    if (isinstance(job_id, bool) or not isinstance(job_id, int) or job_id <= 0
            or isinstance(retry, bool) or not isinstance(retry, int) or retry < 0):
        raise SpendCapBlocked("Automated rebalance dispatch identity is unavailable")
    with sessions() as db:
        scope = bind_scope(db, user_id=user_id, portfolio=portfolio, sequence=sequence)
        require_reconciled_job(db, scope=scope, job_id=job_id)
        scope_id = scope.id
        fence_token = execution.claim(db, scope_id=scope_id, user_id=user_id, job_id=job_id)
        db.commit()
    return _context.set(SpendContext(scope_id, user_id, job_id, retry, fence_token))


def reset_job(token, *, completed=False):
    if token is not None:
        context = _context.get()
        try:
            if context is not None:
                with sessions() as db:
                    execution.finish(db, scope_id=context.scope_id, job_id=context.job_id,
                        token=context.fence_token, completed=completed)
                    db.commit()
        finally:
            _context.reset(token)


def scoped_client(client):
    """Keep ordinary requests unchanged; capped SDKs must disable hidden retry."""
    if _context.get() is None:
        return client
    configured = client.with_options(max_retries=0)
    if type(configured.max_retries) is not int or configured.max_retries != 0:
        raise SpendCapBlocked("Hidden SDK retries must be disabled before capped dispatch")
    return configured


def prepare_request(endpoint, call, args, kwargs):
    context = _context.get()
    if context is None:
        return kwargs
    from app.domains.jobs.resource_request import bounded_token_request, TOKEN_PARAMETERS
    from app.domains.jobs.resource_policy import MAX_OUTPUT_PER_RESPONSE
    if args:
        raise SpendCapBlocked("Positional provider request bounds are unsupported")
    client = getattr(getattr(call, "__self__", None), "_client", None)
    retries = getattr(client, "max_retries", None)
    with sessions() as db:
        allowance = execution.remaining(db, scope_id=context.scope_id, job_id=context.job_id,
            token=context.fence_token)
    requested = kwargs.get(TOKEN_PARAMETERS.get(endpoint), MAX_OUTPUT_PER_RESPONSE)
    if type(requested) is not int or requested > min(allowance["output_tokens"], MAX_OUTPUT_PER_RESPONSE):
        raise SpendCapBlocked("Original output request cannot fit; no quality-reducing retry is authorized")
    return bounded_token_request(endpoint, kwargs, remaining_tokens=allowance["output_tokens"],
        remaining_seconds=allowance["remaining_seconds"], sdk_retries=retries)


@dataclass(frozen=True)
class Admission:
    scope_id: int
    attempt_id: int
    bound: policy.RequestBound
    job_id: int
    fence_token: str
    resource_id: int


def before_call(*, provider, model, request, usage_context=None):
    context = _context.get()
    if context is None:
        # A persisted automated-workflow identity must never become uncapped
        # merely because a thread/task boundary lost its spend ContextVar.
        # Ordinary untagged analysis retains its existing policy.
        if getattr(usage_context, "workflow_id", None) is not None:
            raise SpendCapBlocked("Workflow spending context is missing; no paid request was dispatched")
        return None
    if usage_context is not None and (
            getattr(usage_context, "job_id", None) != context.job_id
            or getattr(usage_context, "user_id", None) != context.user_id
            or getattr(usage_context, "job_attempt", None) != context.retry):
        raise SpendCapBlocked("Provider attempt conflicts with its owned spending context")
    bound = policy.resolve_bound(provider=provider, model=model, request=request)
    bound.validate()  # unknown/stale policy fails before external I/O
    ordinal = context.ordinal
    context.ordinal += 1
    # A redelivered task has the same retry counter and repeats the same key.
    # Unknown prior dispatch therefore cannot acquire a second reservation.
    key = f"job:{context.job_id}:retry:{context.retry}:call:{ordinal}"
    with sessions() as db:
        resource_id = execution.reserve_call(db, scope_id=context.scope_id, job_id=context.job_id,
            token=context.fence_token, attempt_key=key,
            output_tokens=bound.limits.generated_tokens, tool_calls=bound.limits.search_requests)
        attempt_id = reserve(db, scope_id=context.scope_id, user_id=context.user_id,
            job_id=context.job_id, attempt_key=key, provider=provider, model=model,
            upper_inr=bound.upper_inr, tariff_version=bound.tariff_version, fx_version=bound.fx_version)
    return Admission(context.scope_id, attempt_id, bound, context.job_id, context.fence_token, resource_id)


def after_call(admission, evidence):
    if admission is None:
        return
    # Missing/malformed evidence, exceptions and interrupted streams retain the
    # full durable reservation. Never use AIProviderResponse.cost as an invoice.
    charge = None
    if evidence.get("status") == "success":
        try:
            charge = admission.bound.confirmed_charge(evidence)
        except Exception:
            # Do not release spend on malformed/incomplete provider evidence.
            with sessions() as db:
                _settle_resources(db, admission)
                settle(db, scope_id=admission.scope_id, attempt_id=admission.attempt_id)
            raise SpendCapBlocked("Provider settlement is unavailable; reservation retained") from None
    if charge is not None:
        try:
            if not isinstance(charge, policy.ConfirmedCharge):
                raise SpendCapBlocked("Unconfirmed receipt")
            charge.validate(admission.bound)
        except SpendCapBlocked:
            with sessions() as db:
                _settle_resources(db, admission)
                settle(db, scope_id=admission.scope_id, attempt_id=admission.attempt_id)
            raise SpendCapBlocked("Provider settlement is not confirmed; reservation retained") from None
    with sessions() as db:
        _settle_resources(db, admission, evidence)
        settle(db, scope_id=admission.scope_id, attempt_id=admission.attempt_id,
            confirmed_actual_inr=charge.inr if charge else None,
            receipt=charge.receipt if charge else None,
            evidence_hash=charge.digest() if charge else None,
            settlement_reference=charge.settlement_reference if charge else None)



def _settle_resources(db, admission, evidence=None):
    # Resource usage is not an invoice. Only the adapter's complete generated
    # output (including reasoning) and tool evidence can release resource slots.
    usage = None
    resolver = admission.bound.confirmed_resources
    if resolver is not None and evidence is not None and evidence.get("status") == "success":
        try:
            usage = resolver(evidence)
            if (not isinstance(usage, tuple) or len(usage) != 2
                    or any(type(value) is not int or value < 0 for value in usage)):
                usage = None
        except Exception:
            usage = None
    return execution.settle_call(db, scope_id=admission.scope_id, job_id=admission.job_id,
        token=admission.fence_token, resource_id=admission.resource_id,
        output_tokens=usage[0] if usage else None, tool_calls=usage[1] if usage else None)


def check_tool_batch(calls):
    """Validate the complete returned batch before any custom tool dispatch.

    Each actual tool request still requires its own atomic resource and spend
    admission. This check never grants or releases slots.
    """
    context = _context.get()
    if context is None:
        return
    from app.domains.jobs.resource_request import validate_tool_batch
    from app.domains.jobs.resource_policy import MAX_TOOLS_PER_JOB
    with sessions() as db:
        allowance = execution.remaining(db, scope_id=context.scope_id, job_id=context.job_id,
            token=context.fence_token)
    validate_tool_batch(calls, tools_already_reserved=MAX_TOOLS_PER_JOB - allowance["tool_calls"])
