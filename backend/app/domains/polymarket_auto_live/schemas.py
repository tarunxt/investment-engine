from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

AutoLiveEvidenceStatus = Literal["Low", "Moderate", "Strong"]
AutoLiveConfidence = Literal["Low", "Medium", "High"]
AutoLiveGuardrailStatus = Literal["pass", "watch", "fail"]
AutoLiveDecisionAction = Literal["BUY_NEW", "ADD_MORE", "HOLD", "TRIM", "EXIT", "SKIP"]
AutoLiveRiskStatus = Literal["Ready", "Watch", "Blocked"]
AutoLiveRunStatus = Literal[
    "running",
    "confirming",
    "completed",
    "partial_success",
    "failed",
    "skipped",
]
AutoLiveStageStatus = Literal["pass", "fail", "warning", "skipped"]
AutoLiveRuntimeStatus = Literal["running", "paused", "stopped", "error", "not-configured"]
AutoLiveRuntimeMode = Literal["dry-run", "analysis-only", "live-trading"]
AutoLiveStage3Result = Literal["SELECTED", "OUTSIDE_TOP_10", "BLOCKED"]
AutoLiveOrderPlanStatus = Literal[
    "planned",
    "ready",
    "retry_wait",
    "submitting",
    "submitted",
    "confirming",
    "partially_filled",
    "settlement_pending",
    "waiting_for_collateral",
    "confirmed",
    "filled",
    "deferred",
    "failed_permanent",
    "rpc_rate_limited",
    "already_redeemed",
    "resolved_zero_payout",
    "skipped",
    "cancelled",
    "failed",
]
AutoLiveOrderAction = Literal["buy", "sell", "hold", "redeem"]
AutoLiveOutcomeSide = Literal["YES", "NO"]
AutoLiveTriggeredBy = Literal["manual", "scheduler", "start", "resume"]
AutoLiveStrategyProfile = Literal["guardrail_kelly", "bullpen_console_top10"]
AutoLiveExitStrategy = Literal[
    "OUTSIDE_TOP_10_RETURNS_DAY",
    "LLM_OR_ODDS_FILTER_EXIT",
    "CAPITAL_AWARE_FORCED_EXIT",
    "REDEEM_CLAIM",
]
AutoLiveExitSeverity = Literal[
    "INFO",
    "WATCH_FAST",
    "PLANNED_EXIT",
    "IMMEDIATE_EXIT",
    "DUST_LOST",
]
AutoLiveExitReasonCode = Literal[
    "OUTSIDE_TOP_10_BY_RETURNS_DAY",
    "LLM_FILTER_FAILED",
    "ODDS_FILTER_FAILED",
    "ADVERSE_MARKET_99_5",
    "ADVERSE_MARKET_99",
    "HELD_SIDE_BID_BELOW_0_5_CENTS",
    "HELD_SIDE_DROP_10_POINTS_1M",
    "HELD_SIDE_DROP_15_POINTS_1M",
    "HELD_SIDE_DROP_25_POINTS_5M",
    "EVENT_CLOSE_PASSED",
    "LOW_EXECUTABLE_VALUE",
    "NO_BID_AVAILABLE",
    "RESOLVED_POSITION_CLAIMABLE",
]
AutoLiveExitState = Literal[
    "ACTIVE",
    "WATCH_FAST",
    "EVENT_EXIT_PLANNED",
    "SELL_SUBMITTED",
    "PARTIALLY_FILLED",
    "SOLD",
    "DUST_LOST",
    "FAILED",
    "REDEEM_CLAIM",
]
TradingBotStatus = Literal["running", "paused", "stopped", "error", "not-configured"]
TradingBotMode = Literal["paper", "live-read", "live-trading", "dry-run", "analysis-only"]
TradingBotGuardrailTone = Literal["neutral", "positive", "warning", "critical"]
BullpenLlmExecutionMode = Literal["chunked_parallel", "single_combined"]
AutoLiveOrderIntentStatus = Literal[
    "PLANNED",
    "READY",
    "RETRY_WAIT",
    "SUBMITTING",
    "SUBMITTED",
    "CONFIRMING",
    "PARTIALLY_FILLED",
    "SETTLEMENT_PENDING",
    "WAITING_FOR_COLLATERAL",
    "CONFIRMED",
    "FILLED",
    "DEFERRED",
    "CANCELLED",
    "FAILED_PERMANENT",
]
AutoLiveReservationStatus = Literal["active", "consumed", "released"]
AutoLiveExecutorErrorCode = Literal[
    "RPC_RATE_LIMITED",
    "RPC_UNAVAILABLE",
    "HTTP_502",
    "HTTP_503",
    "HTTP_504",
    "NETWORK_TIMEOUT",
    "CONNECTION_RESET",
    "AUTH_EXPIRED",
    "SESSION_INVALID",
    "LIVE_LOCKED",
    "DOCTOR_READ_FAILED",
    "ORDER_WRITE_UNAVAILABLE",
    "BALANCE_UNAVAILABLE",
    "INSUFFICIENT_COLLATERAL",
    "SETTLEMENT_PENDING",
    "QUOTE_UNAVAILABLE",
    "QUOTE_STALE",
    "MARKET_CLOSED",
    "MARKET_RESOLVED",
    "UNSUPPORTED_SIDE",
    "INVALID_TICK_SIZE",
    "INVALID_PRICE_PRECISION",
    "INVALID_SHARE_PRECISION",
    "BELOW_MINIMUM_ORDER",
    "NO_SHARES_AVAILABLE",
    "CONDITION_ID_UNAVAILABLE",
    "EMERGENCY_STOP",
    "PERMANENT_REJECTION",
    "AMBIGUOUS_SUBMISSION",
]


