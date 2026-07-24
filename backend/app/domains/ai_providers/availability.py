from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol, TypeVar
from zoneinfo import ZoneInfo

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.jobs.models import Job
from app.shared.types import JobStatus


CAPACITY_FAILURE_COOLDOWN = timedelta(hours=1)
IST = ZoneInfo("Asia/Kolkata")
CAPACITY_ERROR_MARKERS = (
    "insufficient balance",
    "insufficient_balance",
    "insufficient quota",
    "insufficient_quota",
    "exceeded your current quota",
    "billing hard limit",
    "billing details",
    "payment required",
    "credit balance",
    "account balance is too low",
)


class ProviderModelTarget(Protocol):
    provider: str
    model: str


TargetT = TypeVar("TargetT", bound=ProviderModelTarget)


@dataclass(frozen=True)
class TargetAvailability:
    available: bool
    reason: str | None = None
    retry_after: datetime | None = None


def is_provider_capacity_error(error: object) -> bool:
    text = str(error or "").lower()
    return any(marker in text for marker in CAPACITY_ERROR_MARKERS)


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _format_retry_after_ist(value: datetime) -> str:
    return value.astimezone(IST).strftime("%d %b %Y, %I:%M %p IST")


async def get_recent_target_availability(
    session: AsyncSession,
    provider: str,
    model: str,
    *,
    now: datetime | None = None,
) -> TargetAvailability:
    terminal_statuses = (
        JobStatus.COMPLETED,
        JobStatus.PARTIAL,
        JobStatus.FAILED,
    )
    result = await session.execute(
        select(Job)
        .where(
            Job.provider == provider,
            Job.model == model,
            Job.status.in_(terminal_statuses),
        )
        .order_by(desc(Job.id))
        .limit(1)
    )
    latest = result.scalar_one_or_none()
    if latest is None or latest.status == JobStatus.COMPLETED:
        return TargetAvailability(available=True)
    if not is_provider_capacity_error(latest.error_message):
        return TargetAvailability(available=True)

    failed_at = _as_utc(latest.updated_at or latest.created_at)
    if failed_at is None:
        return TargetAvailability(available=True)
    retry_after = failed_at + CAPACITY_FAILURE_COOLDOWN
    current_time = _as_utc(now) or datetime.now(UTC)
    if current_time >= retry_after:
        return TargetAvailability(available=True)

    return TargetAvailability(
        available=False,
        retry_after=retry_after,
        reason=(
            f"{provider}/{model} is temporarily paused after a provider billing or quota error. "
            f"Automatic retry is allowed after {_format_retry_after_ist(retry_after)}."
        ),
    )


async def filter_recently_available_targets(
    session: AsyncSession,
    targets: list[TargetT],
) -> tuple[list[TargetT], list[tuple[TargetT, TargetAvailability]]]:
    available: list[TargetT] = []
    blocked: list[tuple[TargetT, TargetAvailability]] = []
    for target in targets:
        availability = await get_recent_target_availability(
            session,
            target.provider,
            target.model,
        )
        if availability.available:
            available.append(target)
        else:
            blocked.append((target, availability))
    return available, blocked
