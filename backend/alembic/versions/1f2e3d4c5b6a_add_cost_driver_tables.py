"""add cost driver tables

Revision ID: 1f2e3d4c5b6a
Revises: j2k3l4m5n6o7
Create Date: 2026-06-18 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = "1f2e3d4c5b6a"
down_revision = "j2k3l4m5n6o7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cost_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("captured_at", sa.DateTime(), nullable=False),
        sa.Column("source", sa.String(length=50), nullable=False),
        sa.Column("period_start", sa.DateTime(), nullable=False),
        sa.Column("period_end", sa.DateTime(), nullable=False),
        sa.Column("service", sa.String(length=255), nullable=True),
        sa.Column("usage_type", sa.String(length=255), nullable=True),
        sa.Column("operation", sa.String(length=255), nullable=True),
        sa.Column("region", sa.String(length=64), nullable=True),
        sa.Column("resource_id", sa.String(length=255), nullable=True),
        sa.Column("usage_quantity", sa.Float(), nullable=True),
        sa.Column("usage_unit", sa.String(length=64), nullable=True),
        sa.Column("actual_cost_usd", sa.Float(), nullable=True),
        sa.Column("estimated_cost_usd", sa.Float(), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_cost_snapshots_id"), "cost_snapshots", ["id"], unique=False)
    op.create_index(op.f("ix_cost_snapshots_source"), "cost_snapshots", ["source"], unique=False)
    op.create_table(
        "traffic_cost_rollups",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("period_start", sa.DateTime(), nullable=False),
        sa.Column("period_end", sa.DateTime(), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("method", sa.String(length=16), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=False),
        sa.Column("content_type", sa.String(length=255), nullable=True),
        sa.Column("extension", sa.String(length=32), nullable=True),
        sa.Column("request_count", sa.Integer(), nullable=False),
        sa.Column("response_bytes", sa.Integer(), nullable=False),
        sa.Column("cache_hit_count", sa.Integer(), nullable=False),
        sa.Column("bot_request_count", sa.Integer(), nullable=False),
        sa.Column("top_user_agent", sa.String(length=255), nullable=True),
        sa.Column("estimated_transfer_cost_usd", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_traffic_cost_rollups_id"), "traffic_cost_rollups", ["id"], unique=False)
    op.create_index(op.f("ix_traffic_cost_rollups_period_start"), "traffic_cost_rollups", ["period_start"], unique=False)
    op.create_table(
        "cost_recommendations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("captured_at", sa.DateTime(), nullable=False),
        sa.Column("driver_key", sa.String(length=255), nullable=False),
        sa.Column("severity", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("explanation", sa.Text(), nullable=False),
        sa.Column("suggested_action", sa.Text(), nullable=False),
        sa.Column("estimated_monthly_savings_usd", sa.Float(), nullable=True),
        sa.Column("confidence", sa.String(length=32), nullable=False),
        sa.Column("evidence_json", sa.JSON(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_cost_recommendations_driver_key"), "cost_recommendations", ["driver_key"], unique=False)
    op.create_index(op.f("ix_cost_recommendations_id"), "cost_recommendations", ["id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_cost_recommendations_id"), table_name="cost_recommendations")
    op.drop_index(op.f("ix_cost_recommendations_driver_key"), table_name="cost_recommendations")
    op.drop_table("cost_recommendations")
    op.drop_index(op.f("ix_traffic_cost_rollups_period_start"), table_name="traffic_cost_rollups")
    op.drop_index(op.f("ix_traffic_cost_rollups_id"), table_name="traffic_cost_rollups")
    op.drop_table("traffic_cost_rollups")
    op.drop_index(op.f("ix_cost_snapshots_source"), table_name="cost_snapshots")
    op.drop_index(op.f("ix_cost_snapshots_id"), table_name="cost_snapshots")
    op.drop_table("cost_snapshots")
