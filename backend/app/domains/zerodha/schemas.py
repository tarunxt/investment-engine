from __future__ import annotations

from datetime import datetime

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
