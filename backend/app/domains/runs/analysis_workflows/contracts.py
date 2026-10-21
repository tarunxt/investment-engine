"""Trusted composition contracts. Requests never choose adapters or policy facts."""
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib,json

STAGES=('sync','threats','swing','rebalance','technical','actionables')
TOPIC='analysis.workflow.stage.v1'
MAX_ATTEMPTS=3
MAX_WAIT_SECONDS=300
RELAY_SECONDS=5

class WorkflowDenied(PermissionError):pass
class TransientAnalysisError(Exception):pass
class PermanentAnalysisError(Exception):pass


def utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

def naive(value):return utc(value).replace(tzinfo=None)
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()

@dataclass(frozen=True)
class Runtime:
    """All callbacks are server-owned, bound by the application's composition root.

    policy holds the existing selection lock. source returns an immutable owned
    portfolio/connection fingerprint; plan returns approved prompt/model versions.
    adapter performs DB enqueue only, or a deterministic no-network fake. It must
    never directly invoke a provider. All costs come from persisted job receipts.
    """
    policy: object
    source: object
    plan: object
    adapter: object
    calendar: object
    governance: object | None = None
