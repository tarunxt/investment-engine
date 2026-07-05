from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class BullpenTradeAnalysisSnapshot(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    snapshot_type: str
    captured_at: datetime
    bullpen_snapshot_json: dict[str, Any] = Field(default_factory=dict)
    event_snapshot_json: dict[str, Any] = Field(default_factory=dict)
    market_snapshot_json: dict[str, Any] = Field(default_factory=dict)
    order_book_snapshot_json: dict[str, Any] = Field(default_factory=dict)
    positions_snapshot_json: dict[str, Any] = Field(default_factory=dict)
    raw_api_response_json: dict[str, Any] = Field(default_factory=dict)


class BullpenTradeAnalysisLlmEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    phase: str
    provider: str | None = None
    model: str | None = None
    prompt_version: str | None = None
    prompt_text: str | None = None
    raw_output: str | None = None
    parsed_output_json: dict[str, Any] = Field(default_factory=dict)
    confidence: float | None = None
    tags_json: list[Any] = Field(default_factory=list)
    computed_tags_json: list[Any] = Field(default_factory=list)
    decision_json: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class BullpenTradeAnalysisEventLog(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    run_id: str | None = None
    event_type: str
    message: str
    metadata_json: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class BullpenTradeAnalysisSummaryStats(BaseModel):
    total_executed_trades: int = 0
    open_positions: int = 0
    closed_positions: int = 0
    total_net_pnl: float = 0
    win_rate: float = 0
    average_pnl_percent: float | None = None
    average_holding_period_seconds: float | None = None
    total_fees: float = 0


class BullpenTradeAnalysisRecordResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    entry_reference: str
    exit_reference: str | None = None
    source_variant: str
    bot_name: str
    strategy_name: str | None = None
    strategy_version: str | None = None
    status: str
    lifecycle_state: str
    final_tag: str
    pnl_outcome_tag: str
    position_key: str | None = None
    event_id: str | None = None
    event_slug: str | None = None
    bullpen_event_id: str | None = None
    bullpen_market_id: str | None = None
    outcome_id: str | None = None
    outcome_name: str | None = None
    contract_id: str | None = None
    run_id: str | None = None
    title: str
    event_question: str
    event_description: str | None = None
    category: str | None = None
    topic: str | None = None
    source_url: str | None = None
    market_url: str | None = None
    event_close_time: datetime | None = None
    event_resolved_at: datetime | None = None
    bought_at: datetime | None = None
    sold_at: datetime | None = None
    redeemed_at: datetime | None = None
    closed_at: datetime | None = None

    buy_order_id: str | None = None
    buy_client_order_id: str | None = None
    buy_submitted_at: datetime | None = None
    buy_executed_at: datetime | None = None
    buy_requested_amount: float | None = None
    buy_requested_shares: float | None = None
    buy_requested_price: float | None = None
    buy_requested_odds: float | None = None
    buy_filled_amount: float | None = None
    buy_filled_shares: float | None = None
    buy_average_fill_price: float | None = None
    buy_average_fill_odds: float | None = None
    buy_fees: float | None = None
    buy_slippage: float | None = None
    buy_status: str | None = None
    buy_failure_reason: str | None = None
    buy_decision_summary: str | None = None
    buy_reason: str | None = None
    buy_confidence: float | None = None
    buy_risk_score: float | None = None
    buy_expected_edge: float | None = None
    buy_expected_value: float | None = None
    buy_probability_estimate: float | None = None
    buy_market_implied_probability: float | None = None
    buy_probability_delta: float | None = None
    buy_liquidity_score: float | None = None
    buy_volume_score: float | None = None
    buy_spread_score: float | None = None
    buy_volatility_score: float | None = None
    buy_news_recency_score: float | None = None
    buy_selected_by_rule: bool = False
    buy_selected_by_llm: bool = False
    buy_selected_by_hybrid_decision: bool = False
    buy_computed_tags_json: list[Any] = Field(default_factory=list)
    buy_rule_checks_json: list[Any] = Field(default_factory=list)

    exit_type: str | None = None
    sell_order_id: str | None = None
    sell_client_order_id: str | None = None
    sell_submitted_at: datetime | None = None
    sell_executed_at: datetime | None = None
    sell_requested_amount: float | None = None
    sell_requested_shares: float | None = None
    sell_requested_price: float | None = None
    sell_requested_odds: float | None = None
    sell_filled_amount: float | None = None
    sell_filled_shares: float | None = None
    sell_average_fill_price: float | None = None
    sell_average_fill_odds: float | None = None
    sell_fees: float | None = None
    sell_slippage: float | None = None
    sell_status: str | None = None
    sell_failure_reason: str | None = None
    sell_decision_summary: str | None = None
    sell_reason: str | None = None
    sell_confidence: float | None = None
    sell_risk_score: float | None = None
    sell_expected_edge: float | None = None
    sell_expected_value: float | None = None
    sell_probability_estimate: float | None = None
    sell_market_implied_probability: float | None = None
    sell_probability_delta: float | None = None
    sell_liquidity_score: float | None = None
    sell_volume_score: float | None = None
    sell_spread_score: float | None = None
    sell_volatility_score: float | None = None
    sell_computed_tags_json: list[Any] = Field(default_factory=list)
    sell_rule_checks_json: list[Any] = Field(default_factory=list)

    buy_notional: float | None = None
    exit_notional: float | None = None
    gross_pnl: float | None = None
    net_pnl: float | None = None
    pnl_percent: float | None = None
    fees_total: float | None = None
    holding_period_seconds: int | None = None
    realized_return: float | None = None
    max_favorable_price: float | None = None
    max_adverse_price: float | None = None
    best_possible_exit_price_after_buy: float | None = None
    worst_price_after_buy: float | None = None
    missed_profit_amount: float | None = None
    drawdown_while_held: float | None = None

    analysis_summary: str | None = None
    mistake_category: str | None = None
    improvement_suggestion: str | None = None
    reinforcement_signal: str | None = None
    reinforcement_score: float | None = None
    should_avoid_similar_trade: bool = False
    should_increase_confidence_for_similar_trade: bool = False
    human_review_required: bool = False
    reviewer_notes: str | None = None
    metadata_json: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class BullpenTradeAnalysisListItem(BaseModel):
    id: str
    title: str
    status: str
    final_tag: str
    pnl_outcome_tag: str
    category: str | None = None
    topic: str | None = None
    run_id: str | None = None
    strategy_name: str | None = None
    strategy_version: str | None = None
    bought_at: datetime | None = None
    sold_at: datetime | None = None
    redeemed_at: datetime | None = None
    closed_at: datetime | None = None
    buy_amount: float | None = None
    buy_price: float | None = None
    buy_odds: float | None = None
    current_price: float | None = None
    exit_price: float | None = None
    exit_odds: float | None = None
    net_pnl: float | None = None
    pnl_percent: float | None = None
    holding_period_seconds: int | None = None
    buy_tags: list[str] = Field(default_factory=list)
    short_reason: str | None = None
    exit_reason: str | None = None
    confidence: float | None = None
    risk_score: float | None = None


class BullpenTradeAnalysisLearningInsights(BaseModel):
    win_rate_by_tag: list[dict[str, Any]] = Field(default_factory=list)
    average_pnl_by_tag: list[dict[str, Any]] = Field(default_factory=list)
    total_pnl_by_strategy_version: list[dict[str, Any]] = Field(default_factory=list)
    average_pnl_by_confidence_bucket: list[dict[str, Any]] = Field(default_factory=list)
    average_pnl_by_spread_bucket: list[dict[str, Any]] = Field(default_factory=list)
    average_pnl_by_liquidity_bucket: list[dict[str, Any]] = Field(default_factory=list)
    losses_caused_by_low_liquidity: int = 0
    high_confidence_losses: int = 0
    profitable_tags: list[dict[str, Any]] = Field(default_factory=list)
    unprofitable_tags: list[dict[str, Any]] = Field(default_factory=list)
    average_holding_period_winners_seconds: float | None = None
    average_holding_period_losers_seconds: float | None = None
    exit_reasons_ranked_by_pnl: list[dict[str, Any]] = Field(default_factory=list)
    buy_reasons_ranked_by_pnl: list[dict[str, Any]] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)


class BullpenTradeAnalysisListResponse(BaseModel):
    items: list[BullpenTradeAnalysisListItem] = Field(default_factory=list)
    summary: BullpenTradeAnalysisSummaryStats = Field(
        default_factory=BullpenTradeAnalysisSummaryStats
    )
    learning_insights: BullpenTradeAnalysisLearningInsights = Field(
        default_factory=BullpenTradeAnalysisLearningInsights
    )


class BullpenTradeAnalysisComparison(BaseModel):
    buy_price: float | None = None
    exit_price: float | None = None
    buy_odds: float | None = None
    exit_odds: float | None = None
    buy_liquidity_score: float | None = None
    exit_liquidity_score: float | None = None
    buy_volume_score: float | None = None
    exit_volume_score: float | None = None
    buy_spread_score: float | None = None
    exit_spread_score: float | None = None
    buy_confidence: float | None = None
    exit_confidence: float | None = None
    buy_probability_estimate: float | None = None
    exit_probability_estimate: float | None = None
    buy_market_implied_probability: float | None = None
    exit_market_implied_probability: float | None = None
    buy_probability_delta: float | None = None
    exit_probability_delta: float | None = None


class BullpenTradeAnalysisActionableLearning(BaseModel):
    analysis_summary: str | None = None
    mistake_category: str | None = None
    improvement_suggestion: str | None = None
    reinforcement_signal: str | None = None
    reinforcement_score: float | None = None
    should_avoid_similar_trade: bool = False
    should_increase_confidence_for_similar_trade: bool = False
    human_review_required: bool = False
    what_worked: list[str] = Field(default_factory=list)
    what_went_wrong: list[str] = Field(default_factory=list)
    exit_timing: str = "reasonable"
    entry_too_expensive: bool = False
    liquidity_or_spread_issue: bool = False
    llm_confidence_aligned: bool = False
    suggested_platform_rule_changes: list[str] = Field(default_factory=list)
    suggested_prompt_changes: list[str] = Field(default_factory=list)
    suggested_risk_management_changes: list[str] = Field(default_factory=list)
    sell_reason: str | None = None


class BullpenTradeAnalysisDetailResponse(BaseModel):
    trade: BullpenTradeAnalysisRecordResponse
    comparison: BullpenTradeAnalysisComparison = Field(
        default_factory=BullpenTradeAnalysisComparison
    )
    actionable_learning: BullpenTradeAnalysisActionableLearning = Field(
        default_factory=BullpenTradeAnalysisActionableLearning
    )
    snapshots: list[BullpenTradeAnalysisSnapshot] = Field(default_factory=list)
    llm_entries: list[BullpenTradeAnalysisLlmEntry] = Field(default_factory=list)
    event_logs: list[BullpenTradeAnalysisEventLog] = Field(default_factory=list)