class BullpenAutoLiveLlmTarget(BaseModel):
    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)


class BullpenAutoLiveSettingsBase(BaseModel):
    strategy_profile: AutoLiveStrategyProfile = "guardrail_kelly"
    bankroll_usd: float = Field(default=100, gt=0)
    bankroll_source: Literal["manual"] = "manual"
    max_single_trade_pct_bankroll: float = Field(default=2, gt=0, le=100)
    max_single_market_pct_bankroll: float = Field(default=6, gt=0, le=100)
    max_theme_exposure_pct_bankroll: float = Field(default=20, gt=0, le=100)
    max_open_exposure_pct_bankroll: float = Field(default=60, gt=0, le=100)
    min_cash_reserve_pct_bankroll: float = Field(default=40, ge=0, le=100)
    min_order_usd: float = Field(default=1, gt=0)
    max_order_usd: float = Field(default=25, gt=0)
    console_order_usd: float = Field(default=5, gt=0)
    min_liquidity_usd: float = Field(default=1_000, ge=0)

    min_independent_active_markets: int = Field(default=10, ge=1)
    target_active_markets: int = Field(default=15, ge=1)
    max_active_markets: int = Field(default=25, ge=1)
    max_new_markets_per_rebalance: int = Field(default=3, ge=0)

    min_edge_pp: float = Field(default=15, ge=0)
    min_score: float = Field(default=8, ge=0)
    kelly_fraction: float = Field(default=0.25, ge=0, le=1)
    initial_tranche_pct: float = Field(default=50, gt=0, le=100)
    add_more_threshold_pct: float = Field(default=25, ge=0, le=100)

    max_llm_spread_pp: float = Field(default=30, ge=0)
    half_size_llm_spread_pp: float = Field(default=15, ge=0)
    min_evidence_status: AutoLiveEvidenceStatus = "Moderate"
    min_confidence: AutoLiveConfidence = "Medium"
    adjudication_required_blocks_trade: bool = True

    limit_orders_only: bool = True
    max_bid_ask_spread_cents: float = Field(default=5, ge=0)
    max_slippage_cents: float = Field(default=2, ge=0)
    trade_cooldown_hours_per_market: float = Field(default=2, ge=0)
    max_reprice_attempts: int = Field(default=2, ge=0)

    exit_edge_pp: float = Field(default=3, ge=0)
    trim_edge_pp: float = Field(default=8, ge=0)
    rebalance_interval_minutes: int = Field(default=240, ge=1)
    no_new_trade_under_hours_to_deadline: float = Field(default=6, ge=0)
    half_size_under_hours_to_deadline: float = Field(default=48, ge=0)
    max_rebalance_churn_pct_bankroll: float = Field(default=10, ge=0, le=100)

    max_daily_loss_pct_bankroll: float = Field(default=3, ge=0, le=100)
    max_weekly_loss_pct_bankroll: float = Field(default=8, ge=0, le=100)
    pause_after_consecutive_failed_orders: int = Field(default=2, ge=0)
    pause_if_balance_unavailable: bool = True
    pause_if_doctor_fails: bool = True
    pause_if_llm_provider_error_rate_high: bool = True
    emergency_stop: bool = False

    active_price_refresh_seconds: int = Field(default=60, ge=5)
    candidate_price_refresh_minutes: int = Field(default=5, ge=1)
    new_scan_interval_minutes: int = Field(default=60, ge=1)
    llm_rerun_interval_minutes: int = Field(default=240, ge=1)
    max_llm_candidates_per_run: int = Field(default=100, ge=1, le=100)
    console_llm_targets: list[BullpenAutoLiveLlmTarget] = Field(default_factory=list)
    llm_execution_mode: BullpenLlmExecutionMode = "chunked_parallel"
    llm_events_per_prompt: int = Field(default=20, ge=1, le=100)
    console_llm_prompt_template: str | None = None
    console_auto_start_at: str | None = None
    console_auto_refresh_minutes: int | None = Field(default=None, ge=1)

    auto_live_enabled: bool = False
    dry_run: bool = True
    require_manual_confirmation: bool = True
    allow_live_execution: bool = False

    @field_validator("llm_events_per_prompt", mode="before")
    @classmethod
    def validate_llm_events_per_prompt(cls, value: object) -> int:
        if isinstance(value, bool):
            raise ValueError("llm_events_per_prompt must be an integer from 1 to 100")
        if isinstance(value, float):
            if not value.is_integer():
                raise ValueError("llm_events_per_prompt must be an integer from 1 to 100")
            value = int(value)
        if isinstance(value, str):
            normalized = value.strip()
            if not normalized:
                raise ValueError("llm_events_per_prompt must be an integer from 1 to 100")
            if any(char in normalized for char in {".", "e", "E"}):
                raise ValueError("llm_events_per_prompt must be an integer from 1 to 100")
            try:
                value = int(normalized)
            except ValueError as exc:
                raise ValueError(
                    "llm_events_per_prompt must be an integer from 1 to 100"
                ) from exc
        if not isinstance(value, int):
            raise ValueError("llm_events_per_prompt must be an integer from 1 to 100")
        return value

    @model_validator(mode="after")
    def validate_cross_field_rules(self) -> "BullpenAutoLiveSettingsBase":
        if self.max_single_trade_pct_bankroll > self.max_single_market_pct_bankroll:
            raise ValueError(
                "max_single_trade_pct_bankroll must be less than or equal to max_single_market_pct_bankroll"
            )
        if (
            self.max_open_exposure_pct_bankroll
            + self.min_cash_reserve_pct_bankroll
            > 100
        ):
            raise ValueError(
                "max_open_exposure_pct_bankroll plus min_cash_reserve_pct_bankroll must be less than or equal to 100"
            )
        if self.min_edge_pp < self.exit_edge_pp:
            raise ValueError("min_edge_pp must be greater than or equal to exit_edge_pp")
        if self.trim_edge_pp < self.exit_edge_pp:
            raise ValueError("trim_edge_pp must be greater than or equal to exit_edge_pp")
        if self.max_active_markets < self.target_active_markets:
            raise ValueError(
                "max_active_markets must be greater than or equal to target_active_markets"
            )
        if self.target_active_markets < self.min_independent_active_markets:
            raise ValueError(
                "target_active_markets must be greater than or equal to min_independent_active_markets"
            )
        if self.max_order_usd < self.min_order_usd:
            raise ValueError("max_order_usd must be greater than or equal to min_order_usd")
        if self.allow_live_execution and not self.limit_orders_only:
            raise ValueError(
                "allow_live_execution cannot be enabled when limit_orders_only is false"
            )
        if self.half_size_llm_spread_pp > self.max_llm_spread_pp:
            raise ValueError("half_size_llm_spread_pp cannot exceed max_llm_spread_pp")
        return self


