"""Add google_sheets_master_url to user_profiles

Revision ID: h3i4j5k6l7m8
Revises: g1h2i3j4k5l6
Create Date: 2026-05-22 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'h3i4j5k6l7m8'
down_revision = 'g1h2i3j4k5l6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('user_profiles', sa.Column('google_sheets_master_url', sa.String(500), nullable=True))


def downgrade() -> None:
    op.drop_column('user_profiles', 'google_sheets_master_url')
