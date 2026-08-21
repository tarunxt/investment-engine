"""Add run auto-export settings

Revision ID: g1h2i3j4k5l6
Revises: f1e2d3c4b5a6
Create Date: 2026-05-22 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'g1h2i3j4k5l6'
down_revision = 'f1e2d3c4b5a6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('runs', sa.Column('auto_export_enabled', sa.Boolean(), nullable=False, server_default='true'))
    op.add_column('runs', sa.Column('export_spreadsheet_url', sa.Text(), nullable=True))
    op.add_column('runs', sa.Column('export_sheet_name', sa.Text(), nullable=True))
    op.add_column('runs', sa.Column('export_investment_amount', sa.Text(), nullable=True))
    op.add_column('runs', sa.Column('export_title', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('runs', 'export_title')
    op.drop_column('runs', 'export_investment_amount')
    op.drop_column('runs', 'export_sheet_name')
    op.drop_column('runs', 'export_spreadsheet_url')
    op.drop_column('runs', 'auto_export_enabled')
