from __future__ import annotations

from dataclasses import dataclass

from app.domains.polymarket.bullpen import BullpenBalanceReader, BullpenLiveExecutor
from app.domains.polymarket.schemas import PolymarketBalanceState, PolymarketDoctorStatus
from app.domains.polymarket.service import polymarket_bot_manager
from app.domains.polymarket_auto_live.repository import (
    AsyncPolymarketAutoLiveRepository,
    record_to_settings,
    record_to_state,
)
from app.domains.polymarket_auto_live.scanner import ScannedMarket, fetch_market_by_slug
from app.infrastructure.database.session import AsyncSessionLocal

AUTO_LIVE_UNLOCK_BYPASS_REASONS = {
    "paper_trading must be false",
    "dashboard live unlock is required",
}


@dataclass
class RefreshedExecutionQuote:
    market: ScannedMarket | None
    current_price_cents: float | None
    spread_cents: float | None


@dataclass
class RefreshedLiveControls:
    unlocked: bool
    unlock_mode: str
    locked_reason: str | None
    emergency_stopped: bool
    doctor: PolymarketDoctorStatus
    balance: PolymarketBalanceState


@dataclass
class RuntimeExecutionSettings:
    auto_live_enabled: bool
    dry_run: bool
    allow_live_execution: bool
    emergency_stop: bool
    paused: bool
    running: bool


async def refresh_execution_quote(
    *,
    slug: str | None,
    side: str,
) -> RefreshedExecutionQuote:
    if not slug:
        return RefreshedExecutionQuote(market=None, current_price_cents=None, spread_cents=None)
    market = await fetch_market_by_slug(slug)
    if market is None:
        return RefreshedExecutionQuote(market=None, current_price_cents=None, spread_cents=None)
    current_price = market.current_yes_odds if side == "YES" else market.current_no_odds
    return RefreshedExecutionQuote(
        market=market,
        current_price_cents=current_price,
        spread_cents=market.spread_cents,
    )


def buy_limit_price_cents(
    *,
    current_price_cents: float,
    original_price_cents: float,
    max_slippage_cents: float,
) -> float:
    ceiling = original_price_cents + max_slippage_cents
    return round(min(99, min(current_price_cents, ceiling)), 2)


def sell_limit_price_cents(
    *,
    current_price_cents: float,
    original_price_cents: float,
    max_slippage_cents: float,
) -> float:
    floor = max(1, original_price_cents - max_slippage_cents)
    return round(max(floor, min(current_price_cents, 99)), 2)


def cents_to_decimal(cents: float) -> float:
    return round(cents / 100, 4)


def _normalize_locked_reason(reason: str | None) -> str | None:
    if reason is None:
        return None
    normalized = reason.strip().lower()
    return normalized[:-1] if normalized.endswith(".") else normalized


async def refresh_live_controls(*, user_id: int) -> RefreshedLiveControls:
    bot = await polymarket_bot_manager.get_bot(user_id)
    await bot.refresh_doctor()
    await bot.refresh_balance()
    state = await bot.get_state()
    unlocked = state.live.unlocked
    unlock_mode = state.live.unlock_mode
    locked_reason = state.live.locked_reason

    # Auto-Live has its own explicit live-execution arming controls. Do not let
    # the copy-trading bot's paper-mode or dashboard-unlock state block Stage 3
    # after the live env, health checks, and emergency/manual locks pass.
    runtime_settings = await refresh_runtime_execution_settings(user_id=user_id)
    auto_live_can_self_authorize = (
        runtime_settings.auto_live_enabled
        and runtime_settings.allow_live_execution
        and not runtime_settings.dry_run
        and not runtime_settings.emergency_stop
        and not runtime_settings.paused
        and not state.live.emergency_stopped
        and not state.live.manually_locked
        and state.live.doctor.ok
        and state.live.balance.status == "ready"
    )
    normalized_locked_reason = _normalize_locked_reason(locked_reason)
    if normalized_locked_reason in AUTO_LIVE_UNLOCK_BYPASS_REASONS:
        if auto_live_can_self_authorize:
            unlocked = True
            unlock_mode = "automatic"
            locked_reason = None
        elif normalized_locked_reason == "paper_trading must be false":
            locked_reason = "Dashboard live unlock is required."

    return RefreshedLiveControls(
        unlocked=unlocked,
        unlock_mode=unlock_mode,
        locked_reason=locked_reason,
        emergency_stopped=state.live.emergency_stopped,
        doctor=state.live.doctor,
        balance=state.live.balance,
    )


async def refresh_doctor() -> PolymarketDoctorStatus:
    return await BullpenLiveExecutor().doctor()


async def refresh_balance(*, wait_for_login: bool = False) -> PolymarketBalanceState:
    return await BullpenBalanceReader().refresh(wait_for_login=wait_for_login)


async def refresh_runtime_execution_settings(*, user_id: int) -> RuntimeExecutionSettings:
    async with AsyncSessionLocal() as session:
        repo = AsyncPolymarketAutoLiveRepository(session)
        settings = record_to_settings(await repo.get_settings_record(user_id))
        state = record_to_state(await repo.get_state_record(user_id))
    return RuntimeExecutionSettings(
        auto_live_enabled=settings.auto_live_enabled,
        dry_run=settings.dry_run,
        allow_live_execution=settings.allow_live_execution,
        emergency_stop=settings.emergency_stop,
        paused=state.paused,
        running=state.running,
    )
