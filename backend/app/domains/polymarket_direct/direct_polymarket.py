from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable

from app.domains.polymarket_direct.schemas import (
    PolymarketBalanceState,
    PolymarketBotConfig,
    PolymarketDoctorStatus,
    PolymarketLiveTradeDecision,
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
        return None

    def startup_block_reason(
        self,
        doctor: PolymarketDoctorStatus,
        live_unlocked: bool,
        emergency_stopped: bool,
        manually_locked: bool,
    ) -> str | None:
        hard_block = self.hard_block_reason(doctor)
        if hard_block:
            return hard_block
        if emergency_stopped:
            return "Emergency stop is active."
        if manually_locked:
            return "Live trading is manually locked."
        if not live_unlocked:
            return "Live trading is locked."
        return None

    def trade_block_reason(
        self,
        doctor: PolymarketDoctorStatus,
        live_unlocked: bool,
        emergency_stopped: bool,
        manually_locked: bool,
        live_trades_today: int,
    ) -> str | None:
        startup = self.startup_block_reason(
            doctor, live_unlocked, emergency_stopped, manually_locked
        )
        if startup:
            return startup
        if live_trades_today >= self.config.max_live_trades_per_day:
            return "Daily live trade limit reached."
        return None
