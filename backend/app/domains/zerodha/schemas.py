from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator, model_validator


class ZerodhaLoginUrlResponse(BaseModel):
    login_url: str
    configured: bool
    direct_market_orders_enabled: bool = False
    order_submission_blocked_reason: str | None = None


class ZerodhaCallbackRequest(BaseModel):
    request_token: str


class ZerodhaStatusResponse(BaseModel):
    connected: bool
    direct_market_orders_enabled: bool = False
    order_submission_blocked_reason: str | None = None
    login_time: datetime | None = None
    expires_at: datetime | None = None
    last_portfolio_sync_at: datetime | None = None
    last_portfolio_snapshot_date: date | None = None


class ZerodhaPlaceOrderRequest(BaseModel):
    tradingsymbol: str
    exchange: str  # NSE | BSE | NFO | CDS | BCD | BFO | MCX
    transaction_type: str  # BUY | SELL
    order_type: str  # MARKET | LIMIT | SL | SL-M
    quantity: int
    product: str  # CNC | MIS | NRML
    validity: str = "DAY"  # DAY | IOC | TTL
    price: float = 0
    trigger_price: float = 0
    market_protection: float = 0
    variety: str = "regular"  # regular | amo
    auto_amo_when_closed: bool = True

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

    @field_validator("market_protection", mode="before")
    @classmethod
    def validate_market_protection_type(cls, v):
        if isinstance(v, bool):
            raise ValueError(
                "market_protection must be -1 or a percentage from >0 to 100"
            )
        return v

    @model_validator(mode="after")
    def validate_order_prices_and_protection(self):
        if self.order_type in ("MARKET", "SL-M"):
            if self.market_protection == 0:
                self.market_protection = -1
            elif self.market_protection != -1 and not (
                0 < self.market_protection <= 100
            ):
                raise ValueError(
                    "market_protection must be -1 or a percentage from >0 to 100"
                )
            if self.order_type == "MARKET":
                self.price = 0
        elif self.market_protection not in (0, -1) and not (
            0 < self.market_protection <= 100
        ):
            raise ValueError(
                "market_protection must be -1 or a percentage from >0 to 100"
            )
        return self

    @field_validator("variety")
    @classmethod
    def validate_variety(cls, v: str) -> str:
        normalized = v.lower()
        if normalized not in ("regular", "amo"):
            raise ValueError("variety must be regular or amo")
        return normalized


class ZerodhaPlaceOrderResponse(BaseModel):
    order_id: str
    variety: str = "regular"
    market_open: bool = True
    auto_converted_to_amo: bool = False