class BullpenAutoLiveSettings(BullpenAutoLiveSettingsBase):
    pass


class BullpenAutoLiveSettingsUpdate(BaseModel):
    strategy_profile: AutoLiveStrategyProfile | None = None
    bankroll_usd: float | None = Field(default=None, gt=0)
    bankroll_source: Literal["manual"] | None = None
    max_single_trade_pct_bankroll: float | None = Field(default=None, gt=0, le=100)
    max_single_market_pct_bankroll: float | None = Field(default=None, gt=0, le=100)
    max_theme_exposure_pct_bankroll: float | None = Field(default=None, gt=0, le=100)
    max_open_exposure_pct_bankroll: float | None = Field(default=None, gt=0, le=100)
    min_cash_reserve_pct_bankroll: float | None = Field(default=None, ge=0, le=100)
    min_order_usd: float | None = Field(default=None, gt=0)
    max_order_usd: float | None = Field(default=None, gt=0)
    console_order_usd: float | None = Field(default=None, gt=0)
    min_liquidity_usd: float | None = Field(default=None, ge=0)

    min_independent_active_markets: int | None = Field(default=None, ge=1)
    target_active_markets: int | None = Field(default=None, ge=1)
    max_active_markets: int | None = Field(default=None, ge=1)
    max_new_markets_per_rebalance: int | None = Field(default=None, ge=0)

    min_edge_pp: float | None = Field(default=None, ge=0)
    min_score: float | None = Field(default=None, ge=0)
    kelly_fraction: float | None = Field(default=None, ge=0, le=1)
    initial_tranche_pct: float | None = Field(default=None, gt=0, le=100)
    add_more_threshold_pct: float | None = Field(default=None, ge=0, le=100)

    max_llm_spread_pp: float | None = Field(default=None, ge=0)
    half_size_llm_spread_pp: float | None = Field(default=None, ge=0)
    min_evidence_status: AutoLiveEvidenceStatus | None = None
    min_confidence: AutoLiveConfidence | None = None
    adjudication_required_blocks_trade: bool | None = None

    limit_orders_only: bool | None = None
    max_bid_ask_spread_cents: float | None = Field(default=None, ge=0)
    max_slippage_cents: float | None = Field(default=None, ge=0)
    trade_cooldown_hours_per_market: float | None = Field(default=None, ge=0)
    max_reprice_attempts: int | None = Field(default=None, ge=0)

    exit_edge_pp: float | None = Field(default=None, ge=0)
    trim_edge_pp: float | None = Field(default=None, ge=0)
    rebalance_interval_minutes: int | None = Field(default=None, ge=1)
    no_new_trade_under_hours_to_deadline: float | None = Field(default=None, ge=0)
    half_size_under_hours_to_deadline: float | None = Field(default=None, ge=0)
    max_rebalance_churn_pct_bankroll: float | None = Field(default=None, ge=0, le=100)

    max_daily_loss_pct_bankroll: float | None = Field(default=None, ge=0, le=100)
    max_weekly_loss_pct_bankroll: float | None = Field(default=None, ge=0, le=100)
    pause_after_consecutive_failed_orders: int | None = Field(default=None, ge=0)
    pause_if_balance_unavailable: bool | None = None
    pause_if_doctor_fails: bool | None = None
    pause_if_llm_provider_error_rate_high: bool | None = None
    emergency_stop: bool | None = None

    active_price_refresh_seconds: int | None = Field(default=None, ge=5)
    candidate_price_refresh_minutes: int | None = Field(default=None, ge=1)
    new_scan_interval_minutes: int | None = Field(default=None, ge=1)
    llm_rerun_interval_minutes: int | None = Field(default=None, ge=1)
    max_llm_candidates_per_run: int | None = Field(default=None, ge=1, le=100)
    console_llm_targets: list[BullpenAutoLiveLlmTarget] | None = None
    llm_execution_mode: BullpenLlmExecutionMode | None = None
    llm_events_per_prompt: int | None = Field(default=None, ge=1, le=100)
    console_llm_prompt_template: str | None = None
    console_auto_start_at: str | None = None
    console_auto_refresh_minutes: int | None = Field(default=None, ge=1)

    auto_live_enabled: bool | None = None
    dry_run: bool | None = None
    require_manual_confirmation: bool | None = None
    allow_live_execution: bool | None = None

    @field_validator("llm_events_per_prompt", mode="before")
    @classmethod
    def validate_optional_llm_events_per_prompt(cls, value: object) -> object:
        if value is None:
            return None
        return BullpenAutoLiveSettingsBase.validate_llm_events_per_prompt(value)


