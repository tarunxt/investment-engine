from __future__ import annotations

import os
from pathlib import Path

from app.domains.polymarket.schemas import PolymarketBotConfig


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
        if os.getenv("LIVE_UNLOCK_MODE", "").strip().lower() == "manual"
        else "automatic"
    )
    data_dir = Path(os.getenv("POLYMARKET_DATA_DIR", "data/polymarket")).expanduser()

    return PolymarketBotConfig(
        paper_trading=_bool_from_env("PAPER_TRADING", True),
        live_trading=_bool_from_env("LIVE_TRADING", False),
        use_live_reads=_bool_from_env("USE_LIVE_READS", False),
        auto_execute_live=_bool_from_env("AUTO_EXECUTE_LIVE", False),
        live_unlock_mode=live_unlock_mode,
        require_manual_confirmation=_bool_from_env("REQUIRE_MANUAL_CONFIRMATION", True),
        poll_interval_ms=_int_from_env("POLYMARKET_POLL_INTERVAL_MS", 30_000),
        max_trade_size=_float_from_env("MAX_TRADE_SIZE", 5),
        fixed_copy_trade_size=_float_from_env("FIXED_COPY_TRADE_SIZE", 5),
        max_trades_per_day=_int_from_env("MAX_TRADES_PER_DAY", 25),
        max_exposure_per_market=_float_from_env("MAX_EXPOSURE_PER_MARKET", 25),
        max_daily_loss=_float_from_env("MAX_DAILY_LOSS", 50),
        max_live_trade_size=_float_from_env("MAX_LIVE_TRADE_SIZE", 1),
        max_live_trades_per_day=_int_from_env("MAX_LIVE_TRADES_PER_DAY", 5),
        max_live_daily_loss=_float_from_env("MAX_LIVE_DAILY_LOSS", 10),
        max_live_exposure_per_market=_float_from_env("MAX_LIVE_EXPOSURE_PER_MARKET", 5),
        auto_redeem_live=_bool_from_env("AUTO_REDEEM_LIVE", False),
        jurisdiction_confirmation=_bool_from_env("JURISDICTION_CONFIRMATION", False),
        manual_tracked_wallets=os.getenv("MANUAL_TRACKED_WALLETS", ""),
        use_trending_market_activity=_bool_from_env(
            "USE_TRENDING_MARKET_ACTIVITY", False
        ),
        paused=_bool_from_env("PAUSED", False),
        max_pending_confirmations=_int_from_env("MAX_PENDING_CONFIRMATIONS", 10),
        max_new_live_proposals_per_poll=_int_from_env(
            "MAX_NEW_LIVE_PROPOSALS_PER_POLL", 3
        ),
        max_new_live_proposals_per_trader_per_poll=_int_from_env(
            "MAX_NEW_LIVE_PROPOSALS_PER_TRADER_PER_POLL", 1
        ),
        max_pending_per_trader=_int_from_env("MAX_PENDING_PER_TRADER", 2),
        proposal_cooldown_seconds_per_trader=_int_from_env(
            "PROPOSAL_COOLDOWN_SECONDS_PER_TRADER", 60
        ),
        min_source_trade_size_usd=_float_from_env("MIN_SOURCE_TRADE_SIZE_USD", 5),
        min_copy_price=_float_from_env("MIN_COPY_PRICE", 0.05),
        max_copy_price=_float_from_env("MAX_COPY_PRICE", 0.95),
        max_tracked_traders=_int_from_env("MAX_TRACKED_TRADERS", 10),
        tracked_trader_mode=os.getenv("TRACKED_TRADER_MODE", "manual_or_top_active"),
        require_manual_tracked_wallets_for_live=_bool_from_env(
            "REQUIRE_MANUAL_TRACKED_WALLETS_FOR_LIVE", False
        ),
        exclude_market_title_regex=os.getenv(
            "EXCLUDE_MARKET_TITLE_REGEX",
            "Up or Down|5m|5-minute|15m|crypto updown",
        ),
        allow_market_title_regex=os.getenv("ALLOW_MARKET_TITLE_REGEX", ""),
        exclude_trader_handle_regex=os.getenv(
            "EXCLUDE_TRADER_HANDLE_REGEX", "bot|shahai"
        ),
        allow_trader_handle_regex=os.getenv("ALLOW_TRADER_HANDLE_REGEX", ""),
        data_dir=str(data_dir),
    )
