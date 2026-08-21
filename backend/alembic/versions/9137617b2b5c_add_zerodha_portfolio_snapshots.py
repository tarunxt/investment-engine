"""add zerodha portfolio snapshots

Revision ID: 9137617b2b5c
Revises: 0ca009f851a5
Create Date: 2026-05-30 08:01:53.689216

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9137617b2b5c'
down_revision: Union[str, Sequence[str], None] = '0ca009f851a5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('zerodha_portfolio_snapshots',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('snapshot_date', sa.Date(), nullable=False),
    sa.Column('captured_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('source', sa.String(length=32), nullable=False),
    sa.Column('holdings_count', sa.Integer(), nullable=False),
    sa.Column('net_positions_count', sa.Integer(), nullable=False),
    sa.Column('day_positions_count', sa.Integer(), nullable=False),
    sa.Column('holdings_market_value', sa.Float(), nullable=False),
    sa.Column('holdings_pnl', sa.Float(), nullable=False),
    sa.Column('holdings_day_change_value', sa.Float(), nullable=False),
    sa.Column('positions_pnl', sa.Float(), nullable=False),
    sa.Column('positions_m2m', sa.Float(), nullable=False),
    sa.Column('holdings', sa.JSON(), nullable=False),
    sa.Column('net_positions', sa.JSON(), nullable=False),
    sa.Column('day_positions', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id', 'snapshot_date', name='uq_zerodha_portfolio_snapshots_user_date')
    )
    op.create_index(op.f('ix_zerodha_portfolio_snapshots_snapshot_date'), 'zerodha_portfolio_snapshots', ['snapshot_date'], unique=False)
    op.create_index(op.f('ix_zerodha_portfolio_snapshots_user_id'), 'zerodha_portfolio_snapshots', ['user_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_zerodha_portfolio_snapshots_user_id'), table_name='zerodha_portfolio_snapshots')
    op.drop_index(op.f('ix_zerodha_portfolio_snapshots_snapshot_date'), table_name='zerodha_portfolio_snapshots')
    op.drop_table('zerodha_portfolio_snapshots')