class BullpenAutoLiveGuardrailCheck(BaseModel):
    id: str
    label: str
    status: AutoLiveGuardrailStatus
    detail: str
    value: str | None = None
    blocking: bool = False
    checked_at: str


class BullpenAutoLiveLlmOutput(BaseModel):
    provider: str
    model: str
    status: str | None = None
    llm_yes_odds: float | None = Field(default=None, ge=0, le=100)
    llm_no_odds: float | None = Field(default=None, ge=0, le=100)
    direction: str | None = None
    rationale_odds_mismatch: bool = False
    rationale_odds_mismatch_reason: str | None = None
    effective_weight: float = Field(default=1, ge=0)
    confidence: str | None = None
    evidence_status: str | None = None
    event_state: str | None = None
    key_evidence: list[str] = Field(default_factory=list)
    red_flags: list[str] = Field(default_factory=list)
    rationale: str | None = None
    error: str | None = None
    invalid_reason: str | None = None
    diagnostic: dict[str, object] | None = None
    completed_at: str | None = None


class BullpenAutoLiveConsoleCandidateInput(BaseModel):
    question_id: str
    market_id: str
    market_title: str
    slug: str | None = None
    market_url: str | None = None
    close_time: str | None = None
    theme: str = "Uncategorized"
    current_yes_odds: float | None = Field(default=None, ge=0, le=100)
    current_no_odds: float | None = Field(default=None, ge=0, le=100)
    volume_usd: float | None = Field(default=None, ge=0)
    liquidity_usd: float | None = Field(default=None, ge=0)
    best_bid_cents: float | None = Field(default=None, ge=0, le=100)
    best_ask_cents: float | None = Field(default=None, ge=0, le=100)
    spread_cents: float | None = Field(default=None, ge=0)
    llm_yes_odds: float | None = Field(default=None, ge=0, le=100)
    llm_no_odds: float | None = Field(default=None, ge=0, le=100)
    returns_per_day: float | None = None
    amount_to_be_invested: float | None = Field(default=None, ge=0)
    llm_disagreement_level: str | None = None
    llm_disagreement_category: str | None = None
    adjudication_required: bool = False
    confidence: str | None = None
    evidence_status: str | None = None
    event_state: str | None = None
    rules: str | None = None
    market_context: str | None = None
    resolution_source: str | None = None
    event_description: str | None = None
    preflight_evidence_block: str | None = None
    selected: bool = False
    llm_outputs: list[BullpenAutoLiveLlmOutput] = Field(default_factory=list)


