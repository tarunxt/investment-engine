"""Bind new Kite sessions to their issuing app. Existing sessions use the default app."""
from alembic import op
import sqlalchemy as sa

revision = "kite_account_app_001"
down_revision = "jobs_admission_dispatch_001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("zerodha_credentials", sa.Column("app_binding", sa.String(64), nullable=True))


def downgrade():
    op.drop_column("zerodha_credentials", "app_binding")
