from __future__ import annotations

from datetime import UTC, date, datetime

from app.domains.dashboard.models import DashboardPortfolioDailySnapshot
from app.domains.dashboard.schemas import (
    DashboardBullpenSection,
    DashboardFxRate,
    DashboardIndMoneySection,
    DashboardIndMoneySnapshot,
    DashboardSummaryResponse,
    DashboardZerodhaSection,
    DashboardZerodhaSnapshot,
)
from app.domains.dashboard.tasks import (
    _is_carried_forward,
    _portfolio_values,
)


def _summary() -> DashboardSummaryResponse:
    now = datetime.now(UTC)
    return DashboardSummaryResponse(
        generated_at=now,
        usd_inr_rate=100,
        usd_inr_source="test",
        usd_inr_as_of=now,
        usd_inr_age_seconds=0,
        usd_inr_status="valid",
        fx=DashboardFxRate(
            value=100,
            source="test",
            as_of=now,
            age_seconds=0,
            stale_after_seconds=36 * 60 * 60,
            status="valid",
        ),
        zerodha=DashboardZerodhaSection(
            connected=False,
            snapshot=DashboardZerodhaSnapshot(
                snapshot_date=date(2026, 8, 21),
                captured_at=now,
                source="scheduled",
                holdings_count=1,
                holdings_market_value=100,
                holdings_invested_value=90,
                holdings_pnl=10,
                holdings_day_change_value=1,
                available_margin=20,
                top_holdings=[],
                history=[],
            ),
        ),
        indmoney_us=DashboardIndMoneySection(
            snapshot=DashboardIndMoneySnapshot(
                snapshot_date=date(2026, 8, 21),
                captured_at=now,
                source="manual",
                parse_status="parsed",
                holdings_count=1,
                wallet_balance=2,
                current_value=10,
                top_holdings=[],
                history=[],
            )
        ),
        bullpen=DashboardBullpenSection(
            cash_balance=5,
            total_value=49,
            wallet_value=50,
            fetched_at=now,
        ),
        sections={},
    )


def test_daily_snapshot_values_include_cash_once_and_convert_to_inr():
    values = _portfolio_values(_summary())

    assert values["zerodha_total_inr"] == 120
    assert values["indmoney_total_usd"] == 12
    assert values["indmoney_total_inr"] == 1200
    assert values["bullpen_total_usd"] == 50
    assert values["bullpen_total_inr"] == 5000
    assert values["combined_total_inr"] == 6320


def test_closed_market_values_are_explicitly_marked_carried_forward():
    friday = date(2026, 8, 21)
    saturday = date(2026, 8, 22)
    sunday = date(2026, 8, 23)

    assert _is_carried_forward(friday, saturday) is True
    assert _is_carried_forward(friday, sunday) is True
    assert _is_carried_forward(friday, friday) is False
    assert _is_carried_forward(None, sunday) is False


def test_daily_snapshot_is_idempotent_per_user_and_date():
    constraint_names = {
        constraint.name
        for constraint in DashboardPortfolioDailySnapshot.__table__.constraints
    }
    assert "uq_dashboard_portfolio_daily_snapshots_user_date" in constraint_names
