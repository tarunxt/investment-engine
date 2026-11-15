"""Complete persisted event-window reads, independent of invoice completeness.

One statement snapshot; bounded driver batches, compact lifecycle/identity state.
Cost dashboards should reuse this service rather than sum per-batch reports.
"""
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.api_usage.coverage import AttemptCoverageAccumulator
from app.domains.api_usage.models import ApiUsageAttemptEvent


async def load_window_attempt_coverage(
    db: AsyncSession, *, user_id: int, start_utc: datetime, end_utc: datetime,
    provider: str | None = None,
) -> dict[str, Any]:
    # A single streaming SELECT uses one database statement snapshot. Driver
    # batches stay bounded while lifecycle/identity accounting spans all rows.
    # Attempt estimates remain separate from legacy/day totals to avoid counting
    # the same upstream response twice.
    cutoff = datetime.now(UTC)
    statement = select(ApiUsageAttemptEvent).where(
        ApiUsageAttemptEvent.user_id == user_id,
        or_(
            and_(ApiUsageAttemptEvent.event_kind == "started",
                 ApiUsageAttemptEvent.started_at >= start_utc.replace(tzinfo=UTC),
                 ApiUsageAttemptEvent.started_at < end_utc.replace(tzinfo=UTC)),
            and_(ApiUsageAttemptEvent.event_kind == "finished",
                 func.coalesce(ApiUsageAttemptEvent.finished_at, ApiUsageAttemptEvent.started_at) >= start_utc.replace(tzinfo=UTC),
                 func.coalesce(ApiUsageAttemptEvent.finished_at, ApiUsageAttemptEvent.started_at) < end_utc.replace(tzinfo=UTC)),
        ),
        ApiUsageAttemptEvent.started_at <= cutoff,
        or_(ApiUsageAttemptEvent.event_kind != "finished",
            ApiUsageAttemptEvent.finished_at <= cutoff,
            ApiUsageAttemptEvent.finished_at.is_(None)),
        *([ApiUsageAttemptEvent.actual_provider == provider] if provider else []),
    ).order_by(ApiUsageAttemptEvent.started_at, ApiUsageAttemptEvent.event_id).execution_options(yield_per=1000)
    accumulator = AttemptCoverageAccumulator()
    events = await db.stream_scalars(statement)
    try:
        async for event in events:
            accumulator.add(event)
    finally:
        await events.close()
    result = accumulator.finish()
    result.update({
        "schema_version": 1,
        "persisted_read_state": "complete",
        "read_cutoff": cutoff.isoformat(),
        "window_start": start_utc.replace(tzinfo=UTC).isoformat(),
        "window_end_exclusive": end_utc.replace(tzinfo=UTC).isoformat(),
        "window_basis": "started_events_by_start_and_finished_events_by_finish_time",
        "batch_rows": 1000,
        "snapshot_scope": "one_database_statement",
        "invocation_coverage_state": "unknown",
    })
    return result

