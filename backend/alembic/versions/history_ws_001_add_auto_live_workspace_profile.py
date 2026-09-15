"""add compact Bullpen workflow ownership to Auto-Live runs

Revision ID: history_ws_001
Revises: sports_rankings_001
Create Date: 2026-09-15 10:05:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "history_ws_001"
down_revision: str | Sequence[str] | None = "sports_rankings_001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "polymarket_auto_live_runs",
        sa.Column("workspace_profile", sa.String(length=32), nullable=True),
    )
    op.create_index(
        "ix_polymarket_auto_live_runs_user_workspace_started_at",
        "polymarket_auto_live_runs",
        ["user_id", "workspace_profile", "started_at"],
        unique=False,
    )

    # Bullpen Sports ownership was introduced immediately before this column.
    # Restrict the one-time JSON read to recent indexed rows; older null rows are
    # intentionally interpreted as legacy Bullpen 007 without touching their
    # multi-gigabyte aggregate TOAST payloads.
    connection = op.get_bind()
    if connection.dialect.name == "postgresql":
        op.execute(
            sa.text(
                """
                UPDATE polymarket_auto_live_runs
                SET workspace_profile = 'bullpen-sports'
                WHERE started_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
                  AND payload #>> '{request_context,console_profile,workspace_profile}'
                      = 'bullpen-sports'
                """
            )
        )
    elif connection.dialect.name == "sqlite":
        op.execute(
            sa.text(
                """
                UPDATE polymarket_auto_live_runs
                SET workspace_profile = 'bullpen-sports'
                WHERE started_at >= datetime(CURRENT_TIMESTAMP, '-7 days')
                  AND json_extract(
                        payload,
                        '$.request_context.console_profile.workspace_profile'
                      ) = 'bullpen-sports'
                """
            )
        )


def downgrade() -> None:
    op.drop_index(
        "ix_polymarket_auto_live_runs_user_workspace_started_at",
        table_name="polymarket_auto_live_runs",
    )
    op.drop_column("polymarket_auto_live_runs", "workspace_profile")
