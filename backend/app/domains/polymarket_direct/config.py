from __future__ import annotations

import os
from pathlib import Path

from app.domains.polymarket_direct.schemas import PolymarketBotConfig


def _bool_from_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() == "true"


def _int_from_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if not value:
        return default
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


def _float_from_env(name: str, default: float) -> float:
    value = os.getenv(name)
    if not value:
        return default
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


def load_polymarket_config() -> PolymarketBotConfig:
    live_unlock_mode = (
        "manual"
        if os.getenv("POLYMARKET_DIRECT_LIVE_UNLOCK_MODE", os.getenv("LIVE_UNLOCK_MODE", "")).strip().lower() == "manual"
        else "automatic"
    )
    data_dir = Path(os.getenv("POLYMARKET_DIRECT_DATA_DIR", "data/polymarket-direct")).expanduser()

    return PolymarketBotConfig(
        paper_trading=_bool_from_env("POLYMARKET_DIRECT_PAPER_TRADING", False),
        live_trading=_bool_from_env("POLYMARKET_DIRECT_LIVE_TRADING", True),
        use_live_reads=_bool_from_env("POLYMARKET_DIRECT_USE_LIVE_READS", True),
        # Live-read trades should never wait for manual dashboard approval.
        # Keep the public config field for API compatibility, but force auto execution.
        auto_execute_live=True,
        auto_start=_bool_from_env("POLYMARKET_DIRECT_AUTO_START", True),
        live_unlock_mode=live_unlock_mode,
        require_manual_confirmation=False,
        poll_interval_ms=_int_from_env("POLYMARKET_DIRECT_POLL_INTERVAL_MS", 30_000),
        max_trade_size=_float_from_env("POLYMARKET_DIRECT_MAX_TRADE_SIZE", 1),
        fixed_copy_trade_size=_float_from_env("POLYMARKET_DIRECT_FIXED_COPY_TRADE_SIZE", 1),
        max_trades_per_day=_int_from_env("POLYMARKET_DIRECT_MAX_TRADES_PER_DAY", 25),
        max_exposure_per_market=_float_from_env("POLYMARKET_DIRECT_MAX_EXPOSURE_PER_MARKET", 25),
        max_daily_loss=_float_from_env("POLYMARKET_DIRECT_MAX_DAILY_LOSS", 50),
        max_live_trade_size=_float_from_env("POLYMARKET_DIRECT_MAX_LIVE_TRADE_SIZE", 1),
        max_live_trades_per_day=_int_from_env("POLYMARKET_DIRECT_MAX_LIVE_TRADES_PER_DAY", 150),
        trader_invested_threshold_usd=_float_from_env(
            "POLYMARKET_DIRECT_TRADER_INVESTED_THRESHOLD_USD", 100
        ),
        max_live_daily_loss=_float_from_env("POLYMARKET_DIRECT_MAX_LIVE_DAILY_LOSS", 10),
        max_live_exposure_per_market=_float_from_env("POLYMARKET_DIRECT_MAX_LIVE_EXPOSURE_PER_MARKET", 5),
        auto_redeem_live=_bool_from_env("POLYMARKET_DIRECT_AUTO_REDEEM_LIVE", True),
        jurisdiction_confirmation=True,
        manual_tracked_wallets=os.getenv("POLYMARKET_DIRECT_MANUAL_TRACKED_WALLETS", ""),
        use_trending_market_activity=_bool_from_env(
            "POLYMARKET_DIRECT_USE_TRENDING_MARKET_ACTIVITY", False
        ),
        paused=_bool_from_env("POLYMARKET_DIRECT_PAUSED", False),
        max_pending_confirmations=_int_from_env("POLYMARKET_DIRECT_MAX_PENDING_CONFIRMATIONS", 10),
        max_new_live_proposals_per_poll=_int_from_env(
            "POLYMARKET_DIRECT_MAX_NEW_LIVE_PROPOSALS_PER_POLL", 3
        ),
        max_new_live_proposals_per_trader_per_poll=_int_from_env(
            "POLYMARKET_DIRECT_MAX_NEW_LIVE_PROPOSALS_PER_TRADER_PER_POLL", 1
        ),
        max_pending_per_trader=_int_from_env("POLYMARKET_DIRECT_MAX_PENDING_PER_TRADER", 2),
        proposal_cooldown_seconds_per_trader=_int_from_env(
            "POLYMARKET_DIRECT_PROPOSAL_COOLDOWN_SECONDS_PER_TRADER", 60
        ),
        min_source_trade_size_usd=_float_from_env("POLYMARKET_DIRECT_MIN_SOURCE_TRADE_SIZE_USD", 5),
        min_copy_price=_float_from_env("POLYMARKET_DIRECT_MIN_COPY_PRICE", 0.05),
        max_copy_price=_float_from_env("POLYMARKET_DIRECT_MAX_COPY_PRICE", 0.95),
        max_tracked_traders=_int_from_env("POLYMARKET_DIRECT_MAX_TRACKED_TRADERS", 200),
        tracked_trader_mode=os.getenv("POLYMARKET_DIRECT_TRACKED_TRADER_MODE", "manual_or_top_active"),
        require_manual_tracked_wallets_for_live=_bool_from_env(
            "POLYMARKET_DIRECT_REQUIRE_MANUAL_TRACKED_WALLETS_FOR_LIVE", False
        ),
        exclude_market_title_regex=os.getenv(
            "POLYMARKET_DIRECT_EXCLUDE_MARKET_TITLE_REGEX",
            "Up or Down|5m|5-minute|15m|crypto updown",
        ),
        allow_market_title_regex=os.getenv("POLYMARKET_DIRECT_ALLOW_MARKET_TITLE_REGEX", ""),
        exclude_trader_handle_regex=os.getenv(
            "POLYMARKET_DIRECT_EXCLUDE_TRADER_HANDLE_REGEX", "bot|shahai"
        ),
        allow_trader_handle_regex=os.getenv("POLYMARKET_DIRECT_ALLOW_TRADER_HANDLE_REGEX", ""),
        data_dir=str(data_dir),
    )
