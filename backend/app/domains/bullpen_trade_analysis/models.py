from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.database.base import Base, TimestampMixin


class BullpenTradeAnalysisRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_trade_analyses"
    __table_args__ = (
        Index("ix_bullpen_trade_analyses_user_status", "user_id", "status"),
        Index("ix_bullpen_trade_analyses_user_final_tag", "user_id", "final_tag"),
        Index("ix_bullpen_trade_analyses_user_pnl_outcome", "user_id", "pnl_outcome_tag"),
        Index("ix_bullpen_trade_analyses_user_bought_at", "user_id", "bought_at"),
        Index("ix_bullpen_trade_analyses_user_closed_at", "user_id", "closed_at"),
        Index(
            "ix_bullpen_trade_analyses_user_strategy_version",
            "user_id",
            "strategy_version",
        ),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    entry_reference: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        unique=True,
        index=True,
    )
    exit_reference: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        index=True,
    )
    source_variant: Mapped[str] = mapped_column(String(64), default="unknown", nullable=False)
    bot_name: Mapped[str] = mapped_column(
        String(128),
        default="Bullpen x AI",
        nullable=False,
    )
    strategy_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    strategy_version: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="OPEN", nullable=False, index=True)
    lifecycle_state: Mapped[str] = mapped_column(
        String(64),
        default="BUY_EXECUTED_ONLY",
        nullable=False,
    )
    final_tag: Mapped[str] = mapped_column(String(64), default="OPEN", nullable=False)
    pnl_outcome_tag: Mapped[str] = mapped_column(
        String(32),
        default="OPEN",
        nullable=False,
    )
    position_key: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    event_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    event_slug: Mapped[str | None] = mapped_column(String(255), nullable=True)
    bullpen_event_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    bullpen_market_id: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        index=True,
    )
    outcome_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    outcome_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    contract_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    event_question: Mapped[str] = mapped_column(Text, nullable=False)
    event_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    topic: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    market_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    event_close_time: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    event_resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    bought_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sold_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    redeemed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    buy_order_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    buy_client_order_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    buy_submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    buy_executed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    buy_requested_amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_requested_shares: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_requested_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_requested_odds: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_filled_amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_filled_shares: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_average_fill_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_average_fill_odds: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_fees: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_slippage: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    buy_failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    buy_decision_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    buy_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    buy_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_risk_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_expected_edge: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_expected_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_probability_estimate: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_market_implied_probability: Mapped[float | None] = mapped_column(
        Float,
        nullable=True,
    )
    buy_probability_delta: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_liquidity_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_volume_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_spread_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_volatility_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_news_recency_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    buy_selected_by_rule: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    buy_selected_by_llm: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    buy_selected_by_hybrid_decision: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
    )
    buy_computed_tags_json: Mapped[list[object]] = mapped_column(
        JSON,
        default=list,
        nullable=False,
    )
    buy_rule_checks_json: Mapped[list[object]] = mapped_column(
        JSON,
        default=list,
        nullable=False,
    )

    exit_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sell_order_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sell_client_order_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sell_submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    sell_executed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    sell_requested_amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_requested_shares: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_requested_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_requested_odds: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_filled_amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_filled_shares: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_average_fill_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_average_fill_odds: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_fees: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_slippage: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sell_failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    sell_decision_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    sell_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    sell_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_risk_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_expected_edge: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_expected_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_probability_estimate: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_market_implied_probability: Mapped[float | None] = mapped_column(
        Float,
        nullable=True,
    )
    sell_probability_delta: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_liquidity_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_volume_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_spread_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_volatility_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    sell_computed_tags_json: Mapped[list[object]] = mapped_column(
        JSON,
        default=list,
        nullable=False,
    )
    sell_rule_checks_json: Mapped[list[object]] = mapped_column(
        JSON,
        default=list,
        nullable=False,
    )

    buy_notional: Mapped[float | None] = mapped_column(Float, nullable=True)
    exit_notional: Mapped[float | None] = mapped_column(Float, nullable=True)
    gross_pnl: Mapped[float | None] = mapped_column(Float, nullable=True)
    net_pnl: Mapped[float | None] = mapped_column(Float, nullable=True)
    pnl_percent: Mapped[float | None] = mapped_column(Float, nullable=True)
    fees_total: Mapped[float | None] = mapped_column(Float, nullable=True)
    holding_period_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    realized_return: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_favorable_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_adverse_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    best_possible_exit_price_after_buy: Mapped[float | None] = mapped_column(
        Float,
        nullable=True,
    )
    worst_price_after_buy: Mapped[float | None] = mapped_column(Float, nullable=True)
    missed_profit_amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    drawdown_while_held: Mapped[float | None] = mapped_column(Float, nullable=True)

    analysis_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    mistake_category: Mapped[str | None] = mapped_column(String(128), nullable=True)
    improvement_suggestion: Mapped[str | None] = mapped_column(Text, nullable=True)
    reinforcement_signal: Mapped[str | None] = mapped_column(String(32), nullable=True)
    reinforcement_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    should_avoid_similar_trade: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
    )
    should_increase_confidence_for_similar_trade: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
    )
    human_review_required: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
    )
    reviewer_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )

    snapshots: Mapped[list["BullpenTradeAnalysisSnapshotRecord"]] = relationship(
        back_populates="trade",
        cascade="all, delete-orphan",
        order_by="BullpenTradeAnalysisSnapshotRecord.captured_at",
    )
    llm_entries: Mapped[list["BullpenTradeAnalysisLlmRecord"]] = relationship(
        back_populates="trade",
        cascade="all, delete-orphan",
        order_by="BullpenTradeAnalysisLlmRecord.created_at",
    )
    event_logs: Mapped[list["BullpenTradeAnalysisEventLogRecord"]] = relationship(
        back_populates="trade",
        cascade="all, delete-orphan",
        order_by="BullpenTradeAnalysisEventLogRecord.created_at",
    )


class BullpenTradeAnalysisSnapshotRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_trade_analysis_snapshots"
    __table_args__ = (
        Index(
            "ix_bullpen_trade_analysis_snapshots_trade_type_time",
            "trade_analysis_id",
            "snapshot_type",
            "captured_at",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trade_analysis_id: Mapped[str] = mapped_column(
        ForeignKey("bullpen_trade_analyses.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    snapshot_type: Mapped[str] = mapped_column(String(32), nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    bullpen_snapshot_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )
    event_snapshot_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )
    market_snapshot_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )
    order_book_snapshot_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )
    positions_snapshot_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )
    raw_api_response_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )

    trade: Mapped[BullpenTradeAnalysisRecord] = relationship(back_populates="snapshots")


class BullpenTradeAnalysisLlmRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_trade_analysis_llm"
    __table_args__ = (
        Index(
            "ix_bullpen_trade_analysis_llm_trade_phase",
            "trade_analysis_id",
            "phase",
            "created_at",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trade_analysis_id: Mapped[str] = mapped_column(
        ForeignKey("bullpen_trade_analyses.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    phase: Mapped[str] = mapped_column(String(32), nullable=False)
    provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    prompt_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    prompt_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw_output: Mapped[str | None] = mapped_column(Text, nullable=True)
    parsed_output_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    tags_json: Mapped[list[object]] = mapped_column(JSON, default=list, nullable=False)
    computed_tags_json: Mapped[list[object]] = mapped_column(
        JSON,
        default=list,
        nullable=False,
    )
    decision_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )

    trade: Mapped[BullpenTradeAnalysisRecord] = relationship(back_populates="llm_entries")


class BullpenTradeAnalysisEventLogRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_trade_analysis_event_logs"
    __table_args__ = (
        Index(
            "ix_bullpen_trade_analysis_event_logs_trade_type_time",
            "trade_analysis_id",
            "event_type",
            "created_at",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trade_analysis_id: Mapped[str] = mapped_column(
        ForeignKey("bullpen_trade_analyses.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )

    trade: Mapped[BullpenTradeAnalysisRecord] = relationship(back_populates="event_logs")
