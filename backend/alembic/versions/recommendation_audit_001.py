"""Immutable recommendation provenance and bounded verification ledger."""
from alembic import op
import sqlalchemy as sa

revision = "recommendation_audit_001"
down_revision = "api_attempt_events_001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('recommendation_evidence',
        sa.Column('id', sa.String(length=36), nullable=False, primary_key=True),
        sa.Column('user_id', sa.Integer(), nullable=False, primary_key=False),
        sa.Column('kind', sa.String(length=32), nullable=False, primary_key=False),
        sa.Column('source_key', sa.String(length=128), nullable=False, primary_key=False),
        sa.Column('run_id', sa.Integer(), nullable=True, primary_key=False),
        sa.Column('job_id', sa.Integer(), nullable=True, primary_key=False),
        sa.Column('content_hash', sa.String(length=64), nullable=False, primary_key=False),
        sa.Column('captured_at', sa.DateTime(timezone=True), nullable=False, primary_key=False),
        sa.Column('payload', sa.JSON(), nullable=False, primary_key=False),
        sa.Column('content', sa.Text(), nullable=True, primary_key=False),
        sa.UniqueConstraint('user_id', 'kind', 'source_key', 'content_hash', name='uq_recommendation_evidence_revision'),
    )
    op.create_index('ix_recommendation_evidence_job_id', 'recommendation_evidence', ['job_id'], unique=False)
    op.create_index('ix_recommendation_evidence_run_id', 'recommendation_evidence', ['run_id'], unique=False)
    op.create_index('ix_recommendation_evidence_source_key', 'recommendation_evidence', ['source_key'], unique=False)
    op.create_index('ix_recommendation_evidence_user_id', 'recommendation_evidence', ['user_id'], unique=False)
    op.create_table('recommendation_decisions',
        sa.Column('id', sa.String(length=36), nullable=False, primary_key=True),
        sa.Column('user_id', sa.Integer(), nullable=False, primary_key=False),
        sa.Column('run_id', sa.Integer(), nullable=False, primary_key=False),
        sa.Column('market', sa.String(length=16), nullable=False, primary_key=False),
        sa.Column('symbol', sa.String(length=64), nullable=False, primary_key=False),
        sa.Column('exchange', sa.String(length=32), nullable=False, primary_key=False),
        sa.Column('decision_at', sa.DateTime(timezone=True), nullable=False, primary_key=False),
        sa.Column('captured_at', sa.DateTime(timezone=True), nullable=False, primary_key=False),
        sa.Column('provenance', sa.String(length=32), nullable=False, primary_key=False),
        sa.Column('content_hash', sa.String(length=64), nullable=False, primary_key=False),
        sa.Column('payload', sa.JSON(), nullable=False, primary_key=False),
        sa.UniqueConstraint('user_id', 'content_hash', name='uq_recommendation_decision_revision'),
    )
    op.create_index('ix_recommendation_decisions_decision_at', 'recommendation_decisions', ['decision_at'], unique=False)
    op.create_index('ix_recommendation_decisions_market', 'recommendation_decisions', ['market'], unique=False)
    op.create_index('ix_recommendation_decisions_run_id', 'recommendation_decisions', ['run_id'], unique=False)
    op.create_index('ix_recommendation_decisions_symbol', 'recommendation_decisions', ['symbol'], unique=False)
    op.create_index('ix_recommendation_decisions_user_id', 'recommendation_decisions', ['user_id'], unique=False)
    op.create_table('recommendation_verifications',
        sa.Column('id', sa.String(length=36), nullable=False, primary_key=True),
        sa.Column('user_id', sa.Integer(), nullable=False, primary_key=False),
        sa.Column('current_id', sa.String(length=36), nullable=False, primary_key=False),
        sa.Column('previous_id', sa.String(length=36), nullable=True, primary_key=False),
        sa.Column('request_hash', sa.String(length=64), nullable=False, primary_key=False),
        sa.Column('idempotency_key', sa.String(length=128), nullable=False, primary_key=False),
        sa.Column('request', sa.JSON(), nullable=False, primary_key=False),
        sa.Column('status', sa.String(length=32), nullable=False, primary_key=False),
        sa.Column('verdict', sa.String(length=32), nullable=True, primary_key=False),
        sa.Column('result', sa.JSON(), nullable=True, primary_key=False),
        sa.Column('error', sa.String(length=1000), nullable=True, primary_key=False),
        sa.Column('budget_usd', sa.Numeric(precision=18, scale=8), nullable=False, primary_key=False),
        sa.Column('spent_usd', sa.Numeric(precision=18, scale=8), nullable=False, primary_key=False),
        sa.Column('reserved_usd', sa.Numeric(precision=18, scale=8), nullable=False, primary_key=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, primary_key=False),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True, primary_key=False),
        sa.Column('lease_until', sa.DateTime(timezone=True), nullable=True, primary_key=False),
        sa.Column('fence', sa.Integer(), nullable=False, primary_key=False),
        sa.Column('dispatch_pending', sa.Boolean(), nullable=False, primary_key=False),
        sa.Column('last_dispatch_at', sa.DateTime(timezone=True), nullable=True, primary_key=False),
        sa.UniqueConstraint('user_id', 'idempotency_key', name='uq_recommendation_verification_key'),
        sa.UniqueConstraint('user_id', 'request_hash', name='uq_recommendation_verification_request'),
    )
    op.create_index('ix_recommendation_verifications_status', 'recommendation_verifications', ['status'], unique=False)
    op.create_index('ix_recommendation_verifications_user_id', 'recommendation_verifications', ['user_id'], unique=False)
    op.create_table('recommendation_spend_accounts',
        sa.Column('id', sa.String(length=36), nullable=False, primary_key=True),
        sa.Column('user_id', sa.Integer(), nullable=False, primary_key=False),
        sa.Column('day', sa.String(length=10), nullable=False, primary_key=False),
        sa.Column('cap_usd', sa.Numeric(precision=18, scale=8), nullable=False, primary_key=False),
        sa.Column('spent_usd', sa.Numeric(precision=18, scale=8), nullable=False, primary_key=False),
        sa.Column('reserved_usd', sa.Numeric(precision=18, scale=8), nullable=False, primary_key=False),
        sa.UniqueConstraint('user_id', 'day', name='uq_recommendation_spend_day'),
    )
    op.create_table('recommendation_spend_attempts',
        sa.Column('id', sa.String(length=36), nullable=False, primary_key=True),
        sa.Column('verification_id', sa.String(length=36), nullable=False, primary_key=False),
        sa.Column('user_id', sa.Integer(), nullable=False, primary_key=False),
        sa.Column('account_id', sa.String(length=36), nullable=False, primary_key=False),
        sa.Column('attempt_key', sa.String(length=128), nullable=False, primary_key=False),
        sa.Column('adapter', sa.String(length=100), nullable=False, primary_key=False),
        sa.Column('tariff_version', sa.String(length=100), nullable=False, primary_key=False),
        sa.Column('upper_bound_usd', sa.Numeric(precision=18, scale=8), nullable=False, primary_key=False),
        sa.Column('actual_usd', sa.Numeric(precision=18, scale=8), nullable=True, primary_key=False),
        sa.Column('status', sa.String(length=32), nullable=False, primary_key=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, primary_key=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True, primary_key=False),
        sa.UniqueConstraint('verification_id', 'attempt_key', name='uq_recommendation_attempt'),
    )
    op.create_index('ix_recommendation_spend_attempts_verification_id', 'recommendation_spend_attempts', ['verification_id'], unique=False)
    # Database triggers also prevent Core/bulk updates that bypass ORM events.
    if op.get_bind().dialect.name == "postgresql":
        op.execute("""CREATE FUNCTION reject_recommendation_evidence_mutation() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'Recommendation evidence is append-only'; END; $$ LANGUAGE plpgsql""")
        op.execute("CREATE TRIGGER recommendation_evidence_immutable BEFORE UPDATE OR DELETE ON recommendation_evidence FOR EACH ROW EXECUTE FUNCTION reject_recommendation_evidence_mutation()")
        op.execute("CREATE TRIGGER recommendation_decisions_immutable BEFORE UPDATE OR DELETE ON recommendation_decisions FOR EACH ROW EXECUTE FUNCTION reject_recommendation_evidence_mutation()")


def downgrade():
    # Financial audit history must never be automatically discarded.
    raise RuntimeError("Destructive audit downgrade requires an explicit archival/migration plan")
