"""add polymarket auto live tables

Revision ID: k6l7m8n9o0p1
Revises: d4e5f6a7b8c9, j2k3l4m5n6o7
Create Date: 2026-06-21 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "k6l7m8n9o0p1"
down_revision: Union[str, Sequence[str], None] = (
    "d4e5f6a7b8c9",
    "j2k3l4m5n6o7",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "polymarket_auto_live_settings",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )

    op.create_table(
        "polymarket_auto_live_states",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("running", sa.Boolean(), nullable=False),
        sa.Column("paused", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("mode", sa.String(length=32), nullable=False),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )
    op.create_index(
        "ix_polymarket_auto_live_states_running",
        "polymarket_auto_live_states",
        ["running"],
    )
    op.create_index(
        "ix_polymarket_auto_live_states_paused",
        "polymarket_auto_live_states",
        ["paused"],
    )
    op.create_index(
        "ix_polymarket_auto_live_states_next_run_at",
        "polymarket_auto_live_states",
        ["next_run_at"],
    )

    op.create_table(
        "polymarket_auto_live_runs",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("triggered_by", sa.String(length=32), nullable=False),
        sa.Column("dry_run", sa.Boolean(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("live_execution_requested", sa.Boolean(), nullable=False),
        sa.Column("live_execution_attempted", sa.Boolean(), nullable=False),
        sa.Column("decisions_count", sa.Integer(), nullable=False),
        sa.Column("orders_planned", sa.Integer(), nullable=False),
        sa.Column("orders_submitted", sa.Integer(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_polymarket_auto_live_runs_user_id",
        "polymarket_auto_live_runs",
        ["user_id"],
    )
    op.create_index(
        "ix_polymarket_auto_live_runs_status",
        "polymarket_auto_live_runs",
        ["status"],
    )
    op.create_index(
        "ix_polymarket_auto_live_runs_started_at",
        "polymarket_auto_live_runs",
        ["started_at"],
    )

    op.create_table(
        "polymarket_auto_live_decisions",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("market_id", sa.String(length=500), nullable=False),
        sa.Column("slug", sa.String(length=500), nullable=True),
        sa.Column("market_title", sa.Text(), nullable=False),
        sa.Column("side", sa.String(length=8), nullable=False),
        sa.Column("decision", sa.String(length=32), nullable=False),
        sa.Column("risk_status", sa.String(length=32), nullable=False),
        sa.Column("edge_pp", sa.Float(), nullable=False),
        sa.Column("score", sa.Float(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["polymarket_auto_live_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_polymarket_auto_live_decisions_user_id",
        "polymarket_auto_live_decisions",
        ["user_id"],
    )
    op.create_index(
        "ix_polymarket_auto_live_decisions_run_id",
        "polymarket_auto_live_decisions",
        ["run_id"],
    )
    op.create_index(
        "ix_polymarket_auto_live_decisions_market_id",
        "polymarket_auto_live_decisions",
        ["market_id"],
    )
    op.create_index(
        "ix_polymarket_auto_live_decisions_slug",
        "polymarket_auto_live_decisions",
        ["slug"],
    )
    op.create_index(
        "ix_polymarket_auto_live_decisions_decision",
        "polymarket_auto_live_decisions",
        ["decision"],
    )

    op.create_table(
        "polymarket_auto_live_positions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("market_id", sa.String(length=500), nullable=False),
        sa.Column("slug", sa.String(length=500), nullable=True),
        sa.Column("market_title", sa.Text(), nullable=False),
        sa.Column("market_url", sa.Text(), nullable=True),
        sa.Column("theme", sa.String(length=255), nullable=False),
        sa.Column("side", sa.String(length=8), nullable=False),
        sa.Column("exposure_usd", sa.Float(), nullable=False),
        sa.Column("shares", sa.Float(), nullable=False),
        sa.Column("average_price_cents", sa.Float(), nullable=False),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_polymarket_auto_live_positions_user_id",
        "polymarket_auto_live_positions",
        ["user_id"],
    )
    op.create_index(
        "ix_polymarket_auto_live_positions_market_id",
        "polymarket_auto_live_positions",
        ["market_id"],
    )
    op.create_index(
        "ix_polymarket_auto_live_positions_slug",
        "polymarket_auto_live_positions",
        ["slug"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_polymarket_auto_live_positions_slug",
        table_name="polymarket_auto_live_positions",
    )
    op.drop_index(
        "ix_polymarket_auto_live_positions_market_id",
        table_name="polymarket_auto_live_positions",
    )
    op.drop_index(
        "ix_polymarket_auto_live_positions_user_id",
        table_name="polymarket_auto_live_positions",
    )
    op.drop_table("polymarket_auto_live_positions")

    op.drop_index(
        "ix_polymarket_auto_live_decisions_decision",
        table_name="polymarket_auto_live_decisions",
    )
    op.drop_index(
        "ix_polymarket_auto_live_decisions_slug",
        table_name="polymarket_auto_live_decisions",
    )
    op.drop_index(
        "ix_polymarket_auto_live_decisions_market_id",
        table_name="polymarket_auto_live_decisions",
    )
    op.drop_index(
        "ix_polymarket_auto_live_decisions_run_id",
        table_name="polymarket_auto_live_decisions",
    )
    op.drop_index(
        "ix_polymarket_auto_live_decisions_user_id",
        table_name="polymarket_auto_live_decisions",
    )
    op.drop_table("polymarket_auto_live_decisions")

    op.drop_index(
        "ix_polymarket_auto_live_runs_started_at",
        table_name="polymarket_auto_live_runs",
    )
    op.drop_index(
        "ix_polymarket_auto_live_runs_status",
        table_name="polymarket_auto_live_runs",
    )
    op.drop_index(
        "ix_polymarket_auto_live_runs_user_id",
        table_name="polymarket_auto_live_runs",
    )
    op.drop_table("polymarket_auto_live_runs")

    op.drop_index(
        "ix_polymarket_auto_live_states_next_run_at",
        table_name="polymarket_auto_live_states",
    )
    op.drop_index(
        "ix_polymarket_auto_live_states_paused",
        table_name="polymarket_auto_live_states",
    )
    op.drop_index(
        "ix_polymarket_auto_live_states_running",
        table_name="polymarket_auto_live_states",
    )
    op.drop_table("polymarket_auto_live_states")

    op.drop_table("polymarket_auto_live_settings")
