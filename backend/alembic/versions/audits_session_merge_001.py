"""Join additive audit ledgers and session families without activation.

Application rollback retains both parent schemas and durable records. This
metadata-only merge does not authorize legacy-session cutover or parent downgrade.
"""

revision = "audits_session_merge_001"
down_revision = ("a12_three_head_merge_001", "session_families_001")
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
