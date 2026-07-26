from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


class DashboardSectionMeta(BaseModel):
    status: Literal["ok", "unavailable"]
    duration_ms: float = Field(ge=0)
    fresh_at: datetime | None = None
    error: str | None = None


class DashboardHistoryPoint(BaseModel):
    captured_at: datetime
    value: float


class DashboardHolding(BaseModel):
    symbol: str
    company_name: str | None = None
    current_value: float = 0
    invested_value: float = 0
    pnl: float = 0
    pnl_percent: float = 0
    weight_percent: float | None = None


class DashboardZerodhaSnapshot(BaseModel):
    snapshot_date: date
    captured_at: datetime
    source: str
    holdings_count: int
    holdings_market_value: float
    holdings_invested_value: float
    holdings_pnl: float
    holdings_day_change_value: float
    available_margin: float
    top_holdings: list[DashboardHolding] = Field(max_length=4)
    history: list[DashboardHistoryPoint] = Field(max_length=12)


class DashboardZerodhaSection(BaseModel):
    connected: bool
    login_time: datetime | None = None
    expires_at: datetime | None = None
    snapshot: DashboardZerodhaSnapshot | None = None


class DashboardIndMoneySnapshot(BaseModel):
    snapshot_date: date
    captured_at: datetime
    source: str
    parse_status: str
    holdings_count: int
    wallet_balance: float | None = None
    current_value: float | None = None
    invested_value: float | None = None
    day_return_value: float | None = None
    day_return_percent: float | None = None
    total_return_value: float | None = None
    total_return_percent: float | None = None
    top_holdings: list[DashboardHolding] = Field(max_length=4)
    history: list[DashboardHistoryPoint] = Field(max_length=12)


class DashboardIndMoneySection(BaseModel):
    snapshot: DashboardIndMoneySnapshot | None = None


class DashboardBullpenSection(BaseModel):
    active_count: int = 0
    claimable_count: int = 0
    claimable_value: float = 0
    cash_balance: float | None = None
    total_value: float | None = None
    unrealized_pnl: float | None = None
    wallet_value: float | None = None
    fetched_at: datetime | None = None
    source: Literal["redis-cache"] = "redis-cache"


class DashboardSummaryResponse(BaseModel):
    schema_version: Literal[1] = 1
    generated_at: datetime
    usd_inr_rate: float
    usd_inr_source: Literal["bounded-fallback"] = "bounded-fallback"
    zerodha: DashboardZerodhaSection | None = None
    indmoney_us: DashboardIndMoneySection | None = None
    bullpen: DashboardBullpenSection | None = None
    sections: dict[str, DashboardSectionMeta]
