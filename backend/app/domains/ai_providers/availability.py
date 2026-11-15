from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, TypeVar
from sqlalchemy.ext.asyncio import AsyncSession
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


async def get_recent_target_availability(
    session: AsyncSession,
    provider: str,
    model: str,
    *,
    now: datetime | None = None,
) -> TargetAvailability:
    # A previous billing or quota failure is only a record of that individual
    # attempt. Funds can be replenished immediately, so stale job history must
    # never suppress a subsequent provider/model request.
    return TargetAvailability(available=True)


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
