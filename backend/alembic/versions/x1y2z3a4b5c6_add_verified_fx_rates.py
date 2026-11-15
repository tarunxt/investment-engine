"""add verified fx rates

Revision ID: x1y2z3a4b5c6
Revises: w9x0y1z2a3b
Create Date: 2026-07-26 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "x1y2z3a4b5c6"
down_revision: Union[str, Sequence[str], None] = "w9x0y1z2a3b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "fx_rates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("base_currency", sa.String(length=3), nullable=False),
        sa.Column("quote_currency", sa.String(length=3), nullable=False),
        sa.Column("rate", sa.Numeric(precision=18, scale=8), nullable=False),
        sa.Column("source", sa.String(length=255), nullable=False),
        sa.Column("source_as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("verified", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "base_currency",
            "quote_currency",
            "source",
            "source_as_of",
            name="uq_fx_rates_pair_source_as_of",
        ),
    )
    op.create_index(
        op.f("ix_fx_rates_base_currency"),
        "fx_rates",
        ["base_currency"],
        unique=False,
    )
    op.create_index(
        op.f("ix_fx_rates_quote_currency"),
        "fx_rates",
        ["quote_currency"],
        unique=False,
    )
    op.create_index(
        op.f("ix_fx_rates_source_as_of"),
        "fx_rates",
        ["source_as_of"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_fx_rates_source_as_of"), table_name="fx_rates")
    op.drop_index(op.f("ix_fx_rates_quote_currency"), table_name="fx_rates")
    op.drop_index(op.f("ix_fx_rates_base_currency"), table_name="fx_rates")
    op.drop_table("fx_rates")
