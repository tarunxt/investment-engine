"""PRIVATE TEST CANDIDATE: join additive jobs, cost intent and spend branches.

No activation or ledger deletion. Application rollback retains additive schema.
Sibling downgrades are not a production recovery procedure.
"""

revision = "a12_three_head_merge_001"
down_revision = (
    "jobs_admission_dispatch_001",
    "a12_collection_intent_001",
    "rebalance_spend_refund_002",
)
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    # Unjoining revision metadata must not remove any retained schema/data.
    pass
