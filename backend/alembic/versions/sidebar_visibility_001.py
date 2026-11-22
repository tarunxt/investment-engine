"""Persist the shared sidebar selection and its edit revision."""
from alembic import op
import sqlalchemy as sa

revision = "sidebar_visibility_001"
down_revision = "jobs_admission_dispatch_001"
branch_labels = None
depends_on = None


def upgrade():
    table = op.create_table(
        "sidebar_visibility",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("visible_ids", sa.JSON(none_as_null=True), nullable=True),
        sa.CheckConstraint("id = 1", name="ck_sidebar_visibility_singleton"),
    )
    op.bulk_insert(table, [{"id": 1, "revision": 0}])


def downgrade():
    op.drop_table("sidebar_visibility")
