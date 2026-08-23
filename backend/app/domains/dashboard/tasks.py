from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app.core.logging import get_logger
from app.domains.auth.models import User
from app.domains.dashboard.models import DashboardPortfolioDailySnapshot
from app.domains.dashboard.schemas import DashboardSummaryResponse
from app.domains.dashboard.service import build_dashboard_summary
from app.domains.polymarket.access import user_can_access_singleton_bullpen_runtime
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery

logger = get_logger(__name__)
INDIA_TIME_ZONE = ZoneInfo("Asia/Kolkata")


def _sum_known(*values: float | None) -> float | None:
    known = [value for value in values if value is not None]
    if not known:
        return None
    return round(sum(known), 2)


def _multiply(value: float | None, multiplier: float | None) -> float | None:
    if value is None or multiplier is None or multiplier <= 0:
        return None
    return round(value * multiplier, 2)


def _is_carried_forward(
    source_date: date | None,
    snapshot_date: date,
) -> bool:
    return bool(source_date and source_date < snapshot_date)


def _portfolio_values(summary: DashboardSummaryResponse) -> dict[str, object]:
    rate = summary.usd_inr_rate if summary.usd_inr_status == "valid" else None

    zerodha_snapshot = summary.zerodha.snapshot if summary.zerodha else None
    zerodha_total_inr = (
        round(
            zerodha_snapshot.holdings_market_value
            + zerodha_snapshot.available_margin,
            2,
        )
        if zerodha_snapshot
        else None
    )

    indmoney_snapshot = (
        summary.indmoney_us.snapshot if summary.indmoney_us else None
    )
    indmoney_total_usd = (
        _sum_known(
            indmoney_snapshot.current_value,
            indmoney_snapshot.wallet_balance,
        )
        if indmoney_snapshot
        else None
    )
    indmoney_total_inr = _multiply(indmoney_total_usd, rate)

    bullpen_total_usd = None
    if summary.bullpen:
        # Bullpen wallet_value and total_value are account totals that already
        # include settled cash. Never add cash_balance a second time.
        bullpen_total_usd = (
            summary.bullpen.wallet_value
            if summary.bullpen.wallet_value is not None
            else summary.bullpen.total_value
        )
    bullpen_total_inr = _multiply(bullpen_total_usd, rate)

    combined_total_inr = (
        round(
            zerodha_total_inr + indmoney_total_inr + bullpen_total_inr,
            2,
        )
        if (
            zerodha_total_inr is not None
            and indmoney_total_inr is not None
            and bullpen_total_inr is not None
        )
        else None
    )

    return {
        "usd_inr_rate": rate,
        "zerodha_total_inr": zerodha_total_inr,
        "zerodha_source_date": (
            zerodha_snapshot.snapshot_date if zerodha_snapshot else None
        ),
        "indmoney_total_usd": indmoney_total_usd,
        "indmoney_total_inr": indmoney_total_inr,
        "indmoney_source_date": (
            indmoney_snapshot.snapshot_date if indmoney_snapshot else None
        ),
        "bullpen_total_usd": bullpen_total_usd,
        "bullpen_total_inr": bullpen_total_inr,
        "combined_total_inr": combined_total_inr,
    }


def _upsert_daily_snapshot(
    *,
    user_id: int,
    snapshot_date: date,
    captured_at: datetime,
    values: dict[str, object],
) -> None:
    with SyncSessionLocal() as db:
        row = db.scalar(
            select(DashboardPortfolioDailySnapshot).where(
                DashboardPortfolioDailySnapshot.user_id == user_id,
                DashboardPortfolioDailySnapshot.snapshot_date == snapshot_date,
            )
        )
        if row is None:
            row = DashboardPortfolioDailySnapshot(
                user_id=user_id,
                snapshot_date=snapshot_date,
                captured_at=captured_at,
            )
            db.add(row)

        row.captured_at = captured_at
        row.usd_inr_rate = values["usd_inr_rate"]
        row.zerodha_total_inr = values["zerodha_total_inr"]
        row.zerodha_source_date = values["zerodha_source_date"]
        row.zerodha_carried_forward = _is_carried_forward(
            row.zerodha_source_date,
            snapshot_date,
        )
        row.indmoney_total_usd = values["indmoney_total_usd"]
        row.indmoney_total_inr = values["indmoney_total_inr"]
        row.indmoney_source_date = values["indmoney_source_date"]
        row.indmoney_carried_forward = _is_carried_forward(
            row.indmoney_source_date,
            snapshot_date,
        )
        row.bullpen_total_usd = values["bullpen_total_usd"]
        row.bullpen_total_inr = values["bullpen_total_inr"]
        row.combined_total_inr = values["combined_total_inr"]
        db.commit()


async def _build_user_summaries(
    users: list[User],
) -> list[tuple[int, DashboardSummaryResponse]]:
    summaries: list[tuple[int, DashboardSummaryResponse]] = []
    for user in users:
        summary = await build_dashboard_summary(
            user.id,
            include_singleton_bullpen=(
                user_can_access_singleton_bullpen_runtime(user)
            ),
        )
        summaries.append((user.id, summary))
    return summaries


@celery.task(
    bind=True,
    max_retries=2,
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_jitter=True,
    soft_time_limit=120,
    time_limit=180,
)
def capture_daily_dashboard_portfolios(
    self,
    snapshot_date_iso: str | None = None,
):
    captured_at = datetime.now(UTC)
    snapshot_date = (
        date.fromisoformat(snapshot_date_iso)
        if snapshot_date_iso
        else captured_at.astimezone(INDIA_TIME_ZONE).date()
    )

    with SyncSessionLocal() as db:
        users = list(
            db.scalars(select(User).where(User.is_active.is_(True))).all()
        )

    summaries = asyncio.run(_build_user_summaries(users))
    saved_user_ids: list[int] = []
    for user_id, summary in summaries:
        _upsert_daily_snapshot(
            user_id=user_id,
            snapshot_date=snapshot_date,
            captured_at=captured_at,
            values=_portfolio_values(summary),
        )
        saved_user_ids.append(user_id)

    logger.info(
        "Saved daily dashboard portfolio snapshot for %s users on %s",
        len(saved_user_ids),
        snapshot_date,
    )
    return {
        "status": "completed",
        "snapshot_date": snapshot_date.isoformat(),
        "users": len(saved_user_ids),
    }
