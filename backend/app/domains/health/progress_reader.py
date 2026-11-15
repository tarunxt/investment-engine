"""Bounded read of progress captured by real ownership/dispatch transactions.

No broker inspection, publication, provider call or heartbeat scheduler. A sample
is not a verified queue total and an owner checkpoint is not consumer-wide health.
"""
import asyncio
from datetime import datetime, timezone

from sqlalchemy import text

from .execution_reader import ROW_LIMIT, READ_TIMEOUT_SECONDS, _epoch, projection_query


def progress_query(jobs, outbox, *, actor_id, recovery):
    claim = jobs.c.runtime_metadata_json["execution_claim"]
    progress = claim["progress"]
    return projection_query(jobs, outbox, actor_id=actor_id, recovery=recovery).add_columns(
        progress["version"].as_string().label("progress_version"),
        progress["receipt_scope"].as_string().label("receipt_scope"),
        progress["admitted_at"].as_string().label("admitted_at"),
        progress["lease_checkpoint_at"].as_string().label("lease_checkpoint_at"),
        progress["provider_call_started_at"].as_string().label("provider_call_started_at"),
        progress["provider_call_returned_at"].as_string().label("provider_call_returned_at"),
        outbox.c.published_at.label("published_at"),
        outbox.c.next_attempt_at.label("next_attempt_at"),
        # Project just absolute ETA, never the payload/IDs/provider inputs.
        outbox.c.payload["eta"].as_string().label("eta"),
    )


def _eta(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Invalid ETA")
    return _epoch(datetime.fromisoformat(value))


def unknown_progress(*, recovery, now):
    return {
        "status": "unknown", "policy": "advisory", "deployment_gate": False,
        "mode": "recovery" if recovery else "normal", "read_state": "unavailable",
        "observed_at": _epoch(now), "source_timestamp": None,
        "consumer": "unknown", "freshness": "unknown", "queue_state": "unknown",
        "receipt_evidence": "unknown",
        "scope": "actor_sample", "scope_complete": False, "sample_size": None,
        "truncated": None, "sample_eligibility_unknown": None,
        "sample_receipts": None, "sample_lease_checkpoints": None,
        "sample_provider_call_intents": None, "sample_provider_returns": None,
        "sample_expired_active_claims": None,
        "sample_oldest_eligible_dispatch_age_seconds": None,
        "last_receipt_age_seconds": None, "last_owner_checkpoint_age_seconds": None,
        "last_provider_call_intent_age_seconds": None,
        "last_provider_return_age_seconds": None, "last_publish_age_seconds": None,
        "oldest_eligible_queue_age_seconds": None,
        "financial_services": "intentional_containment" if recovery else "not_assessed",
        "acceptance_threshold": None, "escalation_owner": None,
    }


def summarize_progress(rows, *, recovery, now):
    result = unknown_progress(recovery=recovery, now=now)
    now = _epoch(now)
    if now is None or now < 0:
        return result
    # Reader already limits SELECT/fetch. Also cap injected fixture iterators.
    from itertools import islice
    sample = list(islice(rows, ROW_LIMIT))
    result.update(read_state="sampled", sample_size=min(len(sample), 100),
                  truncated=len(sample) > 100, sample_receipts=0,
                  sample_lease_checkpoints=0, sample_provider_call_intents=0, sample_provider_returns=0,
                  sample_expired_active_claims=0, sample_eligibility_unknown=0)
    times = {name: [] for name in ("admitted_at", "lease_checkpoint_at",
                                  "provider_call_started_at", "provider_call_returned_at", "published_at")}
    dispatch_ages = []
    for row in sample[:100]:
        # Terminal historical claims are not failed active executions.
        active = row["job_status"] in {"pending", "scheduled", "processing"}
        versioned = str(row["progress_version"]) == "1"
        scoped = row["receipt_scope"] == "recovery_analysis" if recovery else False
        for field, values in times.items():
            value = _epoch(row[field])
            if value is not None and 0 <= value <= now and (
                    field == "published_at" or (versioned and scoped)):
                values.append(value)
                count = {"admitted_at": "sample_receipts",
                         "lease_checkpoint_at": "sample_lease_checkpoints",
                         "provider_call_started_at": "sample_provider_call_intents",
                         "provider_call_returned_at": "sample_provider_returns"}.get(field)
                if count:
                    result[count] += 1
        expires = _epoch(row["claim_expires_at"])
        if active and row["claim_state"] == "owned" and expires is not None and expires <= now:
            result["sample_expired_active_claims"] += 1
        if active and row["dispatch_state"] in {"pending", "uncertain"}:
            try:
                created, eta, due = _epoch(row["created_at"]), _eta(row["eta"]), _epoch(row["next_attempt_at"])
                if created is None or created < 0 or (
                        row["next_attempt_at"] is not None and due is None):
                    result["sample_eligibility_unknown"] += 1
                    continue
                eligible = max(value for value in (created, eta, due) if value is not None)
                if eligible <= now:
                    dispatch_ages.append(now - eligible)
            except (ValueError, OverflowError):
                # Malformed ETA never becomes an immediately eligible obligation.
                result["sample_eligibility_unknown"] += 1
                continue
    for field, response_field in (
        ("admitted_at", "last_receipt_age_seconds"),
        ("lease_checkpoint_at", "last_owner_checkpoint_age_seconds"),
        ("provider_call_started_at", "last_provider_call_intent_age_seconds"),
        ("provider_call_returned_at", "last_provider_return_age_seconds"),
        ("published_at", "last_publish_age_seconds"),
    ):
        if times[field]:
            result[response_field] = now - max(times[field])
    observed = [value for values in times.values() for value in values]
    result["source_timestamp"] = max(observed) if observed else None
    if times["admitted_at"]:
        result["receipt_evidence"] = "observed"
    result["sample_oldest_eligible_dispatch_age_seconds"] = (
        max(dispatch_ages) if dispatch_ages and result["sample_eligibility_unknown"] == 0 else None)
    # No approved objective or global heartbeat: never upgrade to verified healthy.
    return result


async def read_progress(session_factory, jobs, outbox, *, actor_id, recovery, now):
    async def read():
        statement = progress_query(jobs, outbox, actor_id=actor_id, recovery=recovery)
        async with session_factory() as db:
            async with db.begin():
                await db.execute(text("SET TRANSACTION READ ONLY"))
                await db.execute(text("SET LOCAL statement_timeout = '150ms'"))
                await db.execute(text("SET LOCAL lock_timeout = '50ms'"))
                rows = (await db.execute(statement)).mappings().fetchmany(ROW_LIMIT)
                result = summarize_progress(rows, recovery=recovery, now=now)
                await db.rollback()
                return result
    try:
        return await asyncio.wait_for(read(), timeout=READ_TIMEOUT_SECONDS)
    except Exception:
        return unknown_progress(recovery=recovery, now=now)
