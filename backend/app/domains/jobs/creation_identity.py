"""Actor/operation/payload-bound cache identity; not durable A11 admission."""
from datetime import timezone
import hashlib
import json

OPERATION = "jobs.create.v2"


def utc_schedule(value):
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def payload_fingerprint(request):
    payload = {name: getattr(request, name) for name in (
        "prompt", "provider", "model", "auto_rebalance_portfolio",
        "auto_rebalance_sequence", "auto_rebalance_label",
    )}
    scheduled = utc_schedule(request.scheduled_at)
    payload["scheduled_at"] = scheduled.isoformat() if scheduled else None
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


def request_key(user_id, operation, key):
    # Raw request keys and prompt text never become Redis keys.
    return f"{operation}:{int(user_id)}:{hashlib.sha256(key.encode()).hexdigest()}"
