from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, field_validator


class IndMoneyUsPortfolioSnapshotCreateRequest(BaseModel):
    raw_text: str
    captured_at: datetime | None = None

    @field_validator("raw_text")
    @classmethod
    def validate_raw_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("raw_text is required")
        if len(cleaned) > 200_000:
            raise ValueError("raw_text is too large")
        return cleaned


class IndMoneyUsMarketIndex(BaseModel):
    name: str
    value: float | None = None
    change_value: float | None = None
    change_percent: float | None = None
    raw_change_text: str | None = None


class IndMoneyUsHolding(BaseModel):
    company_name: str
    symbol: str
    market_price: float | None = None
    market_change_percent: float | None = None
    invested_value: float | None = None
    quantity: float | None = None
    average_price: float | None = None
    current_value: float | None = None
    total_pnl: float | None = None
    total_pnl_percent: float | None = None
    portfolio_weight_percent: float | None = None
    price_vs_average_percent: float | None = None


class IndMoneyUsReconciliationItem(BaseModel):
    label: str
    summary_value: float | None = None
    parsed_value: float | None = None
    delta: float | None = None


class IndMoneyUsDerivedAnalytics(BaseModel):
    parsed_holdings_current_value: float = 0
    parsed_holdings_invested_value: float = 0
    parsed_holdings_total_pnl: float = 0
    profitable_holdings_count: int = 0
    loss_making_holdings_count: int = 0
    top_allocations: list[IndMoneyUsHolding]
    top_gainers: list[IndMoneyUsHolding]
    top_laggards: list[IndMoneyUsHolding]
    reconciliation: list[IndMoneyUsReconciliationItem]


class IndMoneyUsPortfolioSnapshotSummaryResponse(BaseModel):
    id: int
    snapshot_date: date
    captured_at: datetime
    source: str
    parse_status: str
    parse_warnings: list[str]
    holdings_count: int
    reported_holdings_count: int | None = None
    indices_count: int
    wallet_balance: float | None = None
    current_value: float | None = None
    invested_value: float | None = None
    day_return_value: float | None = None
    day_return_percent: float | None = None
    total_return_value: float | None = None
    total_return_percent: float | None = None


class IndMoneyUsPortfolioSnapshotDetailResponse(IndMoneyUsPortfolioSnapshotSummaryResponse):
    raw_text: str
    market_indices: list[IndMoneyUsMarketIndex]
    holdings: list[IndMoneyUsHolding]
    derived: IndMoneyUsDerivedAnalytics


class IndMoneyUsPortfolioOverviewResponse(BaseModel):
    latest: IndMoneyUsPortfolioSnapshotDetailResponse | None = None
    history: list[IndMoneyUsPortfolioSnapshotSummaryResponse]
