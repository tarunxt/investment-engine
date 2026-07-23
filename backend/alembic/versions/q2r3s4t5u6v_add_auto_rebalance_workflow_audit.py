"""add durable auto rebalance workflow audit

Revision ID: q2r3s4t5u6v
Revises: u7v8w9x0y1z2
Create Date: 2026-07-24 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "q2r3s4t5u6v"
down_revision: Union[str, Sequence[str], None] = "u7v8w9x0y1z2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "auto_rebalance_workflows",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("portfolio", sa.String(length=32), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("current_stage", sa.String(length=32), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "portfolio",
            "sequence",
            name="uq_auto_rebalance_workflow_user_portfolio_sequence",
        ),
    )
    op.create_index("ix_auto_rebalance_workflows_user_id", "auto_rebalance_workflows", ["user_id"])
    op.create_index("ix_auto_rebalance_workflows_portfolio", "auto_rebalance_workflows", ["portfolio"])
    op.create_index("ix_auto_rebalance_workflows_sequence", "auto_rebalance_workflows", ["sequence"])
    op.create_index("ix_auto_rebalance_workflows_status", "auto_rebalance_workflows", ["status"])

    op.create_table(
        "auto_rebalance_workflow_stages",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("workflow_id", sa.Integer(), nullable=False),
        sa.Column("stage", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("run_id", sa.Integer(), nullable=True),
        sa.Column("job_id", sa.Integer(), nullable=True),
        sa.Column("summary_json", sa.JSON(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["workflow_id"], ["auto_rebalance_workflows.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_id"], ["runs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workflow_id", "stage", name="uq_auto_rebalance_workflow_stage"),
    )
    op.create_index("ix_auto_rebalance_workflow_stages_workflow_id", "auto_rebalance_workflow_stages", ["workflow_id"])
    op.create_index("ix_auto_rebalance_workflow_stages_stage", "auto_rebalance_workflow_stages", ["stage"])
    op.create_index("ix_auto_rebalance_workflow_stages_status", "auto_rebalance_workflow_stages", ["status"])
    op.create_index("ix_auto_rebalance_workflow_stages_run_id", "auto_rebalance_workflow_stages", ["run_id"])
    op.create_index("ix_auto_rebalance_workflow_stages_job_id", "auto_rebalance_workflow_stages", ["job_id"])


def downgrade() -> None:
    op.drop_index("ix_auto_rebalance_workflow_stages_job_id", table_name="auto_rebalance_workflow_stages")
    op.drop_index("ix_auto_rebalance_workflow_stages_run_id", table_name="auto_rebalance_workflow_stages")
    op.drop_index("ix_auto_rebalance_workflow_stages_status", table_name="auto_rebalance_workflow_stages")
    op.drop_index("ix_auto_rebalance_workflow_stages_stage", table_name="auto_rebalance_workflow_stages")
    op.drop_index("ix_auto_rebalance_workflow_stages_workflow_id", table_name="auto_rebalance_workflow_stages")
    op.drop_table("auto_rebalance_workflow_stages")
    op.drop_index("ix_auto_rebalance_workflows_status", table_name="auto_rebalance_workflows")
    op.drop_index("ix_auto_rebalance_workflows_sequence", table_name="auto_rebalance_workflows")
    op.drop_index("ix_auto_rebalance_workflows_portfolio", table_name="auto_rebalance_workflows")
    op.drop_index("ix_auto_rebalance_workflows_user_id", table_name="auto_rebalance_workflows")
    op.drop_table("auto_rebalance_workflows")
