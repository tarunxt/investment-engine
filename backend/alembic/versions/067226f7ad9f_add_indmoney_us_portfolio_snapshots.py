"""add indmoney us portfolio snapshots

Revision ID: 067226f7ad9f
Revises: 9137617b2b5c
Create Date: 2026-05-30 10:02:04.723384

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '067226f7ad9f'
down_revision: Union[str, Sequence[str], None] = '9137617b2b5c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('indmoney_us_portfolio_snapshots',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('snapshot_date', sa.Date(), nullable=False),
    sa.Column('captured_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('source', sa.String(length=32), nullable=False),
    sa.Column('raw_text', sa.Text(), nullable=False),
    sa.Column('parse_status', sa.String(length=32), nullable=False),
    sa.Column('parse_warnings', sa.JSON(), nullable=False),
    sa.Column('holdings_count', sa.Integer(), nullable=False),
    sa.Column('reported_holdings_count', sa.Integer(), nullable=True),
    sa.Column('indices_count', sa.Integer(), nullable=False),
    sa.Column('wallet_balance', sa.Float(), nullable=True),
    sa.Column('current_value', sa.Float(), nullable=True),
    sa.Column('invested_value', sa.Float(), nullable=True),
    sa.Column('day_return_value', sa.Float(), nullable=True),
    sa.Column('day_return_percent', sa.Float(), nullable=True),
    sa.Column('total_return_value', sa.Float(), nullable=True),
    sa.Column('total_return_percent', sa.Float(), nullable=True),
    sa.Column('market_indices', sa.JSON(), nullable=False),
    sa.Column('holdings', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_indmoney_us_portfolio_snapshots_captured_at'), 'indmoney_us_portfolio_snapshots', ['captured_at'], unique=False)
    op.create_index(op.f('ix_indmoney_us_portfolio_snapshots_snapshot_date'), 'indmoney_us_portfolio_snapshots', ['snapshot_date'], unique=False)
    op.create_index(op.f('ix_indmoney_us_portfolio_snapshots_user_id'), 'indmoney_us_portfolio_snapshots', ['user_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_indmoney_us_portfolio_snapshots_user_id'), table_name='indmoney_us_portfolio_snapshots')
    op.drop_index(op.f('ix_indmoney_us_portfolio_snapshots_snapshot_date'), table_name='indmoney_us_portfolio_snapshots')
    op.drop_index(op.f('ix_indmoney_us_portfolio_snapshots_captured_at'), table_name='indmoney_us_portfolio_snapshots')
    op.drop_table('indmoney_us_portfolio_snapshots')