class BullpenAutoLiveConsoleRunContext(BaseModel):
    source_label: str | None = None
    source_url: str | None = None
    scanned_at: str | None = None
    snapshot_id: str | None = None
    mode: str | None = None
    total_candidates: int = Field(default=0, ge=0)
    candidate_rows_prefiltered: bool = False
    reuse_saved_llm_outputs: bool = True
    candidate_rows: list[BullpenAutoLiveConsoleCandidateInput] = Field(
        default_factory=list
    )


class BullpenAutoLiveRunOnceRequest(BaseModel):
    console_profile: BullpenAutoLiveConsoleRunContext | None = None


class BullpenAutoLiveRejectedCandidateDiagnostic(BaseModel):
    market_id: str
    market_title: str
    slug: str | None = None
    market_url: str | None = None
    reasons: list[str] = Field(default_factory=list)


class BullpenAutoLiveRunDiagnostics(BaseModel):
    live_wallet_positions: int = Field(default=0, ge=0)
    active_wallet_positions: int = Field(default=0, ge=0)
    scanned_candidates: int = Field(default=0, ge=0)
    candidate_rows_before_llm: int = Field(default=0, ge=0)
    llm_candidate_count: int = Field(default=0, ge=0)
    qualified_candidate_rows: int = Field(default=0, ge=0)
    top_candidate_market_ids: list[str] = Field(default_factory=list)
    rejected_candidates: list[BullpenAutoLiveRejectedCandidateDiagnostic] = Field(
        default_factory=list
    )
    scan_source_label: str | None = None
    scan_source_url: str | None = None
    used_manual_console_rows: bool = False
    selected_manual_candidate_ids: list[str] = Field(default_factory=list)
    stage2_has_usable_reviews: bool = True
    ranking_enabled: bool = True
    ranking_exit_enabled: bool = True
    new_buy_enabled: bool = True
    safety_exit_enabled: bool = True


class BullpenAutoLiveOrderFunnel(BaseModel):
    planned: int = Field(default=0, ge=0)
    ready: int = Field(default=0, ge=0)
    attempted: int = Field(default=0, ge=0)
    remotely_accepted: int = Field(default=0, ge=0)
    submitted: int = Field(default=0, ge=0)
    confirming: int = Field(default=0, ge=0)
    partially_filled: int = Field(default=0, ge=0)
    confirmed: int = Field(default=0, ge=0)
    filled: int = Field(default=0, ge=0)
    retry_wait: int = Field(default=0, ge=0)
    settlement_pending: int = Field(default=0, ge=0)
    waiting_for_collateral: int = Field(default=0, ge=0)
    deferred: int = Field(default=0, ge=0)
    cancelled: int = Field(default=0, ge=0)
    permanently_failed: int = Field(default=0, ge=0)
    attempt_rate: float = Field(default=0, ge=0)
    acceptance_rate: float = Field(default=0, ge=0)
    confirmation_rate: float = Field(default=0, ge=0)
    fill_rate: float = Field(default=0, ge=0)
    terminal_success_rate: float = Field(default=0, ge=0)


class BullpenAutoLiveOrderAttempt(BaseModel):
    id: int
    intent_id: str
    attempt_number: int = Field(ge=1)
    worker_task_id: str | None = None
    rpc_provider: str | None = None
    executor_path: str | None = None
    started_at: str
    completed_at: str | None = None
    result_status: str
    error_code: AutoLiveExecutorErrorCode | str | None = None
    error_message: str | None = None
    retry_after_seconds: int | None = Field(default=None, ge=0)
    remote_order_id: str | None = None
    remote_transaction_hash: str | None = None
    sanitized_request_json: dict[str, object] = Field(default_factory=dict)
    sanitized_response_json: dict[str, object] = Field(default_factory=dict)
    reconciliation_json: dict[str, object] = Field(default_factory=dict)


class BullpenAutoLiveCapitalReservation(BaseModel):
    id: int
    user_id: int
    order_intent_id: str
    amount_usd: float = Field(ge=0)
    status: AutoLiveReservationStatus
    created_at: str
    updated_at: str
    released_at: str | None = None


