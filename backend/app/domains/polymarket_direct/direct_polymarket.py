from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from typing import Any

import requests

from app.domains.polymarket_direct.config import load_polymarket_config

from app.domains.polymarket_direct.schemas import (
    PolymarketBalanceState,
    PolymarketBotConfig,
    PolymarketDoctorStatus,
    PolymarketLiveTradeDecision,
    PolymarketPosition,
    PolymarketSourceTrade,
)

DIRECT_EXECUTION_NOT_CONFIGURED = (
    "Direct Polymarket execution is not configured. Configure CLOB credentials, "
    "wallet signing, and Polygon RPC settings before enabling live execution."
)

POLYMARKET_CHAIN_ID = 137
POLYMARKET_USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
POLYMARKET_GAMMA_API_BASE_URL = "https://gamma-api.polymarket.com"
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DirectPolymarketSettings:
    clob_host: str
    clob_api_key: str
    clob_secret: str
    clob_passphrase: str
    private_key: str
    signature_type: int
    funder_address: str
    polygon_rpc_url: str

    @property
    def public_funder_address(self) -> str:
        return self.funder_address


def _env(name: str) -> str:
    return os.getenv(name, "").strip()


def _load_settings() -> tuple[DirectPolymarketSettings | None, list[str]]:
    rpc = _env("POLYMARKET_DIRECT_POLYGON_RPC_URL") or next(
        (
            item.strip()
            for item in _env("POLYMARKET_POLYGON_RPC_URLS").split(",")
            if item.strip()
        ),
        "",
    )
    values = {
        "POLYMARKET_DIRECT_CLOB_HOST": _env("POLYMARKET_DIRECT_CLOB_HOST"),
        "POLYMARKET_DIRECT_CLOB_API_KEY": _env("POLYMARKET_DIRECT_CLOB_API_KEY"),
        "POLYMARKET_DIRECT_CLOB_SECRET": _env("POLYMARKET_DIRECT_CLOB_SECRET"),
        "POLYMARKET_DIRECT_CLOB_PASSPHRASE": _env("POLYMARKET_DIRECT_CLOB_PASSPHRASE"),
        "POLYMARKET_DIRECT_PRIVATE_KEY": _env("POLYMARKET_DIRECT_PRIVATE_KEY"),
        "POLYMARKET_DIRECT_SIGNATURE_TYPE": _env("POLYMARKET_DIRECT_SIGNATURE_TYPE"),
        "POLYMARKET_DIRECT_FUNDER_ADDRESS": _env("POLYMARKET_DIRECT_FUNDER_ADDRESS"),
        "POLYMARKET_DIRECT_POLYGON_RPC_URL/POLYMARKET_POLYGON_RPC_URLS": rpc,
    }
    missing = [name for name, value in values.items() if not value]
    if missing:
        return None, missing
    try:
        signature_type = int(values["POLYMARKET_DIRECT_SIGNATURE_TYPE"])
    except ValueError:
        return None, ["POLYMARKET_DIRECT_SIGNATURE_TYPE must be an integer"]
    return (
        DirectPolymarketSettings(
            clob_host=values["POLYMARKET_DIRECT_CLOB_HOST"].rstrip("/"),
            clob_api_key=values["POLYMARKET_DIRECT_CLOB_API_KEY"],
            clob_secret=values["POLYMARKET_DIRECT_CLOB_SECRET"],
            clob_passphrase=values["POLYMARKET_DIRECT_CLOB_PASSPHRASE"],
            private_key=values["POLYMARKET_DIRECT_PRIVATE_KEY"],
            signature_type=signature_type,
            funder_address=values["POLYMARKET_DIRECT_FUNDER_ADDRESS"],
            polygon_rpc_url=rpc,
        ),
        [],
    )


def _safe_error(exc: Exception) -> str:
    return (
        str(exc)
        .replace(_env("POLYMARKET_DIRECT_PRIVATE_KEY"), "[redacted]")
        .replace(_env("POLYMARKET_DIRECT_CLOB_SECRET"), "[redacted]")
    )


