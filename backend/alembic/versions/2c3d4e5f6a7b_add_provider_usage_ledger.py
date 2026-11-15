"""add provider usage ledger and reconciled daily snapshots

Revision ID: 2c3d4e5f6a7b
Revises: 1b2c3d4e5f6a
Create Date: 2026-09-04 04:20:00.000000
"""

from collections.abc import Sequence
from datetime import UTC, date, datetime

import sqlalchemy as sa
from alembic import op

revision: str = "2c3d4e5f6a7b"
down_revision: str | Sequence[str] | None = "1b2c3d4e5f6a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "llm_provider_usage_calls",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("job_id", sa.Integer(), nullable=True),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("model", sa.String(length=128), nullable=False),
        sa.Column("provider_request_id", sa.String(length=255), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("tokens_in", sa.BigInteger(), nullable=False),
        sa.Column("tokens_out", sa.BigInteger(), nullable=False),
        sa.Column("cache_hit_tokens", sa.BigInteger(), nullable=False),
        sa.Column("cache_miss_tokens", sa.BigInteger(), nullable=False),
        sa.Column("actual_cost", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "provider",
            "provider_request_id",
            name="uq_llm_provider_usage_call_request",
        ),
    )
    for column in ("user_id", "job_id", "provider", "occurred_at"):
        op.create_index(
            f"ix_llm_provider_usage_calls_{column}",
            "llm_provider_usage_calls",
            [column],
        )

    op.create_table(
        "llm_provider_usage_daily_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("model", sa.String(length=128), nullable=False),
        sa.Column("usage_date", sa.Date(), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("requests", sa.Integer(), nullable=False),
        sa.Column("tokens_in", sa.BigInteger(), nullable=False),
        sa.Column("tokens_out", sa.BigInteger(), nullable=False),
        sa.Column("cache_hit_tokens", sa.BigInteger(), nullable=False),
        sa.Column("cache_miss_tokens", sa.BigInteger(), nullable=False),
        sa.Column("actual_cost", sa.Float(), nullable=False),
        sa.Column("source", sa.String(length=128), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "provider",
            "usage_date",
            "timezone",
            name="uq_llm_provider_usage_daily_snapshot",
        ),
    )
    for column in ("user_id", "provider", "usage_date"):
        op.create_index(
            f"ix_llm_provider_usage_daily_snapshots_{column}",
            "llm_provider_usage_daily_snapshots",
            [column],
        )

    # Evidence-backed historical reconciliation from the authenticated DeepSeek
    # provider console captured on 4 Sep 2026. This is account ledger data, not
    # an estimate reconstructed from Cred-X jobs.
    users = sa.table(
        "users",
        sa.column("id", sa.Integer()),
        sa.column("email", sa.String()),
    )
    snapshots = sa.table(
        "llm_provider_usage_daily_snapshots",
        sa.column("user_id", sa.Integer()),
        sa.column("provider", sa.String()),
        sa.column("model", sa.String()),
        sa.column("usage_date", sa.Date()),
        sa.column("timezone", sa.String()),
        sa.column("requests", sa.Integer()),
        sa.column("tokens_in", sa.BigInteger()),
        sa.column("tokens_out", sa.BigInteger()),
        sa.column("cache_hit_tokens", sa.BigInteger()),
        sa.column("cache_miss_tokens", sa.BigInteger()),
        sa.column("actual_cost", sa.Float()),
        sa.column("source", sa.String()),
        sa.column("captured_at", sa.DateTime(timezone=True)),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    connection = op.get_bind()
    user_id = connection.execute(
        sa.select(users.c.id).where(users.c.email == "tarun.singh6893@gmail.com")
    ).scalar_one_or_none()
    if user_id is not None:
        captured_at = datetime(2026, 9, 4, 4, 6, tzinfo=UTC)
        created_at = captured_at.replace(tzinfo=None)
        connection.execute(
            snapshots.insert().values(
                user_id=user_id,
                provider="deepseek",
                model="deepseek-v4-flash",
                usage_date=date(2026, 9, 3),
                timezone="Asia/Kolkata",
                requests=232,
                tokens_in=4_238_239,
                tokens_out=2_708_635,
                cache_hit_tokens=1_085_568,
                cache_miss_tokens=3_152_671,
                actual_cost=2.84,
                source="DeepSeek provider console",
                captured_at=captured_at,
                created_at=created_at,
                updated_at=created_at,
            )
        )


def downgrade() -> None:
    op.drop_table("llm_provider_usage_daily_snapshots")
    op.drop_table("llm_provider_usage_calls")