class BullpenAutoLiveOrderIntent(BaseModel):
    id: str
    user_id: int
    run_id: str
    decision_id: str | None = None
    dependency_group: str | None = None
    action: Literal["buy", "sell", "redeem"]
    market_id: str
    slug: str | None = None
    condition_id: str | None = None
    side: AutoLiveOutcomeSide | None = None
    requested_order_usd: float | None = Field(default=None, ge=0)
    requested_shares: float | None = Field(default=None, ge=0)
    requested_limit_price_cents: float | None = Field(default=None, ge=0, le=100)
    current_order_usd: float | None = Field(default=None, ge=0)
    current_shares: float | None = Field(default=None, ge=0)
    current_limit_price_cents: float | None = Field(default=None, ge=0, le=100)
    max_slippage_cents: float = Field(default=0, ge=0)
    status: AutoLiveOrderIntentStatus
    error_class: str | None = None
    last_error_code: AutoLiveExecutorErrorCode | str | None = None
    last_error_message: str | None = None
    retryable: bool = False
    attempt_count: int = Field(default=0, ge=0)
    max_attempts: int = Field(default=0, ge=0)
    next_attempt_at: str | None = None
    priority: int = Field(default=100, ge=0)
    remote_order_id: str | None = None
    remote_transaction_hash: str | None = None
    idempotency_key: str
    reserved_cash_usd: float = Field(default=0, ge=0)
    expected_release_usd: float = Field(default=0, ge=0)
    confirmed_release_usd: float = Field(default=0, ge=0)
    filled_shares: float = Field(default=0, ge=0)
    remaining_shares: float = Field(default=0, ge=0)
    average_fill_price_cents: float | None = Field(default=None, ge=0, le=100)
    dependency_metadata_json: dict[str, object] = Field(default_factory=dict)
    execution_metadata_json: dict[str, object] = Field(default_factory=dict)
    version: int = Field(default=1, ge=1)
    created_at: str
    updated_at: str
    first_submitted_at: str | None = None
    last_submitted_at: str | None = None
    confirmed_at: str | None = None
    terminal_at: str | None = None
    attempts: list[BullpenAutoLiveOrderAttempt] = Field(default_factory=list)
    reservations: list[BullpenAutoLiveCapitalReservation] = Field(default_factory=list)


class BullpenAutoLiveRunOrdersResponse(BaseModel):
    run: BullpenAutoLiveRun | None = None
    orders: list[BullpenAutoLiveOrderIntent] = Field(default_factory=list)
    order_funnel: BullpenAutoLiveOrderFunnel = Field(default_factory=BullpenAutoLiveOrderFunnel)
    action_funnels: dict[str, BullpenAutoLiveOrderFunnel] = Field(default_factory=dict)
    retry_counts: dict[str, int] = Field(default_factory=dict)
    provider_error_counts: dict[str, int] = Field(default_factory=dict)
    average_confirmation_seconds: float | None = Field(default=None, ge=0)
    oldest_pending_order_age_seconds: float | None = Field(default=None, ge=0)
    pending_confirmation_count: int = Field(default=0, ge=0)
    partial_fill_count: int = Field(default=0, ge=0)
    permanent_failure_count: int = Field(default=0, ge=0)
    transient_failure_count: int = Field(default=0, ge=0)


class BullpenAutoLiveOrderPlan(BaseModel):
    id: str
    action: AutoLiveOrderAction
    side: AutoLiveOutcomeSide
    order_type: Literal["limit"] = "limit"
    status: AutoLiveOrderPlanStatus = "planned"
    market_id: str
    market_title: str
    dependency_group: str | None = None
    order_size_usd: float = Field(ge=0)
    shares: float = Field(default=0, ge=0)
    limit_price_cents: float = Field(ge=0, le=100)
    refreshed_market_price_cents: float | None = Field(default=None, ge=0, le=100)
    max_slippage_cents: float = Field(ge=0)
    dry_run: bool = True
    detail: str
    retryable: bool = False
    attempt_count: int = Field(default=0, ge=0)
    next_retry_at: str | None = None
    remote_order_id: str | None = None
    remote_transaction_hash: str | None = None
    provider_alias: str | None = None
    latest_error_code: AutoLiveExecutorErrorCode | str | None = None
    dependency_state: str | None = None
    reservation_state: AutoLiveReservationStatus | str | None = None
    reservation_amount_usd: float | None = Field(default=None, ge=0)
    filled_shares: float = Field(default=0, ge=0)
    remaining_shares: float = Field(default=0, ge=0)
    average_fill_price_cents: float | None = Field(default=None, ge=0, le=100)
    execution_response: str | None = None
    created_at: str
    executed_at: str | None = None
    confirmed_at: str | None = None
    terminal_at: str | None = None


