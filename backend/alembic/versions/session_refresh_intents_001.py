"""Durable one-way refresh dispatch intent. Contains no credential values."""
from alembic import op
import sqlalchemy as sa
revision = "session_refresh_intents_001"
down_revision = "session_families_001"
branch_labels = None
depends_on = None

def upgrade():
    op.create_table("auth_refresh_intents",
        sa.Column("token_digest", sa.String(64), primary_key=True),
        sa.Column("family_id", sa.String(64), sa.ForeignKey("auth_session_families.id", ondelete="CASCADE"), nullable=False),
        sa.Column("nonce_digest", sa.String(64), nullable=False),
        sa.Column("started", sa.Boolean(), nullable=False))
    op.create_index("ix_auth_refresh_intents_family_id", "auth_refresh_intents", ["family_id"])

def downgrade():
    # Schema rollback is not a safe application rollback after revocation use.
    op.drop_index("ix_auth_refresh_intents_family_id", table_name="auth_refresh_intents")
    op.drop_table("auth_refresh_intents")
