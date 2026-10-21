"""Extend existing workflow records; never rewrite legacy audit/history."""
from alembic import op
import sqlalchemy as sa
revision='durable_analysis_001'
down_revision='indmoney_integrity_001'
branch_labels=depends_on=None

def upgrade():
    op.add_column('zerodha_portfolio_snapshots',sa.Column('acquisition_json',sa.JSON(),nullable=True))
    for name,kind in [('orchestration_kind',sa.String(24)),('request_key',sa.String(128)),('execution_json',sa.JSON())]:
        op.add_column('auto_rebalance_workflows',sa.Column(name,kind,nullable=True))
    op.add_column('auto_rebalance_workflows',sa.Column('control_version',sa.Integer(),nullable=False,server_default='0'))
    op.create_unique_constraint('uq_analysis_owner_request','auto_rebalance_workflows',['user_id','request_key'])
    op.add_column('auto_rebalance_workflow_stages',sa.Column('checkpoint_json',sa.JSON(),nullable=True))
    op.add_column('auto_rebalance_workflow_stages',sa.Column('attempt_count',sa.Integer(),nullable=False,server_default='0'))

def downgrade():
    op.drop_column('zerodha_portfolio_snapshots','acquisition_json')
    # An approved rollback must preserve all new workflow/checkpoint evidence.
    op.drop_column('auto_rebalance_workflow_stages','attempt_count')
    op.drop_column('auto_rebalance_workflow_stages','checkpoint_json')
    op.drop_constraint('uq_analysis_owner_request','auto_rebalance_workflows',type_='unique')
    for name in ['control_version','execution_json','request_key','orchestration_kind']:op.drop_column('auto_rebalance_workflows',name)
