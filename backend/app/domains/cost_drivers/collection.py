"""Per-collection provider request budget. No automatic retries or collection."""
from contextlib import contextmanager
from contextvars import ContextVar
from time import monotonic

_ACTIVE = ContextVar("cost_collection_budget", default=None)
MAX_PROVIDER_REQUESTS = 100
MAX_COLLECTION_SECONDS = 240


@contextmanager
def collection_budget(require_ownership=None):
    meter = {"requests": 0, "requestCap": MAX_PROVIDER_REQUESTS, "sdkRetries": 0, "byService": {}, "budgetExceeded": False}
    token = _ACTIVE.set((meter, monotonic() + MAX_COLLECTION_SECONDS, require_ownership))
    try:
        yield meter
    finally:
        _ACTIVE.reset(token)


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
            meter, deadline, require_ownership = active
            if require_ownership is not None:
                require_ownership()
            if meter["requests"] >= MAX_PROVIDER_REQUESTS or monotonic() >= deadline:
                meter["budgetExceeded"] = True
                raise RuntimeError("Cost collection request/time budget exhausted")
            meter["requests"] += 1
            meter["byService"][self.service] = meter["byService"].get(self.service, 0) + 1
            return value(*args, **kwargs)
        return call
