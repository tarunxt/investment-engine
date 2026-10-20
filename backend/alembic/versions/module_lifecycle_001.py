"""Persist module lifecycle fencing on existing selections and owned work."""
from alembic import op
import sqlalchemy as sa
revision='module_lifecycle_001'
down_revision='user_modules_001'
branch_labels=None
depends_on=None

def upgrade():
    op.add_column('user_modules',sa.Column('schedules_paused',sa.Boolean(),nullable=False,server_default=sa.true()))
    for table in ('jobs','runs','auto_rebalance_workflows'):
        op.add_column(table,sa.Column('module_id',sa.String(40),nullable=True))
        op.add_column(table,sa.Column('module_version',sa.Integer(),nullable=True))
        op.add_column(table,sa.Column('module_cancel_requested',sa.Boolean(),nullable=False,server_default=sa.false()))
    # No legacy attribution or schedule enablement is invented. Existing owner,
    # provider, output/history, role and connection values are preserved.

def downgrade():
    for table in ('auto_rebalance_workflows','runs','jobs'):
        for name in ('module_cancel_requested','module_version','module_id'):op.drop_column(table,name)
    op.drop_column('user_modules','schedules_paused')
