"""Join session readiness with the existing main migration head."""
revision = 'auth_session_merge_001'
down_revision = ('audit7_run_policy_001', 'session_refresh_intents_001')
branch_labels = None
depends_on = None
def upgrade():
    pass
def downgrade():
    pass