class BullpenAutoLiveExitSignalMetrics(BaseModel):
    currentYes: float | None = Field(default=None, ge=0, le=1)
    currentNo: float | None = Field(default=None, ge=0, le=1)
    heldProbability: float | None = Field(default=None, ge=0, le=1)
    adverseProbability: float | None = Field(default=None, ge=0, le=1)
    heldBestBid: float | None = Field(default=None, ge=0)
    shares: float | None = Field(default=None, ge=0)
    avgPrice: float | None = Field(default=None, ge=0)
    estimatedFreeableValue: float | None = None
    drop1m: float | None = None
    drop5m: float | None = None
    adverseRise1m: float | None = None
    adverseRise5m: float | None = None
    timeToCloseHours: float | None = None


class BullpenAutoLiveExitSignal(BaseModel):
    strategy: AutoLiveExitStrategy
    severity: AutoLiveExitSeverity
    reasonCode: AutoLiveExitReasonCode
    label: str
    description: str
    score: float | None = None
    createdAt: str
    metrics: BullpenAutoLiveExitSignalMetrics | None = None


class BullpenAutoLivePositionPriceSnapshot(BaseModel):
    positionId: str
    marketId: str
    tokenId: str
    timestamp: str
    currentYes: float = Field(ge=0, le=1)
    currentNo: float = Field(ge=0, le=1)
    heldProbability: float = Field(ge=0, le=1)
    adverseProbability: float = Field(ge=0, le=1)
    heldBestBid: float | None = Field(default=None, ge=0)


class BullpenAutoLiveStageResult(BaseModel):
    stage_number: int = Field(ge=1, le=7)
    stage_name: str
    status: AutoLiveStageStatus
    reason: str
    inputs: dict[str, object] = Field(default_factory=dict)
    outputs: dict[str, object] = Field(default_factory=dict)
    guardrails_checked: list[BullpenAutoLiveGuardrailCheck] = Field(default_factory=list)
    hard_block: bool = False
    started_at: str
    completed_at: str | None = None


class BullpenAutoLiveDecision(BaseModel):
    id: str
    run_id: str
    created_at: str
    updated_at: str
    market_id: str
    market_title: str
    market_url: str | None = None
    slug: str | None = None
    close_time: str | None = None
    theme: str
    side: AutoLiveOutcomeSide
    decision: AutoLiveDecisionAction
    risk_status: AutoLiveRiskStatus
    price_cents: float = Field(ge=0, le=100)
    current_yes_odds: float | None = Field(default=None, ge=0, le=100)
    current_no_odds: float | None = Field(default=None, ge=0, le=100)
    fair_probability_pct: float = Field(ge=0, le=100)
    fair_yes_probability_pct: float | None = Field(default=None, ge=0, le=100)
    fair_no_probability_pct: float | None = Field(default=None, ge=0, le=100)
    edge_pp: float
    score: float
    confidence: AutoLiveConfidence
    evidence_status: AutoLiveEvidenceStatus
    event_state: str | None = None
    adjudication_required: bool = False
    disagreement_level: str | None = None
    disagreement_category: str | None = None
    current_exposure_usd: float = Field(default=0, ge=0)
    target_exposure_usd: float = Field(default=0, ge=0)
    realized_pnl_usd: float | None = None
    hours_remaining: float | None = None
    key_evidence: list[str] = Field(default_factory=list)
    red_flags: list[str] = Field(default_factory=list)
    rationale: str | None = None
    reason: str
    summary: str
    stage3_result: AutoLiveStage3Result | None = None
    stage3_result_reason: str | None = None
    stage3_final_rank: int | None = Field(default=None, ge=1)
    stage3_max_positions: int | None = Field(default=None, ge=1)
    selection_required: bool = False
    selected_for_auto_invest: bool | None = None
    selection_block_reason: str | None = None
    order_plan: BullpenAutoLiveOrderPlan | None = None
    exit_signals: list[BullpenAutoLiveExitSignal] = Field(default_factory=list)
    exit_state: AutoLiveExitState = "ACTIVE"
    llm_outputs: list[BullpenAutoLiveLlmOutput] = Field(default_factory=list)
    stage_results: list[BullpenAutoLiveStageResult] = Field(default_factory=list)
    guardrail_checks: list[BullpenAutoLiveGuardrailCheck] = Field(default_factory=list)


