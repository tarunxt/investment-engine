"""add polymarket auto live order intents

Revision ID: t1u2v3w4x5y6
Revises: s8t9u0v1w2x3
Create Date: 2026-07-18 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "t1u2v3w4x5y6"
down_revision: Union[str, Sequence[str], None] = "s8t9u0v1w2x3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "polymarket_auto_live_order_intents",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("decision_id", sa.String(length=64), nullable=True),
        sa.Column("dependency_group", sa.String(length=128), nullable=True),
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("market_id", sa.String(length=500), nullable=False),
        sa.Column("slug", sa.String(length=500), nullable=True),
        sa.Column("condition_id", sa.String(length=255), nullable=True),
        sa.Column("side", sa.String(length=8), nullable=True),
        sa.Column("requested_order_usd", sa.Float(), nullable=True),
        sa.Column("requested_shares", sa.Float(), nullable=True),
        sa.Column("requested_limit_price_cents", sa.Float(), nullable=True),
        sa.Column("current_order_usd", sa.Float(), nullable=True),
        sa.Column("current_shares", sa.Float(), nullable=True),
        sa.Column("current_limit_price_cents", sa.Float(), nullable=True),
        sa.Column("max_slippage_cents", sa.Float(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("error_class", sa.String(length=64), nullable=True),
        sa.Column("last_error_code", sa.String(length=64), nullable=True),
        sa.Column("last_error_message", sa.Text(), nullable=True),
        sa.Column("retryable", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("remote_order_id", sa.String(length=255), nullable=True),
        sa.Column("remote_transaction_hash", sa.String(length=255), nullable=True),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("reserved_cash_usd", sa.Float(), nullable=False, server_default="0"),
        sa.Column("expected_release_usd", sa.Float(), nullable=False, server_default="0"),
        sa.Column("confirmed_release_usd", sa.Float(), nullable=False, server_default="0"),
        sa.Column("filled_shares", sa.Float(), nullable=False, server_default="0"),
        sa.Column("remaining_shares", sa.Float(), nullable=False, server_default="0"),
        sa.Column("average_fill_price_cents", sa.Float(), nullable=True),
        sa.Column("dependency_metadata_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("execution_metadata_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("first_submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("terminal_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["decision_id"], ["polymarket_auto_live_decisions.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["run_id"], ["polymarket_auto_live_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_poly_auto_live_order_intents_status_next_attempt_at",
        "polymarket_auto_live_order_intents",
        ["status", "next_attempt_at"],
    )
    op.create_index(
        "ix_poly_auto_live_order_intents_run_id",
        "polymarket_auto_live_order_intents",
        ["run_id"],
    )
    op.create_index(
        "ix_poly_auto_live_order_intents_user_id",
        "polymarket_auto_live_order_intents",
        ["user_id"],
    )
    op.create_index(
        "ix_poly_auto_live_order_intents_decision_id",
        "polymarket_auto_live_order_intents",
        ["decision_id"],
    )
    op.create_index(
        "ix_poly_auto_live_order_intents_idempotency_key",
        "polymarket_auto_live_order_intents",
        ["idempotency_key"],
        unique=True,
    )
    op.create_index(
        "ix_poly_auto_live_order_intents_remote_order_id",
        "polymarket_auto_live_order_intents",
        ["remote_order_id"],
    )
    op.create_index(
        "ix_poly_auto_live_order_intents_dependency_group",
        "polymarket_auto_live_order_intents",
        ["dependency_group"],
    )

    op.create_table(
        "polymarket_auto_live_order_attempts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("intent_id", sa.String(length=64), nullable=False),
        sa.Column("attempt_number", sa.Integer(), nullable=False),
        sa.Column("worker_task_id", sa.String(length=255), nullable=True),
        sa.Column("rpc_provider", sa.String(length=64), nullable=True),
        sa.Column("executor_path", sa.String(length=128), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result_status", sa.String(length=32), nullable=False),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("retry_after_seconds", sa.Integer(), nullable=True),
        sa.Column("remote_order_id", sa.String(length=255), nullable=True),
        sa.Column("remote_transaction_hash", sa.String(length=255), nullable=True),
        sa.Column("sanitized_request_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("sanitized_response_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("reconciliation_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["intent_id"], ["polymarket_auto_live_order_intents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_poly_auto_live_order_attempts_intent_attempt_number",
        "polymarket_auto_live_order_attempts",
        ["intent_id", "attempt_number"],
        unique=True,
    )

    op.create_table(
        "polymarket_auto_live_capital_reservations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("order_intent_id", sa.String(length=64), nullable=False),
        sa.Column("amount_usd", sa.Float(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["order_intent_id"], ["polymarket_auto_live_order_intents.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("order_intent_id"),
    )
    op.create_index(
        "ix_poly_auto_live_capital_reservations_user_id_status",
        "polymarket_auto_live_capital_reservations",
        ["user_id", "status"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_poly_auto_live_capital_reservations_user_id_status",
        table_name="polymarket_auto_live_capital_reservations",
    )
    op.drop_table("polymarket_auto_live_capital_reservations")

    op.drop_index(
        "ix_poly_auto_live_order_attempts_intent_attempt_number",
        table_name="polymarket_auto_live_order_attempts",
    )
    op.drop_table("polymarket_auto_live_order_attempts")

    op.drop_index(
        "ix_poly_auto_live_order_intents_dependency_group",
        table_name="polymarket_auto_live_order_intents",
    )
    op.drop_index(
        "ix_poly_auto_live_order_intents_remote_order_id",
        table_name="polymarket_auto_live_order_intents",
    )
    op.drop_index(
        "ix_poly_auto_live_order_intents_idempotency_key",
        table_name="polymarket_auto_live_order_intents",
    )
    op.drop_index(
        "ix_poly_auto_live_order_intents_decision_id",
        table_name="polymarket_auto_live_order_intents",
    )
    op.drop_index(
        "ix_poly_auto_live_order_intents_user_id",
        table_name="polymarket_auto_live_order_intents",
    )
    op.drop_index(
        "ix_poly_auto_live_order_intents_run_id",
        table_name="polymarket_auto_live_order_intents",
    )
    op.drop_index(
        "ix_poly_auto_live_order_intents_status_next_attempt_at",
        table_name="polymarket_auto_live_order_intents",
    )
    op.drop_table("polymarket_auto_live_order_intents")
