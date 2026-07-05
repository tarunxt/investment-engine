"""add bullpen trade analysis tables

Revision ID: r7s8t9u0v1w2
Revises: p1q2r3s4t5u6
Create Date: 2026-07-05 21:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "r7s8t9u0v1w2"
down_revision: Union[str, Sequence[str], None] = "p1q2r3s4t5u6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "bullpen_trade_analyses",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("entry_reference", sa.String(length=255), nullable=False),
        sa.Column("exit_reference", sa.String(length=255), nullable=True),
        sa.Column("source_variant", sa.String(length=64), nullable=False),
        sa.Column("bot_name", sa.String(length=128), nullable=False),
        sa.Column("strategy_name", sa.String(length=128), nullable=True),
        sa.Column("strategy_version", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("lifecycle_state", sa.String(length=64), nullable=False),
        sa.Column("final_tag", sa.String(length=64), nullable=False),
        sa.Column("pnl_outcome_tag", sa.String(length=32), nullable=False),
        sa.Column("position_key", sa.String(length=512), nullable=True),
        sa.Column("event_id", sa.String(length=255), nullable=True),
        sa.Column("event_slug", sa.String(length=255), nullable=True),
        sa.Column("bullpen_event_id", sa.String(length=255), nullable=True),
        sa.Column("bullpen_market_id", sa.String(length=255), nullable=True),
        sa.Column("outcome_id", sa.String(length=255), nullable=True),
        sa.Column("outcome_name", sa.String(length=255), nullable=True),
        sa.Column("contract_id", sa.String(length=255), nullable=True),
        sa.Column("run_id", sa.String(length=64), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("event_question", sa.Text(), nullable=False),
        sa.Column("event_description", sa.Text(), nullable=True),
        sa.Column("category", sa.String(length=255), nullable=True),
        sa.Column("topic", sa.String(length=255), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("market_url", sa.Text(), nullable=True),
        sa.Column("event_close_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("event_resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("bought_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sold_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("redeemed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("buy_order_id", sa.String(length=255), nullable=True),
        sa.Column("buy_client_order_id", sa.String(length=255), nullable=True),
        sa.Column("buy_submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("buy_executed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("buy_requested_amount", sa.Float(), nullable=True),
        sa.Column("buy_requested_shares", sa.Float(), nullable=True),
        sa.Column("buy_requested_price", sa.Float(), nullable=True),
        sa.Column("buy_requested_odds", sa.Float(), nullable=True),
        sa.Column("buy_filled_amount", sa.Float(), nullable=True),
        sa.Column("buy_filled_shares", sa.Float(), nullable=True),
        sa.Column("buy_average_fill_price", sa.Float(), nullable=True),
        sa.Column("buy_average_fill_odds", sa.Float(), nullable=True),
        sa.Column("buy_fees", sa.Float(), nullable=True),
        sa.Column("buy_slippage", sa.Float(), nullable=True),
        sa.Column("buy_status", sa.String(length=64), nullable=True),
        sa.Column("buy_failure_reason", sa.Text(), nullable=True),
        sa.Column("buy_decision_summary", sa.Text(), nullable=True),
        sa.Column("buy_reason", sa.Text(), nullable=True),
        sa.Column("buy_confidence", sa.Float(), nullable=True),
        sa.Column("buy_risk_score", sa.Float(), nullable=True),
        sa.Column("buy_expected_edge", sa.Float(), nullable=True),
        sa.Column("buy_expected_value", sa.Float(), nullable=True),
        sa.Column("buy_probability_estimate", sa.Float(), nullable=True),
        sa.Column("buy_market_implied_probability", sa.Float(), nullable=True),
        sa.Column("buy_probability_delta", sa.Float(), nullable=True),
        sa.Column("buy_liquidity_score", sa.Float(), nullable=True),
        sa.Column("buy_volume_score", sa.Float(), nullable=True),
        sa.Column("buy_spread_score", sa.Float(), nullable=True),
        sa.Column("buy_volatility_score", sa.Float(), nullable=True),
        sa.Column("buy_news_recency_score", sa.Float(), nullable=True),
        sa.Column("buy_selected_by_rule", sa.Boolean(), nullable=False),
        sa.Column("buy_selected_by_llm", sa.Boolean(), nullable=False),
        sa.Column("buy_selected_by_hybrid_decision", sa.Boolean(), nullable=False),
        sa.Column("buy_computed_tags_json", sa.JSON(), nullable=False),
        sa.Column("buy_rule_checks_json", sa.JSON(), nullable=False),
        sa.Column("exit_type", sa.String(length=64), nullable=True),
        sa.Column("sell_order_id", sa.String(length=255), nullable=True),
        sa.Column("sell_client_order_id", sa.String(length=255), nullable=True),
        sa.Column("sell_submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sell_executed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sell_requested_amount", sa.Float(), nullable=True),
        sa.Column("sell_requested_shares", sa.Float(), nullable=True),
        sa.Column("sell_requested_price", sa.Float(), nullable=True),
        sa.Column("sell_requested_odds", sa.Float(), nullable=True),
        sa.Column("sell_filled_amount", sa.Float(), nullable=True),
        sa.Column("sell_filled_shares", sa.Float(), nullable=True),
        sa.Column("sell_average_fill_price", sa.Float(), nullable=True),
        sa.Column("sell_average_fill_odds", sa.Float(), nullable=True),
        sa.Column("sell_fees", sa.Float(), nullable=True),
        sa.Column("sell_slippage", sa.Float(), nullable=True),
        sa.Column("sell_status", sa.String(length=64), nullable=True),
        sa.Column("sell_failure_reason", sa.Text(), nullable=True),
        sa.Column("sell_decision_summary", sa.Text(), nullable=True),
        sa.Column("sell_reason", sa.Text(), nullable=True),
        sa.Column("sell_confidence", sa.Float(), nullable=True),
        sa.Column("sell_risk_score", sa.Float(), nullable=True),
        sa.Column("sell_expected_edge", sa.Float(), nullable=True),
        sa.Column("sell_expected_value", sa.Float(), nullable=True),
        sa.Column("sell_probability_estimate", sa.Float(), nullable=True),
        sa.Column("sell_market_implied_probability", sa.Float(), nullable=True),
        sa.Column("sell_probability_delta", sa.Float(), nullable=True),
        sa.Column("sell_liquidity_score", sa.Float(), nullable=True),
        sa.Column("sell_volume_score", sa.Float(), nullable=True),
        sa.Column("sell_spread_score", sa.Float(), nullable=True),
        sa.Column("sell_volatility_score", sa.Float(), nullable=True),
        sa.Column("sell_computed_tags_json", sa.JSON(), nullable=False),
        sa.Column("sell_rule_checks_json", sa.JSON(), nullable=False),
        sa.Column("buy_notional", sa.Float(), nullable=True),
        sa.Column("exit_notional", sa.Float(), nullable=True),
        sa.Column("gross_pnl", sa.Float(), nullable=True),
        sa.Column("net_pnl", sa.Float(), nullable=True),
        sa.Column("pnl_percent", sa.Float(), nullable=True),
        sa.Column("fees_total", sa.Float(), nullable=True),
        sa.Column("holding_period_seconds", sa.Integer(), nullable=True),
        sa.Column("realized_return", sa.Float(), nullable=True),
        sa.Column("max_favorable_price", sa.Float(), nullable=True),
        sa.Column("max_adverse_price", sa.Float(), nullable=True),
        sa.Column("best_possible_exit_price_after_buy", sa.Float(), nullable=True),
        sa.Column("worst_price_after_buy", sa.Float(), nullable=True),
        sa.Column("missed_profit_amount", sa.Float(), nullable=True),
        sa.Column("drawdown_while_held", sa.Float(), nullable=True),
        sa.Column("analysis_summary", sa.Text(), nullable=True),
        sa.Column("mistake_category", sa.String(length=128), nullable=True),
        sa.Column("improvement_suggestion", sa.Text(), nullable=True),
        sa.Column("reinforcement_signal", sa.String(length=32), nullable=True),
        sa.Column("reinforcement_score", sa.Float(), nullable=True),
        sa.Column("should_avoid_similar_trade", sa.Boolean(), nullable=False),
        sa.Column(
            "should_increase_confidence_for_similar_trade",
            sa.Boolean(),
            nullable=False,
        ),
        sa.Column("human_review_required", sa.Boolean(), nullable=False),
        sa.Column("reviewer_notes", sa.Text(), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("entry_reference"),
    )
    op.create_index(
        "ix_bullpen_trade_analyses_user_id",
        "bullpen_trade_analyses",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_entry_reference",
        "bullpen_trade_analyses",
        ["entry_reference"],
        unique=True,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_exit_reference",
        "bullpen_trade_analyses",
        ["exit_reference"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_status",
        "bullpen_trade_analyses",
        ["status"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_position_key",
        "bullpen_trade_analyses",
        ["position_key"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_event_id",
        "bullpen_trade_analyses",
        ["event_id"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_bullpen_event_id",
        "bullpen_trade_analyses",
        ["bullpen_event_id"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_bullpen_market_id",
        "bullpen_trade_analyses",
        ["bullpen_market_id"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_run_id",
        "bullpen_trade_analyses",
        ["run_id"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_category",
        "bullpen_trade_analyses",
        ["category"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_topic",
        "bullpen_trade_analyses",
        ["topic"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_user_status",
        "bullpen_trade_analyses",
        ["user_id", "status"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_user_final_tag",
        "bullpen_trade_analyses",
        ["user_id", "final_tag"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_user_pnl_outcome",
        "bullpen_trade_analyses",
        ["user_id", "pnl_outcome_tag"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_user_bought_at",
        "bullpen_trade_analyses",
        ["user_id", "bought_at"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_user_closed_at",
        "bullpen_trade_analyses",
        ["user_id", "closed_at"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analyses_user_strategy_version",
        "bullpen_trade_analyses",
        ["user_id", "strategy_version"],
        unique=False,
    )

    op.create_table(
        "bullpen_trade_analysis_snapshots",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("trade_analysis_id", sa.String(length=64), nullable=False),
        sa.Column("snapshot_type", sa.String(length=32), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("bullpen_snapshot_json", sa.JSON(), nullable=False),
        sa.Column("event_snapshot_json", sa.JSON(), nullable=False),
        sa.Column("market_snapshot_json", sa.JSON(), nullable=False),
        sa.Column("order_book_snapshot_json", sa.JSON(), nullable=False),
        sa.Column("positions_snapshot_json", sa.JSON(), nullable=False),
        sa.Column("raw_api_response_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["trade_analysis_id"],
            ["bullpen_trade_analyses.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_bullpen_trade_analysis_snapshots_trade_analysis_id",
        "bullpen_trade_analysis_snapshots",
        ["trade_analysis_id"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analysis_snapshots_trade_type_time",
        "bullpen_trade_analysis_snapshots",
        ["trade_analysis_id", "snapshot_type", "captured_at"],
        unique=False,
    )

    op.create_table(
        "bullpen_trade_analysis_llm",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("trade_analysis_id", sa.String(length=64), nullable=False),
        sa.Column("phase", sa.String(length=32), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=True),
        sa.Column("model", sa.String(length=128), nullable=True),
        sa.Column("prompt_version", sa.String(length=64), nullable=True),
        sa.Column("prompt_text", sa.Text(), nullable=True),
        sa.Column("raw_output", sa.Text(), nullable=True),
        sa.Column("parsed_output_json", sa.JSON(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("tags_json", sa.JSON(), nullable=False),
        sa.Column("computed_tags_json", sa.JSON(), nullable=False),
        sa.Column("decision_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["trade_analysis_id"],
            ["bullpen_trade_analyses.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_bullpen_trade_analysis_llm_trade_analysis_id",
        "bullpen_trade_analysis_llm",
        ["trade_analysis_id"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analysis_llm_trade_phase",
        "bullpen_trade_analysis_llm",
        ["trade_analysis_id", "phase", "created_at"],
        unique=False,
    )

    op.create_table(
        "bullpen_trade_analysis_event_logs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("trade_analysis_id", sa.String(length=64), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=True),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["trade_analysis_id"],
            ["bullpen_trade_analyses.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_bullpen_trade_analysis_event_logs_trade_analysis_id",
        "bullpen_trade_analysis_event_logs",
        ["trade_analysis_id"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analysis_event_logs_run_id",
        "bullpen_trade_analysis_event_logs",
        ["run_id"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_trade_analysis_event_logs_trade_type_time",
        "bullpen_trade_analysis_event_logs",
        ["trade_analysis_id", "event_type", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_bullpen_trade_analysis_event_logs_trade_type_time",
        table_name="bullpen_trade_analysis_event_logs",
    )
    op.drop_index(
        "ix_bullpen_trade_analysis_event_logs_run_id",
        table_name="bullpen_trade_analysis_event_logs",
    )
    op.drop_index(
        "ix_bullpen_trade_analysis_event_logs_trade_analysis_id",
        table_name="bullpen_trade_analysis_event_logs",
    )
    op.drop_table("bullpen_trade_analysis_event_logs")

    op.drop_index(
        "ix_bullpen_trade_analysis_llm_trade_phase",
        table_name="bullpen_trade_analysis_llm",
    )
    op.drop_index(
        "ix_bullpen_trade_analysis_llm_trade_analysis_id",
        table_name="bullpen_trade_analysis_llm",
    )
    op.drop_table("bullpen_trade_analysis_llm")

    op.drop_index(
        "ix_bullpen_trade_analysis_snapshots_trade_type_time",
        table_name="bullpen_trade_analysis_snapshots",
    )
    op.drop_index(
        "ix_bullpen_trade_analysis_snapshots_trade_analysis_id",
        table_name="bullpen_trade_analysis_snapshots",
    )
    op.drop_table("bullpen_trade_analysis_snapshots")

    op.drop_index(
        "ix_bullpen_trade_analyses_user_strategy_version",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index(
        "ix_bullpen_trade_analyses_user_closed_at",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index(
        "ix_bullpen_trade_analyses_user_bought_at",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index(
        "ix_bullpen_trade_analyses_user_pnl_outcome",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index(
        "ix_bullpen_trade_analyses_user_final_tag",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index(
        "ix_bullpen_trade_analyses_user_status",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index("ix_bullpen_trade_analyses_topic", table_name="bullpen_trade_analyses")
    op.drop_index(
        "ix_bullpen_trade_analyses_category",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index("ix_bullpen_trade_analyses_run_id", table_name="bullpen_trade_analyses")
    op.drop_index(
        "ix_bullpen_trade_analyses_bullpen_market_id",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index(
        "ix_bullpen_trade_analyses_bullpen_event_id",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index(
        "ix_bullpen_trade_analyses_event_id",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index(
        "ix_bullpen_trade_analyses_position_key",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index(
        "ix_bullpen_trade_analyses_status",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index(
        "ix_bullpen_trade_analyses_exit_reference",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index(
        "ix_bullpen_trade_analyses_entry_reference",
        table_name="bullpen_trade_analyses",
    )
    op.drop_index(
        "ix_bullpen_trade_analyses_user_id",
        table_name="bullpen_trade_analyses",
    )
    op.drop_table("bullpen_trade_analyses")
