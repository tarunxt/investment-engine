"""Version Stage 2 publications, scorecard jobs and weighted results."""
from alembic import op
import sqlalchemy as sa

revision = "scorecard_revisions_001"
down_revision = "jobs_admission_dispatch_001"
branch_labels = None
depends_on = None


def identity():
    return sa.Column("id", sa.Integer(), primary_key=True)


def reference(name, target):
    return sa.Column(name, sa.Integer(), sa.ForeignKey(target), nullable=False, index=True)


def timestamps():
    return [sa.Column(name, sa.DateTime(), nullable=False) for name in ("created_at", "updated_at")]


def upgrade():
    op.create_table("scorecard_revisions", identity(), reference("workflow_id", "auto_rebalance_workflows.id"),
                    sa.Column("request_key", sa.String(80), nullable=False), sa.Column("digest", sa.String(64), nullable=False),
                    sa.Column("manifest", sa.JSON(), nullable=False), *timestamps(), sa.UniqueConstraint("workflow_id", "request_key"))
    op.create_table("scorecard_attempts", identity(), reference("revision_id", "scorecard_revisions.id"),
                    reference("workflow_id", "auto_rebalance_workflows.id"), sa.Column("card", sa.String(20), nullable=False),
                    sa.Column("request_key", sa.String(80), nullable=False), sa.Column("settings_json", sa.JSON(), nullable=False),
                    sa.Column("result_json", sa.JSON()), *timestamps(), sa.UniqueConstraint("revision_id", "card", "request_key"))
    op.create_table("scorecard_batches", identity(), reference("attempt_id", "scorecard_attempts.id"),
                    sa.Column("ordinal", sa.Integer(), nullable=False),
                    sa.Column("run_id", sa.Integer(), sa.ForeignKey("runs.id"), nullable=False, unique=True),
                    sa.UniqueConstraint("attempt_id", "ordinal"))
    op.create_table("scorecard_finals", identity(), reference("revision_id", "scorecard_revisions.id"),
                    reference("workflow_id", "auto_rebalance_workflows.id"), sa.Column("digest", sa.String(64), nullable=False),
                    sa.Column("result_json", sa.JSON(), nullable=False), *timestamps(), sa.UniqueConstraint("workflow_id", "digest"))


def downgrade():
    for name in ("scorecard_finals", "scorecard_batches", "scorecard_attempts", "scorecard_revisions"):
        op.drop_table(name)

