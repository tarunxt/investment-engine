"""Durable session families; no legacy token/session backfill or invalidation."""
from alembic import op
import sqlalchemy as sa

revision = "session_families_001"
down_revision = "z3a4b5c6d7e8"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "auth_session_families",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("refresh_digest", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
    )
    op.create_index("ix_auth_session_families_user_id", "auth_session_families", ["user_id"])


def downgrade():
    # Operator review required: application downgrade must not restore revoked
    # sessions or accept pre-family tokens. Never invoked by application code.
    op.drop_index("ix_auth_session_families_user_id", table_name="auth_session_families")
    op.drop_table("auth_session_families")
