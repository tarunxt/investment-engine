"""Durable sports ranking snapshots, independent of trading state."""
from alembic import op
import sqlalchemy as sa

revision = "sports_rankings_001"
down_revision = "3d4e5f6a7b8c"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "sports_ranking_snapshots",
        sa.Column("source_id", sa.String(80), primary_key=True),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("rows", sa.JSON(), nullable=False),
        sa.Column("source_url", sa.Text()),
        sa.Column("source_as_of", sa.String(40)),
        sa.Column("season", sa.String(40)),
        sa.Column("checked_at", sa.DateTime(timezone=True)),
        sa.Column("successful_at", sa.DateTime(timezone=True)),
        sa.Column("content_hash", sa.String(64)),
        sa.Column("error", sa.Text()),
    )


def downgrade():
    op.drop_table("sports_ranking_snapshots")
