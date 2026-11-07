"""Safe progress metadata for existing fenced consumer transactions only.

No I/O, imports of application startup, cadence or new retention policy. These
observations never authorize ownership, retries, publication or provider work.
"""
from math import isfinite


def receipt_scope(task, *, recovery, queue, prefix):
    """Bind admitted delivery evidence to the configured isolated transport.

    A local/eager call, missing routing metadata or mismatched prefix is unknown.
    No task/host identifiers, payloads or connection URLs are retained.
    """
    try:
        request = task.request
        if (recovery is True and request.is_eager is False
                and request.id and request.delivery_info.get("routing_key") == queue
                and task.app.conf.broker_transport_options.get("global_keyprefix") == prefix):
            return "recovery_analysis"
    except (AttributeError, TypeError):
        pass
    return "unknown"


def capture(record, event, now, *, scope="unknown"):
    """Return a copy; preserve prior attempt and unrelated immutable metadata."""
    if type(now) not in (int, float) or not isfinite(now) or now < 0:
        return record
    fields = {"admitted": "admitted_at", "checkpoint": "lease_checkpoint_at",
              "call_started": "provider_call_started_at", "call_returned": "provider_call_returned_at"}
    if event not in fields:
        raise ValueError("Unknown progress event")
    old = record.get("progress")
    if old is not None and (not isinstance(old, dict) or old.get("version") != 1):
        # Retain unrecognized historical metadata rather than rewriting it.
        return record
    progress = dict(old) if old is not None else {
        "version": 1, "receipt_scope": "unknown", "admitted_at": None,
        "lease_checkpoint_at": None, "provider_call_started_at": None,
        "provider_call_returned_at": None,
    }
    field = fields[event]
    previous = progress.get(field)
    if type(previous) in (int, float) and isfinite(previous) and previous > now:
        # Clock regression must not move the source timestamp backwards.
        return record
    progress[field] = now
    if event == "admitted":
        progress["receipt_scope"] = scope if scope == "recovery_analysis" else "unknown"
    return {**record, "progress": progress}
