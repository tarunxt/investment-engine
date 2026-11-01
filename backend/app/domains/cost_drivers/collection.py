"""Per-collection provider request budget. No automatic retries or collection."""
from contextlib import contextmanager
from contextvars import ContextVar
from time import monotonic

_ACTIVE = ContextVar("cost_collection_budget", default=None)
MAX_PROVIDER_REQUESTS = 100
MAX_COLLECTION_SECONDS = 240


@contextmanager
def collection_budget(require_ownership=None, intent=None):
    meter = {"requests": 0, "requestCap": MAX_PROVIDER_REQUESTS, "sdkRetries": 0, "byService": {}, "budgetExceeded": False}
    token = _ACTIVE.set((meter, monotonic() + MAX_COLLECTION_SECONDS, require_ownership, intent))
    try:
        yield meter
    finally:
        _ACTIVE.reset(token)


def require_durable_budget():
    """Production client construction cannot bypass admission via a bare budget."""
    active = _ACTIVE.get()
    if active is None or active[3] is None:
        raise RuntimeError("AWS cost client requires durable admission and an explicit budget")
    active[3].require_owned()


class MeteredClient:
    def __init__(self, client, service):
        self.client, self.service = client, service

    def __getattr__(self, name):
        value = getattr(self.client, name)
        if not callable(value):
            return value

        def call(*args, **kwargs):
            active = _ACTIVE.get()
            if active is None:
                raise RuntimeError("AWS cost collection requires an explicit collection budget")
            meter, deadline, require_ownership, intent = active
            if require_ownership is not None:
                require_ownership()
            if meter["requests"] >= MAX_PROVIDER_REQUESTS or monotonic() >= deadline:
                meter["budgetExceeded"] = True
                raise RuntimeError("Cost collection request/time budget exhausted")
            if intent is not None:
                intent.begin_request()
            meter["requests"] += 1
            meter["byService"][self.service] = meter["byService"].get(self.service, 0) + 1
            try:
                result = value(*args, **kwargs)
                if intent is not None:
                    intent.finish_request()
                return result
            except BaseException:
                if intent is not None:
                    intent.mark_uncertain()
                raise
        return call