class BullpenAutoLiveRun(BaseModel):
    id: str
    triggered_by: AutoLiveTriggeredBy
    status: AutoLiveRunStatus
    dry_run: bool
    started_at: str
    completed_at: str | None = None
    summary: str
    live_execution_requested: bool = False
    live_execution_attempted: bool = False
    decisions_count: int = 0
    orders_planned: int = 0
    orders_submitted: int = 0
    error_message: str | None = None
    execution_version: str | None = None
    order_funnel: BullpenAutoLiveOrderFunnel = Field(default_factory=BullpenAutoLiveOrderFunnel)
    action_funnels: dict[str, BullpenAutoLiveOrderFunnel] = Field(default_factory=dict)
    retry_counts: dict[str, int] = Field(default_factory=dict)
    provider_error_counts: dict[str, int] = Field(default_factory=dict)
    average_confirmation_seconds: float | None = Field(default=None, ge=0)
    oldest_pending_order_age_seconds: float | None = Field(default=None, ge=0)
    pending_confirmation_count: int = Field(default=0, ge=0)
    partial_fill_count: int = Field(default=0, ge=0)
    permanent_failure_count: int = Field(default=0, ge=0)
    transient_failure_count: int = Field(default=0, ge=0)
    stage_results: list[BullpenAutoLiveStageResult] = Field(default_factory=list)
    guardrail_checks: list[BullpenAutoLiveGuardrailCheck] = Field(default_factory=list)
    decision_ids: list[str] = Field(default_factory=list)
    order_intent_ids: list[str] = Field(default_factory=list)
    diagnostics: BullpenAutoLiveRunDiagnostics = Field(default_factory=BullpenAutoLiveRunDiagnostics)
    request_context: BullpenAutoLiveRunOnceRequest | None = None


class BullpenAutoLiveState(BaseModel):
    running: bool = False
    paused: bool = False
    dry_run: bool = True
    live_armed: bool = False
    live_execution_allowed: bool = False
    emergency_stopped: bool = False
    status: AutoLiveRuntimeStatus = "not-configured"
    mode: AutoLiveRuntimeMode = "dry-run"
    server_now: str | None = None
    started_at: str | None = None
    stopped_at: str | None = None
    last_run_at: str | None = None
    last_execution_at: str | None = None
    next_run_at: str | None = None
    last_scan_at: str | None = None
    last_llm_run_at: str | None = None
    last_rebalance_at: str | None = None
    next_scan_at: str | None = None
    next_llm_run_at: str | None = None
    next_rebalance_at: str | None = None
    last_error: str | None = None
    last_action: str | None = None
    last_run_id: str | None = None
    latest_guardrail_checks: list[BullpenAutoLiveGuardrailCheck] = Field(
        default_factory=list
    )
    invested_usd: float = Field(default=0, ge=0)
    current_value_usd: float = Field(default=0, ge=0)
    pnl_usd: float = 0
    active_positions: int = Field(default=0, ge=0)
    last_console_trade_amount_usd: float | None = Field(default=None, ge=0)
    last_console_trade_cash_in_hand_usd: float | None = Field(default=None, ge=0)
    last_console_trade_active_positions: int | None = Field(default=None, ge=0)
    last_console_trade_available_slots: int | None = Field(default=None, ge=0)
    last_console_trade_max_positions: int | None = Field(default=None, ge=1)
    trades_today: int = Field(default=0, ge=0)
    consecutive_failed_orders: int = Field(default=0, ge=0)
    today_executed_orders: int = Field(default=0, ge=0)
    today_skipped_orders: int = Field(default=0, ge=0)
    doctor_status: AutoLiveGuardrailStatus = "watch"
    balance_status: AutoLiveGuardrailStatus = "watch"


class TradingBotGuardrail(BaseModel):
    label: str
    value: str
    tone: TradingBotGuardrailTone = "neutral"


class BullpenAutoLiveBotCardSummary(BaseModel):
    id: Literal["bullpen-ai-auto-live"] = "bullpen-ai-auto-live"
    name: str = "Bullpen AI Auto-Live"
    route: str = "/console/trading-bots/bullpen-ai-auto-live"
    status: TradingBotStatus
    mode: TradingBotMode
    invested_usd: float | None = None
    current_value_usd: float | None = None
    pnl_usd: float | None = None
    return_pct: float | None = None
    active_positions: int | None = None
    trades_today: int | None = None
    last_run_at: str | None = None
    next_run_at: str | None = None
    guardrails_summary: str
    strategy_summary: str
    risk_summary: str
    guardrails: list[TradingBotGuardrail] = Field(default_factory=list)


class BullpenAutoLiveSummary(BaseModel):
    state: BullpenAutoLiveState
    settings: BullpenAutoLiveSettings
    bot_card: BullpenAutoLiveBotCardSummary
    latest_run: BullpenAutoLiveRun | None = None
    recent_runs: list[BullpenAutoLiveRun] = Field(default_factory=list)
    recent_decisions: list[BullpenAutoLiveDecision] = Field(default_factory=list)
    latest_guardrail_checks: list[BullpenAutoLiveGuardrailCheck] = Field(
        default_factory=list
    )
