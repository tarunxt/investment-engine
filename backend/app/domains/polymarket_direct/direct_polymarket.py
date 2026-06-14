from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable

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


async def run_direct_polymarket_json(args: list[str], *, timeout_seconds: int = 20) -> object:
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
        return PolymarketDoctorStatus(
            checked_at=utc_now(),
            ok=False,
            message=DIRECT_EXECUTION_NOT_CONFIGURED,
        )

    async def redeem(self, *, dry_run: bool) -> str:
        raise DirectPolymarketCommandError(DIRECT_EXECUTION_NOT_CONFIGURED)

    async def claim(self, *, dry_run: bool = False) -> str:
        raise DirectPolymarketCommandError(DIRECT_EXECUTION_NOT_CONFIGURED)

    async def execute(self, decision: PolymarketLiveTradeDecision) -> str:
        raise DirectPolymarketCommandError(DIRECT_EXECUTION_NOT_CONFIGURED)


class DirectPolymarketBalanceReader:
    async def refresh(self) -> PolymarketBalanceState:
        return PolymarketBalanceState(
            status="unavailable",
            message="Direct Polymarket wallet balance is unavailable until wallet/RPC execution credentials are configured.",
            checked_at=utc_now(),
        )


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
