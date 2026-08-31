from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.domains.bullpen008.constants import WORKFLOW_PROFILE
from app.domains.polymarket_auto_live.returns_formula import (
    DEFAULT_RETURNS_PER_DAY_FORMULA,
    validate_returns_per_day_formula,
)


class Bullpen008LlmTarget(BaseModel):
    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)

    @field_validator("provider", "model")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        return value.strip()


class Bullpen008Settings(BaseModel):
    workflow_profile: Literal["bullpen008"] = WORKFLOW_PROFILE
    shadow_mode: bool = True
    execution_enabled: bool = False
    execution_mode: Literal["shadow", "confirmation_required", "live"] = "shadow"
    live_control_armed: bool = False
    emergency_stop: bool = False
    bankroll_usd: float = Field(default=200, gt=0)
    max_contract_exposure_usd: float = Field(default=20, gt=0)
    max_strict_cluster_exposure_usd: float = Field(default=20, gt=0)
    max_common_catalyst_exposure_usd: float = Field(default=20, gt=0)
    hard_reject_single_day_geopolitical: bool = True
    geopolitical_min_entry_hours: int = Field(default=48, gt=0)
    single_day_high_shock_cap_usd: float = Field(default=5, gt=0)
    high_shock_cluster_cap_usd: float = Field(default=10, gt=0)
    standard_cluster_cap_usd: float = Field(default=20, gt=0)
    conservative_edge_min_pp: float = Field(default=5, ge=0, le=100)
    high_shock_conservative_edge_min_pp: float = Field(default=10, ge=0, le=100)
    entry_price_high_zone_pct: float = Field(default=90, gt=0, lt=100)
    entry_price_hard_ceiling_pct: float = Field(default=95, gt=0, lt=100)
    high_zone_max_allocation_usd: float = Field(default=5, gt=0)
    min_reward_to_loss_ratio: float = Field(default=0.10, gt=0)
    high_shock_evidence_max_age_minutes: int = Field(default=30, gt=0)
    high_shock_min_source_count: int = Field(default=2, ge=2)
    single_day_time_exit_hours: int = Field(default=24, gt=0)
    high_shock_time_exit_hours: int = Field(default=12, gt=0)
    take_profit_odds_floor_pct: float = Field(default=95, gt=0, lt=100)
    contingent_exit_odds_floor_pct: float = Field(default=85, gt=0, lt=100)
    odds_drop_15m_pp: float = Field(default=5, gt=0, le=100)
    odds_drop_24h_pp: float = Field(default=10, gt=0, le=100)
    catastrophic_drop_15m_pp: float = Field(default=20, gt=0, le=100)
    quote_confirmation_count: int = Field(default=2, gt=0)
    soft_drawdown_pct: float = Field(default=3, gt=0, le=100)
    hard_drawdown_pct: float = Field(default=5, gt=0, le=100)
    post_shock_cooldown_hours: int = Field(default=24, gt=0)
    allocation_increment_usd: float = Field(default=5, gt=0)
    binary_side_odds_floor_pct: float = Field(default=5, ge=0, lt=50)
    entry_side_odds_floor_pct: float = Field(default=80, ge=50, le=100)
    min_llm_probability_pct: float = Field(default=80, ge=50, le=100)
    preferred_min_edge_pp: float = Field(default=0.25, ge=0)
    minimum_edge_pp: float = Field(default=0, ge=0)
    risk_reject_threshold: float = Field(default=7, ge=0, le=10)
    risk_hard_reject_threshold: float = Field(default=8, ge=0, le=10)
    risk_half_size_min: float = Field(default=6, ge=0, le=10)
    risk_half_size_max: float = Field(default=6.9, ge=0, le=10)
    probability_tolerance_pp: float = Field(default=0.25, gt=0, le=2)
    stale_quote_seconds: int = Field(default=300, ge=30)
    wallet_freshness_seconds: int = Field(default=300, ge=30, le=1800)
    plan_max_age_seconds: int = Field(default=900, ge=60, le=86400)
    exit_edge_threshold_pp: float = Field(default=0, ge=-100, le=100)
    max_slippage_cents: float = Field(default=1, ge=0, le=20)
    max_spread_cents: float = Field(default=3, ge=0, le=50)
    dust_threshold_usd: float = Field(default=1, ge=0, le=20)
    exposure_rounding_tolerance_usd: float = Field(default=0.05, ge=0.001, le=1)
    closing_window_days: int = Field(default=30, ge=1)
    custom_exclude_phrases: list[str] = Field(default_factory=list)
    returns_per_day_formula: str = DEFAULT_RETURNS_PER_DAY_FORMULA
    llm_targets: list[Bullpen008LlmTarget] = Field(default_factory=list)
    auto_start_at: str | None = None
    auto_refresh_minutes: int = Field(default=360, ge=1)

    @field_validator("custom_exclude_phrases")
    @classmethod
    def normalize_phrases(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for phrase in value:
            candidate = phrase.strip().lower()
            if not candidate or candidate in seen:
                continue
            if len(candidate) > 120:
                raise ValueError(
                    "custom exclusion phrases must be at most 120 characters"
                )
            seen.add(candidate)
            normalized.append(candidate)
        if len(normalized) > 100:
            raise ValueError("no more than 100 custom exclusion phrases are allowed")
        return normalized

    @field_validator("returns_per_day_formula")
    @classmethod
    def validate_formula(cls, value: str) -> str:
        return validate_returns_per_day_formula(value)

    @model_validator(mode="after")
    def validate_thresholds(self) -> Bullpen008Settings:
        if self.risk_hard_reject_threshold < self.risk_reject_threshold:
            raise ValueError("hard-reject threshold cannot be below reject threshold")
        if self.risk_half_size_max < self.risk_half_size_min:
            raise ValueError("half-size maximum cannot be below half-size minimum")
        for cap in (
            self.max_contract_exposure_usd,
            self.max_strict_cluster_exposure_usd,
            self.max_common_catalyst_exposure_usd,
            self.single_day_high_shock_cap_usd,
            self.high_shock_cluster_cap_usd,
            self.standard_cluster_cap_usd,
        ):
            if cap > self.bankroll_usd:
                raise ValueError("portfolio exposure caps cannot exceed bankroll")
        if not (
            self.single_day_high_shock_cap_usd
            <= self.high_shock_cluster_cap_usd
            <= self.standard_cluster_cap_usd
        ):
            raise ValueError("risk-tier caps must be ordered from most to least restrictive")
        if self.entry_price_hard_ceiling_pct < self.entry_price_high_zone_pct:
            raise ValueError("hard price ceiling must be at or above the high-price threshold")
        if self.hard_drawdown_pct <= self.soft_drawdown_pct:
            raise ValueError("hard drawdown must exceed soft drawdown")
        if self.high_shock_conservative_edge_min_pp < self.conservative_edge_min_pp:
            raise ValueError("high-shock conservative edge cannot be below the ordinary threshold")
        if self.execution_mode == "live":
            if self.shadow_mode or not self.execution_enabled or not self.live_control_armed:
                raise ValueError("live execution requires the explicit armed live-control state")
        elif self.execution_enabled or self.live_control_armed or not self.shadow_mode:
            raise ValueError("non-live Bullpen 008 modes must remain shadowed and unarmed")
        return self


class Bullpen008SettingsUpdate(BaseModel):
    bankroll_usd: float | None = Field(default=None, gt=0)
    max_contract_exposure_usd: float | None = Field(default=None, gt=0)
    max_strict_cluster_exposure_usd: float | None = Field(default=None, gt=0)
    max_common_catalyst_exposure_usd: float | None = Field(default=None, gt=0)
    hard_reject_single_day_geopolitical: bool | None = None
    geopolitical_min_entry_hours: int | None = Field(default=None, gt=0)
    single_day_high_shock_cap_usd: float | None = Field(default=None, gt=0)
    high_shock_cluster_cap_usd: float | None = Field(default=None, gt=0)
    standard_cluster_cap_usd: float | None = Field(default=None, gt=0)
    conservative_edge_min_pp: float | None = Field(default=None, ge=0, le=100)
    high_shock_conservative_edge_min_pp: float | None = Field(default=None, ge=0, le=100)
    entry_price_high_zone_pct: float | None = Field(default=None, gt=0, lt=100)
    entry_price_hard_ceiling_pct: float | None = Field(default=None, gt=0, lt=100)
    high_zone_max_allocation_usd: float | None = Field(default=None, gt=0)
    min_reward_to_loss_ratio: float | None = Field(default=None, gt=0)
    high_shock_evidence_max_age_minutes: int | None = Field(default=None, gt=0)
    high_shock_min_source_count: int | None = Field(default=None, ge=2)
    single_day_time_exit_hours: int | None = Field(default=None, gt=0)
    high_shock_time_exit_hours: int | None = Field(default=None, gt=0)
    take_profit_odds_floor_pct: float | None = Field(default=None, gt=0, lt=100)
    contingent_exit_odds_floor_pct: float | None = Field(default=None, gt=0, lt=100)
    odds_drop_15m_pp: float | None = Field(default=None, gt=0, le=100)
    odds_drop_24h_pp: float | None = Field(default=None, gt=0, le=100)
    catastrophic_drop_15m_pp: float | None = Field(default=None, gt=0, le=100)
    quote_confirmation_count: int | None = Field(default=None, gt=0)
    soft_drawdown_pct: float | None = Field(default=None, gt=0, le=100)
    hard_drawdown_pct: float | None = Field(default=None, gt=0, le=100)
    post_shock_cooldown_hours: int | None = Field(default=None, gt=0)
    allocation_increment_usd: float | None = Field(default=None, gt=0)
    binary_side_odds_floor_pct: float | None = Field(default=None, ge=0, lt=50)
    entry_side_odds_floor_pct: float | None = Field(default=None, ge=50, le=100)
    min_llm_probability_pct: float | None = Field(default=None, ge=50, le=100)
    preferred_min_edge_pp: float | None = Field(default=None, ge=0)
    minimum_edge_pp: float | None = Field(default=None, ge=0)
    risk_reject_threshold: float | None = Field(default=None, ge=0, le=10)
    risk_hard_reject_threshold: float | None = Field(default=None, ge=0, le=10)
    risk_half_size_min: float | None = Field(default=None, ge=0, le=10)
    risk_half_size_max: float | None = Field(default=None, ge=0, le=10)
    probability_tolerance_pp: float | None = Field(default=None, gt=0, le=2)
    stale_quote_seconds: int | None = Field(default=None, ge=30)
    wallet_freshness_seconds: int | None = Field(default=None, ge=30, le=1800)
    plan_max_age_seconds: int | None = Field(default=None, ge=60, le=86400)
    exit_edge_threshold_pp: float | None = Field(default=None, ge=-100, le=100)
    max_slippage_cents: float | None = Field(default=None, ge=0, le=20)
    max_spread_cents: float | None = Field(default=None, ge=0, le=50)
    dust_threshold_usd: float | None = Field(default=None, ge=0, le=20)
    closing_window_days: int | None = Field(default=None, ge=1)
    custom_exclude_phrases: list[str] | None = None
    returns_per_day_formula: str | None = None
    llm_targets: list[Bullpen008LlmTarget] | None = None
    auto_start_at: str | None = None
    auto_refresh_minutes: int | None = Field(default=None, ge=1)


class Bullpen008State(BaseModel):
    workflow_profile: Literal["bullpen008"] = WORKFLOW_PROFILE
    shadow_mode: bool = True
    execution_enabled: bool = False
    execution_mode: Literal["shadow", "confirmation_required", "live"] = "shadow"
    emergency_stop: bool = False
    running: bool = False
    paused: bool = False
    status: str = "shadow-ready"
    next_run_at: str | None = None
    last_run_at: str | None = None
    last_run_id: str | None = None
    redis_namespace: str = "bullpen008"
    celery_task_name: str
    celery_queue: str


class Bullpen008StageOutput(BaseModel):
    stage_number: int = Field(ge=1, le=6)
    stage_name: str
    stage_version: str
    status: Literal["pending", "running", "finished", "failed", "blocked", "partial", "cancelled", "disabled"]
    pass_condition: str
    block_reason: str | None = None
    previous_stage_output_hash: str | None = None
    output_hash: str
    settings_snapshot_hash: str
    wallet_snapshot_hash: str
    inputs: dict[str, object] = Field(default_factory=dict)
    calculations: dict[str, object] = Field(default_factory=dict)
    outputs: dict[str, object] = Field(default_factory=dict)
    rejections: list[object] = Field(default_factory=list)
    warnings: list[object] = Field(default_factory=list)
    provenance: dict[str, object] = Field(default_factory=dict)
    prompt_version: str | None = None
    parser_version: str | None = None
    started_at: str
    completed_at: str
    duration_seconds: float = Field(ge=0)


class Bullpen008Run(BaseModel):
    id: str
    workflow_profile: Literal["bullpen008"] = WORKFLOW_PROFILE
    status: str
    triggered_by: str
    shadow_mode: bool = True
    execution_enabled: bool = False
    started_at: str
    completed_at: str | None = None
    summary: str
    error_message: str | None = None
    code_build_version: str | None = None
    settings_snapshot: dict[str, object] = Field(default_factory=dict)
    wallet_snapshot: dict[str, object] = Field(default_factory=dict)
    task_metadata: dict[str, object] = Field(default_factory=dict)
    run_metadata: dict[str, object] = Field(default_factory=dict)
    stages: list[Bullpen008StageOutput] = Field(default_factory=list)
    portfolio_certificate: dict[str, object] | None = None
    action_plan: dict[str, object] | None = None
    execution_intents: list[dict[str, object]] = Field(default_factory=list)


class Bullpen008RunRequest(BaseModel):
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=128)


