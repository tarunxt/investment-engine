"""add polymarket redeem attempts

Revision ID: s8t9u0v1w2x3
Revises: r7s8t9u0v1w2
Create Date: 2026-07-12 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "s8t9u0v1w2x3"
down_revision: Union[str, Sequence[str], None] = "r7s8t9u0v1w2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "polymarket_redeem_attempts",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("condition_id", sa.String(length=255), nullable=False),
        sa.Column("market_id", sa.String(length=500), nullable=True),
        sa.Column("market_title", sa.Text(), nullable=True),
        sa.Column("source", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("execution_response", sa.Text(), nullable=True),
        sa.Column("last_seen_shares", sa.Float(), nullable=True),
        sa.Column("last_seen_claimable_value_usd", sa.Float(), nullable=True),
        sa.Column("last_reconciled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "condition_id",
            name="uq_polymarket_redeem_attempt_user_condition",
        ),
    )
    op.create_index(
        "ix_polymarket_redeem_attempts_user_id",
        "polymarket_redeem_attempts",
        ["user_id"],
    )
    op.create_index(
        "ix_polymarket_redeem_attempts_condition_id",
        "polymarket_redeem_attempts",
        ["condition_id"],
    )
    op.create_index(
        "ix_polymarket_redeem_attempts_market_id",
        "polymarket_redeem_attempts",
        ["market_id"],
    )
    op.create_index(
        "ix_polymarket_redeem_attempts_status",
        "polymarket_redeem_attempts",
        ["status"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_polymarket_redeem_attempts_status",
        table_name="polymarket_redeem_attempts",
    )
    op.drop_index(
        "ix_polymarket_redeem_attempts_market_id",
        table_name="polymarket_redeem_attempts",
    )
    op.drop_index(
        "ix_polymarket_redeem_attempts_condition_id",
        table_name="polymarket_redeem_attempts",
    )
    op.drop_index(
        "ix_polymarket_redeem_attempts_user_id",
        table_name="polymarket_redeem_attempts",
    )
    op.drop_table("polymarket_redeem_attempts")
