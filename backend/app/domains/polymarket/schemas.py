from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

BotMode = Literal["mock", "live-read", "live-trading"]
TradeSide = Literal["BUY", "SELL"]
TradeSource = Literal["mock", "live-read", "live-market-read"]
LiveTradeStatus = Literal[
    "proposed", "confirmed", "rejected", "executed", "failed", "skipped"
]
LiveUnlockMode = Literal["locked", "automatic", "manual"]
BalanceStatus = Literal["idle", "loading", "ready", "unavailable", "error"]
ActivitySource = Literal["wallet", "handle", "feed", "fallback"]


TrackingSource = Literal["manual", "leaderboard"]


class PolymarketTrackedAccount(BaseModel):
    id: str
    target: str = Field(min_length=1, max_length=180)
    handle: str | None = None
    address: str = ""
    profile_url: str | None = None
    proxy_wallet: str | None = None
    enabled: bool = True
    threshold_percent: float = Field(default=5, ge=0, le=100)
    net_worth_usd: float = Field(default=100, ge=0)
    positions_value_usd: float | None = Field(default=None, ge=0)
    cash_balance_usd: float | None = Field(default=None, ge=0)
    redeemable_value_usd: float | None = Field(default=None, ge=0)
    tracking_source: TrackingSource = "manual"
    net_worth_source: str | None = None
    net_worth_checked_at: str | None = None
    net_worth_error: str | None = None
    copy_trade_usd: float = Field(default=1, ge=0.01, le=1)
    created_at: str
    updated_at: str
    deleted_at: str | None = None


class PolymarketTrackedAccountCreate(BaseModel):
    target: str = Field(min_length=1, max_length=180)
    threshold_percent: float = Field(default=5, ge=0, le=100)
    net_worth_usd: float = Field(default=100, ge=0)
    copy_trade_usd: float = Field(default=1, ge=0.01, le=1)
    enabled: bool = True

    @field_validator("target")
    @classmethod
    def strip_target(cls, value: str) -> str:
        return value.strip()


class PolymarketLiveLimitUpdate(BaseModel):
    max_live_trades_per_day: int = Field(ge=1, le=1000)
    trader_invested_threshold_usd: float = Field(default=500, ge=0)


