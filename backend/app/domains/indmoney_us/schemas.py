from __future__ import annotations

from datetime import date, datetime

from typing import Literal
from pydantic import BaseModel, field_validator


class IndMoneyUsPortfolioSnapshotCreateRequest(BaseModel):
    raw_text: str
    captured_at: datetime | None = None
    format: Literal['paste','csv'] = 'paste'
    currency: Literal['USD','INR','EUR','GBP'] = 'USD'
    day_return_period: Literal['unknown','1d_same_asof'] = 'unknown'
    supersedes_id: int | None = None
    accepted_preview_id: int | None = None
    acceptance_hash: str | None = None

    @field_validator('captured_at')
    @classmethod
    def aware_time(cls,value):
        if value is not None and value.tzinfo is None: raise ValueError('As-of time requires timezone')
        return value

    @field_validator("raw_text")
    @classmethod
    def validate_raw_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("raw_text is required")
        if len(cleaned) > 200_000:
            raise ValueError("raw_text is too large")
        return value


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
    parsed_holdings_current_value: float | None = None
    parsed_holdings_invested_value: float | None = None
    parsed_holdings_total_pnl: float | None = None
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
    acceptance_state: str = 'legacy_unverified'
    parser_current: bool = False
    content_hash: str | None = None
    import_provenance: dict | None = None
    accepted_at: datetime | None = None
    supersedes_id: int | None = None
    freshness: str = 'unknown'
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


class IndMoneyUsCurrentPriceQuoteRequest(BaseModel):
    exchange: str
    symbol: str

    @field_validator("exchange", "symbol")
    @classmethod
    def validate_market_identifier(cls, value: str) -> str:
        cleaned = value.strip().upper()
        if not cleaned:
            raise ValueError("value is required")
        if len(cleaned) > 24:
            raise ValueError("value is too long")
        if not all(char.isalnum() or char in {".", "-", "_"} for char in cleaned):
            raise ValueError("value contains unsupported characters")
        return cleaned


class IndMoneyUsCurrentPricesRequest(BaseModel):
    quotes: list[IndMoneyUsCurrentPriceQuoteRequest]

    @field_validator("quotes")
    @classmethod
    def validate_quotes(cls, value: list[IndMoneyUsCurrentPriceQuoteRequest]) -> list[IndMoneyUsCurrentPriceQuoteRequest]:
        if not value:
            raise ValueError("at least one quote is required")
        if len(value) > 50:
            raise ValueError("too many quotes requested")
        return value


class IndMoneyUsCurrentPriceQuoteResponse(BaseModel):
    exchange: str
    symbol: str
    company_name: str | None = None
    currency: str | None = None
    current_price: float | None = None
    previous_close: float | None = None
    change_value: float | None = None
    change_percent: float | None = None
    market_open: bool = False
    session_open_at: datetime | None = None
    session_close_at: datetime | None = None
    error_message: str | None = None


class IndMoneyUsCurrentPricesResponse(BaseModel):
    quotes: list[IndMoneyUsCurrentPriceQuoteResponse]
    market_open: bool = False
    fetched_at: datetime


class IndMoneyImportAcceptance(BaseModel):
    content_hash: str
    accept: Literal[True]

    @field_validator('accept',mode='before')
    @classmethod
    def explicit_acceptance(cls,value):
        if value is not True:raise ValueError('Explicit boolean acceptance required')
        return value

    @field_validator('content_hash')
    @classmethod
    def valid_hash(cls,value):
        import re
        if not re.fullmatch('[a-f0-9]{64}',value):raise ValueError('Exact preview hash required')
        return value
