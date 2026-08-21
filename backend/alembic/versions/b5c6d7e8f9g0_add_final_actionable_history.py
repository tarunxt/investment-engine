"""add durable final actionable history

Revision ID: b5c6d7e8f9g0
Revises: a4b5c6d7e8f9
Create Date: 2026-08-06
"""

from alembic import op
import sqlalchemy as sa

revision = "b5c6d7e8f9g0"
down_revision = "a4b5c6d7e8f9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "final_actionable_history",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("workflow_id", sa.Integer(), nullable=True),
        sa.Column("auto_rebalance_sequence", sa.Integer(), nullable=True),
        sa.Column("rebalance_run_id", sa.Integer(), nullable=False),
        sa.Column("market", sa.String(length=16), nullable=False),
        sa.Column("stock_symbol", sa.String(length=64), nullable=False),
        sa.Column("stock_name", sa.String(length=255), nullable=True),
        sa.Column("covered_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("action", sa.String(length=32), nullable=True),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("consensus_numerator", sa.Integer(), nullable=True),
        sa.Column("consensus_denominator", sa.Integer(), nullable=True),
        sa.Column("historical_current_units", sa.Float(), nullable=True),
        sa.Column("historical_current_value", sa.Float(), nullable=True),
        sa.Column("action_units", sa.Float(), nullable=True),
        sa.Column("amount", sa.Float(), nullable=True),
        sa.Column("technical_scan_run_id", sa.Integer(), nullable=True),
        sa.Column("formula_version", sa.String(length=64), nullable=False),
        sa.Column("formula_inputs_json", sa.JSON(), nullable=True),
        sa.Column("source_run_ids_json", sa.JSON(), nullable=True),
        sa.Column("snapshot_json", sa.JSON(), nullable=True),
        sa.Column("coverage_status", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["rebalance_run_id"], ["runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["technical_scan_run_id"], ["runs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["workflow_id"], ["auto_rebalance_workflows.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "market",
            "rebalance_run_id",
            "stock_symbol",
            name="uq_final_actionable_history_run_stock",
        ),
    )
    op.create_index(
        "ix_final_actionable_history_lookup",
        "final_actionable_history",
        ["user_id", "market", "stock_symbol", "covered_at", "id"],
        unique=False,
    )
    for column in (
        "id",
        "user_id",
        "workflow_id",
        "auto_rebalance_sequence",
        "rebalance_run_id",
        "market",
        "stock_symbol",
        "covered_at",
        "technical_scan_run_id",
        "coverage_status",
    ):
        op.create_index(
            f"ix_final_actionable_history_{column}",
            "final_actionable_history",
            [column],
            unique=False,
        )


def downgrade() -> None:
    op.drop_table("final_actionable_history")
