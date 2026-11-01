"""Read-only response identity evidence, never inferred from generated text."""
from collections import defaultdict

from sqlalchemy import select

from app.domains.api_usage.models import ApiUsageAttemptEvent


async def load_output_provenance(db, *, user_id: int, job_ids: set[int]) -> dict:
    if not job_ids:
        return {}
    # Only expose identity and observation time, not request IDs or raw payloads.
    rows = (await db.execute(select(
        ApiUsageAttemptEvent.job_id,
        ApiUsageAttemptEvent.actual_provider,
        ApiUsageAttemptEvent.actual_model,
        ApiUsageAttemptEvent.finished_at,
    ).where(
        ApiUsageAttemptEvent.user_id == user_id,
        ApiUsageAttemptEvent.job_id.in_(job_ids),
        ApiUsageAttemptEvent.event_kind == "finished",
        ApiUsageAttemptEvent.status == "success",
        ApiUsageAttemptEvent.phase != "search",
    ))).all()
    grouped = defaultdict(list)
    for row in rows:
        grouped[row.job_id].append(row)
    return {job_id: summarize_output_provenance(events) for job_id, events in grouped.items()}


def summarize_output_provenance(events) -> dict:
    identities = sorted({
        (event.actual_provider, event.actual_model or None) for event in events
    }, key=lambda identity: (identity[0], identity[1] or ""))
    times = [event.finished_at for event in events if event.finished_at is not None]
    return {
        "source": "api_usage_attempt_events",
        "identities": [{"provider": provider, "model": model} for provider, model in identities],
        "observed_from": min(times) if times else None,
        "observed_to": max(times) if times else None,
    }
