"""add daily dashboard portfolio snapshots

Revision ID: d7e8f9g0h1i2
Revises: c6d7e8f9g0h1
Create Date: 2026-08-23 12:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d7e8f9g0h1i2"
down_revision: Union[str, Sequence[str], None] = "c6d7e8f9g0h1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "dashboard_portfolio_daily_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("snapshot_date", sa.Date(), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("usd_inr_rate", sa.Float(), nullable=True),
        sa.Column("zerodha_total_inr", sa.Float(), nullable=True),
        sa.Column("zerodha_source_date", sa.Date(), nullable=True),
        sa.Column(
            "zerodha_carried_forward",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("indmoney_total_usd", sa.Float(), nullable=True),
        sa.Column("indmoney_total_inr", sa.Float(), nullable=True),
        sa.Column("indmoney_source_date", sa.Date(), nullable=True),
        sa.Column(
            "indmoney_carried_forward",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("bullpen_total_usd", sa.Float(), nullable=True),
        sa.Column("bullpen_total_inr", sa.Float(), nullable=True),
        sa.Column("combined_total_inr", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "snapshot_date",
            name="uq_dashboard_portfolio_daily_snapshots_user_date",
        ),
    )
    op.create_index(
        op.f("ix_dashboard_portfolio_daily_snapshots_user_id"),
        "dashboard_portfolio_daily_snapshots",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_dashboard_portfolio_daily_snapshots_snapshot_date"),
        "dashboard_portfolio_daily_snapshots",
        ["snapshot_date"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_dashboard_portfolio_daily_snapshots_snapshot_date"),
        table_name="dashboard_portfolio_daily_snapshots",
    )
    op.drop_index(
        op.f("ix_dashboard_portfolio_daily_snapshots_user_id"),
        table_name="dashboard_portfolio_daily_snapshots",
    )
    op.drop_table("dashboard_portfolio_daily_snapshots")
