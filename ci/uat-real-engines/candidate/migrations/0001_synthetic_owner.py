"""Dedicated UAT database only; never a production metadata/migration import."""
from alembic import op
import sqlalchemy as sa
from app.uat.owner_policy import OWNER_EMAIL
revision='uat_0001'
down_revision=None
branch_labels=('credx_uat',)
depends_on=None


def upgrade():
    op.create_table('uat_synthetic_profiles',
        sa.Column('id',sa.Integer(),primary_key=True),
        sa.Column('email',sa.String(254),nullable=False,unique=True),
        sa.Column('google_sub',sa.String(255),nullable=False,unique=True),
        sa.Column('is_active',sa.Boolean(),nullable=False),
        sa.Column('portfolio',sa.JSON(),nullable=False),
        sa.CheckConstraint('id = 1',name='uat_single_owner'),
        sa.CheckConstraint("email = " + repr(OWNER_EMAIL),name='uat_owner_email'))


def downgrade():
    # Invocation remains a separately authorized destructive action on UAT only.
    op.drop_table('uat_synthetic_profiles')
