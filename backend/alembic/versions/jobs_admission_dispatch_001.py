"""Add durable actor admission and per-child analysis dispatch metadata.

No historical backfill/cleanup or live relay activation. Existing outbox rows
retain NULL dispatch fields and are never selected by the analysis relay.
"""
from alembic import op
import sqlalchemy as sa

revision = "jobs_admission_dispatch_001"
down_revision = "audit7_run_policy_001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "job_admissions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("operation", sa.String(64), nullable=False),
        sa.Column("request_key_hash", sa.String(64), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("jobs.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "operation", "request_key_hash", name="uq_job_admission_actor_key"),
        sa.UniqueConstraint("job_id", name="uq_job_admissions_job_id"),
    )
    op.add_column("outbox", sa.Column("job_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_outbox_job_id", "outbox", "jobs", ["job_id"], ["id"])
    op.create_unique_constraint("uq_outbox_job_id", "outbox", ["job_id"])
    op.add_column("outbox", sa.Column("state", sa.String(32), nullable=True))
    op.create_index("ix_outbox_state", "outbox", ["state"])
    op.add_column("outbox", sa.Column("claim_token", sa.String(36), nullable=True))
    op.add_column("outbox", sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("outbox", sa.Column("last_error_type", sa.String(100), nullable=True))


def downgrade():
    # Roll back the application, retaining additive data. Dropping this ledger
    # would let old HTTP retries create duplicate jobs and erase obligations.
    raise RuntimeError("Durable admission/dispatch records require a separately reviewed retention plan")