class Bullpen008ExecutionControlRequest(BaseModel):
    mode: Literal["shadow", "live"]
    confirmation: str = Field(min_length=1, max_length=80)


class Bullpen008InheritedRun(BaseModel):
    id: str
    label: Literal["Inherited from Bullpen 007"] = "Inherited from Bullpen 007"
    status: str
    started_at: str
    completed_at: str | None = None
    summary: str
    read_only: Literal[True] = True
    source_route: Literal["/console/bullpen-ai"] = "/console/bullpen-ai"


class Bullpen008Alert(BaseModel):
    id: int
    market_id: str
    side: str
    source: str
    breach_type: str
    llm_odds: float | None = None
    actual_odds: float | None = None
    created_at: str
    recovered_at: str | None = None
    payload: dict[str, object] = Field(default_factory=dict)


class Bullpen008Bootstrap(BaseModel):
    workflow_profile: Literal["bullpen008"] = WORKFLOW_PROFILE
    page_identity: Literal["Bullpen 008"] = "Bullpen 008"
    shadow_mode: bool = True
    execution_enabled: bool = False
    settings: Bullpen008Settings
    state: Bullpen008State
    latest_run: Bullpen008Run | None = None
    inherited_runs: list[Bullpen008InheritedRun] = Field(default_factory=list)
    alerts: list[Bullpen008Alert] = Field(default_factory=list)
    risk_state: dict[str, object] = Field(default_factory=dict)
    pending_phase2_stages: list[int] = Field(default_factory=list)


class Bullpen008HistoryPage(BaseModel):
    rows: list[Bullpen008Run]
    inherited_rows: list[Bullpen008InheritedRun] = Field(default_factory=list)
    total: int
    limit: int
    offset: int
