from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import desc, select

from app.domains.fx_rates.models import FxRate
from app.infrastructure.database.session import AsyncSessionLocal

USD_INR_BASE_CURRENCY = "USD"
USD_INR_QUOTE_CURRENCY = "INR"
USD_INR_STALE_AFTER = timedelta(hours=36)


@dataclass(frozen=True)
class PersistedFxAssessment:
    value: float | None
    source: str | None
    as_of: datetime | None
    age_seconds: int | None
    status: str
    stale_after_seconds: int

    @property
    def valid_value(self) -> float | None:
        return self.value if self.status == "valid" else None


def assess_persisted_fx_rate(
    *,
    value: Decimal | float | None,
    source: str | None,
    as_of: datetime | None,
    now: datetime | None = None,
) -> PersistedFxAssessment:
    stale_after_seconds = int(USD_INR_STALE_AFTER.total_seconds())
    if value is None or source is None or as_of is None:
        return PersistedFxAssessment(
            value=None,
            source=None,
            as_of=None,
            age_seconds=None,
            status="unavailable",
            stale_after_seconds=stale_after_seconds,
        )

    current_time = now or datetime.now(UTC)
    normalized_as_of = as_of if as_of.tzinfo else as_of.replace(tzinfo=UTC)
    age_seconds = max(0, int((current_time - normalized_as_of).total_seconds()))
    numeric_value = float(value)
    status = "valid" if age_seconds <= stale_after_seconds else "stale"
    return PersistedFxAssessment(
        value=numeric_value,
        source=source,
        as_of=normalized_as_of,
        age_seconds=age_seconds,
        status=status,
        stale_after_seconds=stale_after_seconds,
    )


async def load_persisted_usd_inr_rate(
    *,
    now: datetime | None = None,
) -> PersistedFxAssessment:
    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(
                select(
                    FxRate.rate,
                    FxRate.source,
                    FxRate.source_as_of,
                )
                .where(
                    FxRate.base_currency == USD_INR_BASE_CURRENCY,
                    FxRate.quote_currency == USD_INR_QUOTE_CURRENCY,
                    FxRate.verified.is_(True),
                )
                .order_by(desc(FxRate.source_as_of), desc(FxRate.id))
                .limit(1)
            )
        ).one_or_none()

    if row is None:
        return assess_persisted_fx_rate(
            value=None,
            source=None,
            as_of=None,
            now=now,
        )
    return assess_persisted_fx_rate(
        value=row.rate,
        source=row.source,
        as_of=row.source_as_of,
        now=now,
    )
