"""Extend the existing attributable spend ledger; no parallel budget registry."""
from alembic import op
import sqlalchemy as sa
revision='ai_limits_001'
down_revision='durable_analysis_001'
branch_labels=depends_on=None

def upgrade():
    op.add_column('recommendation_spend_accounts',sa.Column('last_admitted_owner',sa.Integer(),nullable=True))
    op.alter_column('recommendation_spend_attempts','verification_id',existing_type=sa.String(36),nullable=True)
    for name,kind in [('operation_key',sa.String(128)),('module_id',sa.String(64)),('module_version',sa.Integer()),('request_hash',sa.String(64)),('limits_json',sa.JSON()),('input_tokens',sa.Integer()),('output_tokens',sa.Integer())]:
        op.add_column('recommendation_spend_attempts',sa.Column(name,kind,nullable=True))
    op.create_index('ix_recommendation_spend_attempts_operation_key','recommendation_spend_attempts',['operation_key'])
    op.create_unique_constraint('uq_analysis_spend_attempt','recommendation_spend_attempts',['user_id','operation_key','attempt_key'])

def downgrade():
    # Never silently discard new spend evidence or invent verification parents.
    connection=op.get_bind()
    if connection.scalar(sa.text('SELECT count(*) FROM recommendation_spend_attempts WHERE operation_key IS NOT NULL')):
        raise RuntimeError('Stage13 spend evidence requires guarded backup/restore; downgrade refused')
    op.drop_constraint('uq_analysis_spend_attempt','recommendation_spend_attempts',type_='unique')
    op.drop_index('ix_recommendation_spend_attempts_operation_key',table_name='recommendation_spend_attempts')
    for name in ['operation_key','module_id','module_version','request_hash','limits_json','input_tokens','output_tokens']:
        op.drop_column('recommendation_spend_attempts',name)
    op.alter_column('recommendation_spend_attempts','verification_id',existing_type=sa.String(36),nullable=False)
    op.drop_column('recommendation_spend_accounts','last_admitted_owner')
