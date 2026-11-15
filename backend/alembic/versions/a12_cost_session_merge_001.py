"""Join durable cost collection and the current session migration lineage."""

revision = "a12_cost_session_merge_001"
down_revision = ("a12_collection_intent_001", "auth_session_merge_001")
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
