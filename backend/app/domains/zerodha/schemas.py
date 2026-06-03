from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, field_validator


class ZerodhaLoginUrlResponse(BaseModel):
    login_url: str
    configured: bool


class ZerodhaCallbackRequest(BaseModel):
    request_token: str


class ZerodhaStatusResponse(BaseModel):
    connected: bool
    login_time: datetime | None = None
    expires_at: datetime | None = None
    last_portfolio_sync_at: datetime | None = None
    last_portfolio_snapshot_date: date | None = None


class ZerodhaPlaceOrderRequest(BaseModel):
    tradingsymbol: str
    exchange: str          # NSE | BSE | NFO | CDS | BCD | BFO | MCX
    transaction_type: str  # BUY | SELL
    order_type: str        # MARKET | LIMIT | SL | SL-M
    quantity: int
    product: str           # CNC | MIS | NRML
    validity: str = "DAY"  # DAY | IOC | TTL
    price: float = 0
    trigger_price: float = 0
    market_protection: float = 0

    @field_validator("quantity")
    @classmethod
    def quantity_positive(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("quantity must be positive")
        return v

    @field_validator("transaction_type")
    @classmethod
    def validate_transaction_type(cls, v: str) -> str:
        if v not in ("BUY", "SELL"):
            raise ValueError("transaction_type must be BUY or SELL")
        return v

    @field_validator("order_type")
    @classmethod
    def validate_order_type(cls, v: str) -> str:
        if v not in ("MARKET", "LIMIT", "SL", "SL-M"):
            raise ValueError("order_type must be MARKET, LIMIT, SL, or SL-M")
        return v


class ZerodhaPlaceOrderResponse(BaseModel):
    order_id: str


class ZerodhaPortfolioHolding(BaseModel):
    tradingsymbol: str
    exchange: str
    instrument_token: int | None = None
    isin: str | None = None
    product: str | None = None
    quantity: int = 0
    used_quantity: int = 0
    t1_quantity: int = 0
    realised_quantity: int = 0
    authorised_quantity: int = 0
    authorised_date: str | None = None
    opening_quantity: int = 0
    short_quantity: int = 0
    collateral_quantity: int = 0
    collateral_type: str | None = None
    discrepancy: bool = False
    average_price: float = 0
    last_price: float = 0
    close_price: float = 0
    pnl: float = 0
    day_change: float = 0
    day_change_percentage: float = 0
    market_value: float = 0
    invested_value: float = 0
    day_change_value: float = 0


class ZerodhaPortfolioPosition(BaseModel):
    tradingsymbol: str
    exchange: str
    instrument_token: int | None = None
    product: str | None = None
    quantity: int = 0
    overnight_quantity: int = 0
    multiplier: float = 0
    average_price: float = 0
    close_price: float = 0
    last_price: float = 0
    value: float = 0
    pnl: float = 0
    m2m: float = 0
    unrealised: float = 0
    realised: float = 0
    buy_quantity: int = 0
    buy_price: float = 0
    buy_value: float = 0
    buy_m2m: float = 0
    sell_quantity: int = 0
    sell_price: float = 0
    sell_value: float = 0
    sell_m2m: float = 0
    day_buy_quantity: int = 0
    day_buy_price: float = 0
    day_buy_value: float = 0
    day_sell_quantity: int = 0
    day_sell_price: float = 0
    day_sell_value: float = 0


class ZerodhaPortfolioPositions(BaseModel):
    net: list[ZerodhaPortfolioPosition]
    day: list[ZerodhaPortfolioPosition]


class ZerodhaPortfolioSnapshotSummaryResponse(BaseModel):
    snapshot_date: date
    captured_at: datetime
    source: str
    holdings_count: int
    net_positions_count: int
    day_positions_count: int
    holdings_market_value: float
    holdings_pnl: float
    holdings_day_change_value: float
    available_margin: float = 0
    positions_pnl: float
    positions_m2m: float


class ZerodhaPortfolioSnapshotDetailResponse(ZerodhaPortfolioSnapshotSummaryResponse):
    holdings: list[ZerodhaPortfolioHolding]
    positions: ZerodhaPortfolioPositions


class ZerodhaPortfolioOverviewResponse(BaseModel):
    latest: ZerodhaPortfolioSnapshotDetailResponse | None = None
    history: list[ZerodhaPortfolioSnapshotSummaryResponse]


class ZerodhaPortfolioSyncResponse(BaseModel):
    status: str
    message: str
    snapshot_date: date
    task_id: str | None = None