class ZerodhaPrepareBasketOrderRequest(BaseModel):
    tradingsymbol: str
    exchange: str
    transaction_type: str
    quantity: int
    price: float
    last_price: float | None = None

    @field_validator("quantity")
    @classmethod
    def quantity_positive(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("quantity must be positive")
        return v

    @field_validator("transaction_type")
    @classmethod
    def validate_transaction_type(cls, v: str) -> str:
        normalized = v.upper()
        if normalized not in ("BUY", "SELL"):
            raise ValueError("transaction_type must be BUY or SELL")
        return normalized


class ZerodhaPrepareBasketRequest(BaseModel):
    orders: list[ZerodhaPrepareBasketOrderRequest]


class ZerodhaPreparedBasketOrder(BaseModel):
    tradingsymbol: str
    exchange: str
    transaction_type: str
    quantity: int
    requested_price: float
    price: float
    last_price: float
    tick_size: float
    lower_circuit_limit: float | None = None
    upper_circuit_limit: float | None = None
    adjusted: bool
    reasons: list[str] = Field(default_factory=list)


class ZerodhaPrepareBasketResponse(BaseModel):
    orders: list[ZerodhaPreparedBasketOrder]
    adjusted_count: int


class ZerodhaProtectedMarketOrderRequest(BaseModel):
    tradingsymbol: str
    exchange: str
    transaction_type: str
    quantity: int
    product: str = "CNC"
    validity: str = "DAY"
    market_protection: str = "-1"
    estimated_price: float | None = Field(default=None, gt=0)
    last_price: float | None = Field(default=None, gt=0)

    @field_validator("quantity")
    @classmethod
    def protected_quantity_positive(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("quantity must be positive")
        return v

    @field_validator("exchange")
    @classmethod
    def validate_protected_exchange(cls, v: str) -> str:
        normalized = v.upper()
        if normalized not in ("NSE", "BSE"):
            raise ValueError("exchange must be NSE or BSE")
        return normalized

    @field_validator("transaction_type")
    @classmethod
    def validate_protected_transaction_type(cls, v: str) -> str:
        normalized = v.upper()
        if normalized not in ("BUY", "SELL"):
            raise ValueError("transaction_type must be BUY or SELL")
        return normalized

    @field_validator("market_protection", mode="before")
    @classmethod
    def validate_protected_market_protection(cls, v):
        if isinstance(v, bool):
            raise ValueError("market_protection must be a decimal string, not boolean")
        text = str(v).strip()
        if text in ("", "0", "0.0"):
            raise ValueError("market_protection must be -1 or a positive percentage")
        if text != "-1":
            value = float(text)
            if value <= 0 or value > 100:
                raise ValueError("market_protection must be -1 or a positive percentage up to 100")
        return text


class ZerodhaProtectedMarketRequest(BaseModel):
    orders: list[ZerodhaProtectedMarketOrderRequest]


class ZerodhaProtectedMarketOrderResult(BaseModel):
    tradingsymbol: str
    exchange: str
    transaction_type: str
    quantity: int
    status: str
    order_id: str | None = None
    average_price: float | None = None
    error: str | None = None


class ZerodhaProtectedMarketResponse(BaseModel):
    results: list[ZerodhaProtectedMarketOrderResult]
    placed_count: int
    failed_count: int


class ZerodhaSequencedProtectedMarketRequest(BaseModel):
    orders: list[ZerodhaProtectedMarketOrderRequest]
    sell_first: bool = True
    wait_for_sell_completion: bool = True
    sell_wait_timeout_seconds: int = Field(default=60, ge=1, le=300)
    poll_interval_seconds: float = Field(default=2.0, ge=0.5, le=10.0)
    safety_buffer_amount: float | None = Field(default=None, ge=0)


class ZerodhaSequencedProtectedMarketResponse(BaseModel):
    sell_results: list[ZerodhaProtectedMarketOrderResult] = Field(default_factory=list)
    buy_results: list[ZerodhaProtectedMarketOrderResult] = Field(default_factory=list)
    skipped_buy_results: list[ZerodhaProtectedMarketOrderResult] = Field(default_factory=list)
    placed_count: int
    failed_count: int
    skipped_count: int
    sell_phase_complete: bool
    buy_phase_attempted: bool
    refreshed_available_margin: float | None = None
    messages: list[str] = Field(default_factory=list)


class ZerodhaPortfolioHolding(BaseModel):
    tradingsymbol: str
    exchange: str
    instrument_token: int | None = None
    isin: str | None = None
    product: str | None = None
    quantity: int | None = None
    used_quantity: int | None = None
    t1_quantity: int | None = None
    realised_quantity: int | None = None
    authorised_quantity: int | None = None
    authorised_date: str | None = None
    opening_quantity: int | None = None
    short_quantity: int | None = None
    collateral_quantity: int | None = None
    collateral_type: str | None = None
    discrepancy: bool = False
    average_price: float | None = None
    last_price: float | None = None
    close_price: float | None = None
    pnl: float | None = None
    day_change: float | None = None
    day_change_percentage: float | None = None
    market_value: float | None = None
    invested_value: float | None = None
    day_change_value: float | None = None


class ZerodhaPortfolioPosition(BaseModel):
    tradingsymbol: str
    exchange: str
    instrument_token: int | None = None
    product: str | None = None
    quantity: int | None = None
    overnight_quantity: int | None = None
    multiplier: float | None = None
    average_price: float | None = None
    close_price: float | None = None
    last_price: float | None = None
    value: float | None = None
    pnl: float | None = None
    m2m: float | None = None
    unrealised: float | None = None
    realised: float | None = None
    buy_quantity: int | None = None
    buy_price: float | None = None
    buy_value: float | None = None
    buy_m2m: float | None = None
    sell_quantity: int | None = None
    sell_price: float | None = None
    sell_value: float | None = None
    sell_m2m: float | None = None
    day_buy_quantity: int | None = None
    day_buy_price: float | None = None
    day_buy_value: float | None = None
    day_sell_quantity: int | None = None
    day_sell_price: float | None = None
    day_sell_value: float | None = None


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
    holdings_invested_value: float | None = None
    holdings_pnl: float
    holdings_day_change_value: float
    available_margin: float | None = None
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