def _build_clob_client(settings: DirectPolymarketSettings) -> Any:
    from py_clob_client.client import ClobClient
    from py_clob_client.clob_types import ApiCreds

    client = ClobClient(
        settings.clob_host,
        key=settings.private_key,
        chain_id=POLYMARKET_CHAIN_ID,
        signature_type=settings.signature_type,
        funder=settings.funder_address,
    )
    client.set_api_creds(
        ApiCreds(
            api_key=settings.clob_api_key,
            api_secret=settings.clob_secret,
            api_passphrase=settings.clob_passphrase,
        )
    )
    return client


def _rpc_call(
    settings: DirectPolymarketSettings, method: str, params: list[Any]
) -> Any:
    response = requests.post(
        settings.polygon_rpc_url,
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        timeout=10,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("error"):
        raise DirectPolymarketCommandError(
            f"Polygon RPC error: {payload['error'].get('message', 'unknown')}"
        )
    return payload.get("result")


def _balance_of_call_data(address: str) -> str:
    clean = address.lower().replace("0x", "")
    return "0x70a08231" + clean.rjust(64, "0")


def _read_usdc_balance(settings: DirectPolymarketSettings) -> float:
    result = _rpc_call(
        settings,
        "eth_call",
        [
            {
                "to": POLYMARKET_USDC_ADDRESS,
                "data": _balance_of_call_data(settings.funder_address),
            },
            "latest",
        ],
    )
    return int(result or "0x0", 16) / 1_000_000


class DirectPolymarketCommandError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_claim_command_unavailable_warning(message: str) -> bool:
    lowered = message.lower()
    return "claim" in lowered and "not configured" in lowered


def is_redeem_metadata_lookup_warning(message: str) -> bool:
    lowered = message.lower()
    return "metadata" in lowered and ("not found" in lowered or "missing" in lowered)


def live_position_key(market_id: str, outcome: str) -> str:
    return f"{market_id}:{outcome}".lower()


async def run_direct_polymarket_json(
    args: list[str], *, timeout_seconds: int = 20
) -> object:
    raise DirectPolymarketCommandError(
        "Direct Polymarket flow does not use Bullpen/CLI commands; use Data API, Gamma API, CLOB API, or Polygon RPC providers instead."
    )


async def run_first_direct_polymarket_json(
    command_variants: Iterable[list[str]], *, timeout_seconds: int = 20
) -> object:
    raise DirectPolymarketCommandError(
        "Direct Polymarket flow does not use Bullpen/CLI commands; no direct API fallback was available."
    )


class DirectPolymarketLiveExecutor:
    async def doctor(self) -> PolymarketDoctorStatus:
        settings, missing = _load_settings()
        if not settings:
            return PolymarketDoctorStatus(
                checked_at=utc_now(),
                ok=False,
                message=f"{DIRECT_EXECUTION_NOT_CONFIGURED} Missing: {', '.join(missing)}",
            )
        try:
            client = await asyncio.to_thread(_build_clob_client, settings)
            await asyncio.to_thread(client.get_ok)
            await asyncio.to_thread(_rpc_call, settings, "eth_blockNumber", [])
        except Exception as exc:
            logger.warning("Direct Polymarket doctor failed: %s", _safe_error(exc))
            return PolymarketDoctorStatus(
                checked_at=utc_now(),
                ok=False,
                message=f"Direct Polymarket doctor failed: {_safe_error(exc)}",
            )
        return PolymarketDoctorStatus(
            checked_at=utc_now(),
            ok=True,
            message=f"Direct Polymarket execution configured for funder {settings.public_funder_address}.",
        )

    async def redeem(self, *, dry_run: bool) -> str:
        raise DirectPolymarketCommandError(DIRECT_EXECUTION_NOT_CONFIGURED)

    async def claim(self, *, dry_run: bool = False) -> str:
        raise DirectPolymarketCommandError(DIRECT_EXECUTION_NOT_CONFIGURED)

    async def execute(self, decision: PolymarketLiveTradeDecision) -> str:
        doctor = await self.doctor()
        guard = LiveTradeGuard(load_polymarket_config())
        block = guard.hard_block_reason(doctor)
        if block:
            raise DirectPolymarketCommandError(block)
        if decision.amount <= 0 or decision.price <= 0 or decision.price >= 1:
            raise DirectPolymarketCommandError("Invalid live order amount or price.")
        if decision.amount > guard.config.max_live_trade_size:
            raise DirectPolymarketCommandError(
                "Live order exceeds MAX_LIVE_TRADE_SIZE."
            )
        settings, missing = _load_settings()
        if not settings:
            raise DirectPolymarketCommandError(
                f"{DIRECT_EXECUTION_NOT_CONFIGURED} Missing: {', '.join(missing)}"
            )
        return await asyncio.to_thread(_place_order, settings, decision)


class DirectPolymarketBalanceReader:
    async def refresh(self) -> PolymarketBalanceState:
        settings, missing = _load_settings()
        if not settings:
            return PolymarketBalanceState(
                status="unavailable",
                message=f"Direct Polymarket wallet balance unavailable. Missing: {', '.join(missing)}",
                checked_at=utc_now(),
            )
        try:
            balance = await asyncio.to_thread(_read_usdc_balance, settings)
        except Exception as exc:
            logger.warning(
                "Direct Polymarket balance refresh failed: %s", _safe_error(exc)
            )
            return PolymarketBalanceState(
                status="error",
                message=f"Direct Polymarket balance refresh failed: {_safe_error(exc)}",
                checked_at=utc_now(),
            )
        return PolymarketBalanceState(
            status="ready",
            message="Direct Polymarket pUSD/USDC balance refreshed.",
            checked_at=utc_now(),
            account_value_usd=balance,
            available_balance_usd=balance,
        )


def _resolve_token_id(decision: PolymarketLiveTradeDecision) -> str:
    if decision.market_id.isdigit() and len(decision.market_id) > 20:
        return decision.market_id
    response = requests.get(
        f"{POLYMARKET_GAMMA_API_BASE_URL}/markets",
        params={"slug": decision.market_id, "limit": 1},
        timeout=10,
    )
    response.raise_for_status()
    rows = response.json()
    market = rows[0] if isinstance(rows, list) and rows else None
    if not market:
        raise DirectPolymarketCommandError(
            "Unable to resolve Polymarket token id for live order."
        )
    outcomes = market.get("outcomes")
    token_ids = market.get("clobTokenIds") or market.get("clob_token_ids")
    if isinstance(outcomes, str):
        outcomes = json.loads(outcomes)
    if isinstance(token_ids, str):
        token_ids = json.loads(token_ids)
    for outcome, token_id in zip(outcomes or [], token_ids or [], strict=False):
        if str(outcome).lower() == decision.outcome.lower():
            return str(token_id)
    raise DirectPolymarketCommandError(
        "Unable to match outcome to Polymarket token id for live order."
    )


def _place_order(
    settings: DirectPolymarketSettings, decision: PolymarketLiveTradeDecision
) -> str:
    from py_clob_client.clob_types import OrderArgs
    from py_clob_client.order_builder.constants import BUY, SELL

    client = _build_clob_client(settings)
    token_id = _resolve_token_id(decision)
    side = BUY if decision.side == "BUY" else SELL
    size = decision.shares if decision.shares > 0 else decision.amount / decision.price
    order = client.create_order(
        OrderArgs(price=decision.price, size=size, side=side, token_id=token_id)
    )
    result = client.post_order(order)
    order_id = (
        result.get("orderID") or result.get("id") if isinstance(result, dict) else None
    )
    return f"Polymarket CLOB order placed{f' order_id={order_id}' if order_id else ''}."


class LiveTradeGuard:
    def __init__(self, config: PolymarketBotConfig) -> None:
        self.config = config

    def hard_block_reason(self, doctor: PolymarketDoctorStatus) -> str | None:
        if not self.config.live_trading:
            return "Direct Polymarket live trading is disabled by configuration."
        if not doctor.ok:
            return "Direct Polymarket doctor must pass."
        return self.risk_settings_block_reason()

    def startup_block_reason(
        self,
        doctor: PolymarketDoctorStatus,
        live_unlocked: bool,
        emergency_stopped: bool,
        manually_locked: bool,
    ) -> str | None:
        if emergency_stopped:
            return "Emergency stop is active."
        hard_block = self.hard_block_reason(doctor)
        if hard_block:
            return hard_block
        if manually_locked:
            return "Live trading is manually locked."
        if not live_unlocked:
            return "Live trading is locked."
        return None

    def risk_settings_block_reason(self) -> str | None:
        if self.config.max_live_trade_size <= 0:
            return "MAX_LIVE_TRADE_SIZE must be greater than 0."
        if self.config.max_live_trade_size > self.config.fixed_copy_trade_size:
            return "MAX_LIVE_TRADE_SIZE cannot exceed FIXED_COPY_TRADE_SIZE."
        if self.config.max_live_trades_per_day <= 0:
            return "MAX_LIVE_TRADES_PER_DAY must be greater than 0."
        if self.config.max_live_daily_loss <= 0:
            return "MAX_LIVE_DAILY_LOSS must be greater than 0."
        if self.config.max_live_exposure_per_market <= 0:
            return "MAX_LIVE_EXPOSURE_PER_MARKET must be greater than 0."
        if self.config.max_live_trade_size > self.config.max_live_exposure_per_market:
            return "MAX_LIVE_TRADE_SIZE cannot exceed MAX_LIVE_EXPOSURE_PER_MARKET."
        return None

    def trade_block_reason(
        self,
        source_trade: PolymarketSourceTrade,
        live_trades: list[PolymarketLiveTradeDecision],
        positions: list[PolymarketPosition],
    ) -> str | None:
        if self.live_trades_today(live_trades) >= self.config.max_live_trades_per_day:
            return "Daily live trade limit reached."
        trader_invested_usd = (
            source_trade.trader_invested_usd
            if source_trade.trader_invested_usd is not None
            else source_trade.size_usd
        )
        if trader_invested_usd <= self.config.trader_invested_threshold_usd:
            return f"Below ${self.config.trader_invested_threshold_usd:g} threshold"
        if self.realized_live_pnl(live_trades) <= -self.config.max_live_daily_loss:
            return "Max live daily loss reached."

        position = next(
            (
                item
                for item in positions
                if item.key
                == live_position_key(source_trade.market_id, source_trade.outcome)
            ),
            None,
        )
        if source_trade.side == "SELL" and (not position or position.shares <= 0):
            return "No matching live-tracked position to sell."

        if source_trade.side == "BUY":
            current_exposure = position.cost_basis if position else 0
            next_exposure = current_exposure + min(
                self.config.fixed_copy_trade_size,
                self.config.max_live_trade_size,
                source_trade.size_usd,
            )
            if next_exposure > self.config.max_live_exposure_per_market:
                return "Max live exposure per market reached."
        return None

    def live_trades_today(self, live_trades: list[PolymarketLiveTradeDecision]) -> int:
        today = utc_now()[:10]
        return sum(
            1
            for trade in live_trades
            if trade.executed_at
            and trade.executed_at.startswith(today)
            and trade.status == "executed"
        )

    def realized_live_pnl(
        self, live_trades: list[PolymarketLiveTradeDecision]
    ) -> float:
        return sum(
            max(-trade.max_loss, 0)
            for trade in live_trades
            if trade.status == "executed" and trade.side == "SELL"
        )