class PolymarketTrackedAccountUpdate(BaseModel):
    target: str | None = Field(default=None, min_length=1, max_length=180)
    threshold_percent: float | None = Field(default=None, ge=0, le=100)
    net_worth_usd: float | None = Field(default=None, ge=0)
    copy_trade_usd: float | None = Field(default=None, ge=0.01, le=1)
    enabled: bool | None = None

    @field_validator("target")
    @classmethod
    def strip_target(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else value


class PolymarketUserConfigOverride(BaseModel):
    max_live_trades_per_day: int = Field(ge=1, le=1000)
    trader_invested_threshold_usd: float = Field(default=500, ge=0)


class PolymarketBotConfig(BaseModel):
    paper_trading: bool
    live_trading: bool
    use_live_reads: bool
    auto_execute_live: bool
    auto_start: bool
    live_unlock_mode: Literal["automatic", "manual"]
    require_manual_confirmation: bool
    poll_interval_ms: int
    max_trade_size: float
    fixed_copy_trade_size: float
    max_trades_per_day: int
    max_exposure_per_market: float
    max_daily_loss: float
    max_live_trade_size: float
    max_live_trades_per_day: int
    trader_invested_threshold_usd: float
    max_live_daily_loss: float
    max_live_exposure_per_market: float
    auto_redeem_live: bool
    jurisdiction_confirmation: bool
    manual_tracked_wallets: str
    use_trending_market_activity: bool
    paused: bool
    max_pending_confirmations: int
    max_new_live_proposals_per_poll: int
    max_new_live_proposals_per_trader_per_poll: int
    max_pending_per_trader: int
    proposal_cooldown_seconds_per_trader: int
    min_source_trade_size_usd: float
    min_copy_price: float
    max_copy_price: float
    max_tracked_traders: int
    tracked_trader_mode: str
    require_manual_tracked_wallets_for_live: bool
    exclude_market_title_regex: str
    allow_market_title_regex: str
    exclude_trader_handle_regex: str
    allow_trader_handle_regex: str
    data_dir: str


class PolymarketTrader(BaseModel):
    id: str
    name: str
    address: str = ""
    handle: str | None = None
    profile_slug: str | None = None
    profile_url: str | None = None
    activity_url: str | None = None
    activity_source: ActivitySource | None = None
    bullpen_profile_url: str | None = None
    polymarket_profile_url: str | None = None
    volume_24h: float = 0
    trades_1h: int = 0
    trades_6h: int = 0
    trades_24h: int = 0
    last_trade_at: str | None = None
    last_trade_age: str | None = None
    profit_usd: float = 0
    leaderboard_profit_usd: dict[str, float] = Field(default_factory=dict)
    leaderboard_period: str | None = None
    leaderboard_periods: list[str] = Field(default_factory=list)
    source_reason: str
    source: TradeSource


class PolymarketSourceTrade(BaseModel):
    id: str
    source_trade_key: str
    trader_id: str
    trader_name: str
    trader_address: str = ""
    trader_handle: str | None = None
    source_trade_id: str | None = None
    raw_trader_identity: str | None = None
    clean_trader_identity: str
    market_id: str
    market_title: str
    event_end_at: str | None = None
    outcome: str
    side: TradeSide
    price: float
    size_usd: float
    trader_invested_usd: float | None = None
    timestamp: str
    source: TradeSource


class PolymarketPaperTrade(BaseModel):
    id: str
    source_trade_id: str
    timestamp: str
    trader_id: str
    trader_name: str
    market_id: str
    market_title: str
    event_end_at: str | None = None
    outcome: str
    side: TradeSide
    price: float
    copied_usd: float
    shares: float
    realized_pnl: float
    status: Literal["executed", "skipped", "failed"]
    reason: str | None = None


class PolymarketLiveTradeDecision(BaseModel):
    id: str
    source_trade_id: str
    source_trade_key: str
    proposed_at: str
    updated_at: str
    trader_id: str
    trader_name: str
    trader_address: str
    trader_handle: str | None = None
    market_id: str
    market_title: str
    event_end_at: str | None = None
    outcome: str
    side: TradeSide
    amount: float
    price: float
    shares: float
    max_loss: float
    trader_invested_usd: float = 0
    trader_net_worth_usd: float = 0
    reason: str
    status: LiveTradeStatus
    command: Literal["buy", "sell"] | None = None
    failure_reason: str | None = None
    executed_at: str | None = None
    source: TradeSource


class PolymarketBalanceState(BaseModel):
    status: BalanceStatus
    message: str
    checked_at: str | None = None
    next_refresh_at: str | None = None
    account_value_usd: float | None = Field(default=None, ge=0)
    available_balance_usd: float | None = Field(default=None, ge=0)
    pnl_usd: float | None = None
    upnl_usd: float | None = None


class PolymarketLiveSourceStatus(BaseModel):
    source_mode: BotMode
    discovery_mode: str
    live_read_traders_count: int = 0
    active_traders_found: int = 0
    candidate_rows_considered: int = 0
    candidate_wallets_extracted: int = 0
    fallback_traders_selected: int = 0
    activity_source_used: ActivitySource | None = None
    rows_rejected_last_discovery: int = 0
    accepted_activity_trades_last_discovery: int = 0
    manual_wallets_configured: int = 0
    manual_wallets_valid: int = 0
    manual_wallets_invalid: list[str] = Field(default_factory=list)
    manual_tracked_wallets: list[PolymarketTrader] = Field(default_factory=list)
    last_poll_time: str | None = None
    last_active_trader_discovery_time: str | None = None
    last_discovery_error: str | None = None
    source_trades_found_last_poll: int = 0
    source_trades_after_filters_last_poll: int = 0
    new_live_proposals_created_last_poll: int = 0
    skipped_by_filters_last_poll: int = 0
    skipped_by_limits_last_poll: int = 0
    skipped_duplicates_last_poll: int = 0
    live_baseline_completed_at: str | None = None
    seen_live_trades_baseline_count: int = 0
    last_live_read_error: str | None = None
    trending_market_activity_enabled: bool = False
    trending_market_activity_unavailable: str | None = None


class PolymarketPosition(BaseModel):
    key: str
    market_id: str
    market_title: str
    outcome: str
    shares: float
    average_price: float
    cost_basis: float


class PolymarketMetrics(BaseModel):
    total_pnl: float
    win_rate: float
    total_trades: int
    winners: int
    losers: int
    skipped: int
    failed: int


class PolymarketActivity(BaseModel):
    timestamp: str
    message: str


class PolymarketDoctorStatus(BaseModel):
    checked_at: str | None = None
    ok: bool
    message: str


class PolymarketLiveControlState(BaseModel):
    enabled_by_env: bool
    unlocked: bool
    unlock_mode: LiveUnlockMode
    manually_locked: bool
    locked_reason: str | None = None
    emergency_stopped: bool
    doctor: PolymarketDoctorStatus
    balance: PolymarketBalanceState
    source_status: PolymarketLiveSourceStatus
    max_live_trade_size: float
    live_trades_today: int
    pending_confirmations: list[PolymarketLiveTradeDecision] = Field(
        default_factory=list
    )
    recent_decisions: list[PolymarketLiveTradeDecision] = Field(default_factory=list)


class PolymarketBotState(BaseModel):
    running: bool
    paused: bool
    mode: BotMode
    server_now: str
    session_started_at: str
    started_at: str | None = None
    stopped_at: str | None = None
    last_poll_at: str | None = None
    next_poll_at: str | None = None
    seconds_until_next_poll: int
    last_error: str | None = None
    tracked_accounts: list[PolymarketTrackedAccount] = Field(default_factory=list)
    tracked_traders: list[PolymarketTrader] = Field(default_factory=list)
    open_positions: list[PolymarketPosition] = Field(default_factory=list)
    trade_history: list[PolymarketPaperTrade] = Field(default_factory=list)
    recent_activity: list[PolymarketActivity] = Field(default_factory=list)
    metrics: PolymarketMetrics
    config: PolymarketBotConfig
    live: PolymarketLiveControlState


class PolymarketDiscoveryDebugRequest(BaseModel):
    target: str = Field(default="swisstony", min_length=1, max_length=120)


class PolymarketDiscoveryDebugCommand(BaseModel):
    label: str
    args: list[str]


class PolymarketDiscoveryDebugCandidate(BaseModel):
    address: str | None = None
    handle: str | None = None
    username: str | None = None
    profile_slug: str | None = None


class PolymarketDiscoveryDebugAccepted(BaseModel):
    address: str | None = None
    clean_identity: str | None = None
    raw_identity: str | None = None
    handle: str | None = None
    username: str | None = None
    market: str | None = None
    title: str | None = None
    outcome: str | None = None
    side: str | None = None
    price: float | None = None
    amount: float | None = None
    timestamp: str | None = None
    reason: str


class PolymarketDiscoveryDebugRejected(BaseModel):
    keys: list[str]
    reason: str
    extracted: dict[str, object | None]


class PolymarketDiscoveryDebugError(BaseModel):
    command: str
    error: str


class PolymarketDiscoveryDebugReport(BaseModel):
    target: str
    commands_attempted: list[PolymarketDiscoveryDebugCommand] = Field(
        default_factory=list
    )
    rows_returned_count: int = 0
    accepted_trades_count: int = 0
    rejected_rows_count: int = 0
    sample_row_keys: list[list[str]] = Field(default_factory=list)
    candidates: list[PolymarketDiscoveryDebugCandidate] = Field(default_factory=list)
    accepted: list[PolymarketDiscoveryDebugAccepted] = Field(default_factory=list)
    rejected: list[PolymarketDiscoveryDebugRejected] = Field(default_factory=list)
    errors: list[PolymarketDiscoveryDebugError] = Field(default_factory=list)
