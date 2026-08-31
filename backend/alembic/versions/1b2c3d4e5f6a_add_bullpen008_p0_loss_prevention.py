"""add isolated Bullpen 008 P0 loss-prevention tables

Revision ID: 1b2c3d4e5f6a
Revises: 0a1b2c3d4e5f
Create Date: 2026-08-31 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "1b2c3d4e5f6a"
down_revision: str | Sequence[str] | None = "0a1b2c3d4e5f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def _user_run_columns(*, run_nullable: bool = False) -> list[sa.Column]:
    return [
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(64), nullable=run_nullable),
    ]


def _user_run_constraints(*, run_ondelete: str = "CASCADE") -> list[sa.Constraint]:
    return [
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_id"], ["bullpen008_runs.id"], ondelete=run_ondelete),
        sa.PrimaryKeyConstraint("id"),
    ]


def upgrade() -> None:
    op.create_table(
        "bullpen008_risk_classifications",
        *_user_run_columns(),
        sa.Column("workflow_profile", sa.String(64), nullable=False),
        sa.Column("market_id", sa.String(500), nullable=False),
        sa.Column("classifier_version", sa.String(128), nullable=False),
        sa.Column("risk_tier", sa.String(64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        *_user_run_constraints(),
        sa.UniqueConstraint("run_id", "market_id", "classifier_version", name="uq_b008_risk_classification"),
    )
    for column in ("user_id", "run_id", "workflow_profile", "market_id", "risk_tier"):
        op.create_index(f"ix_bullpen008_risk_classifications_{column}", "bullpen008_risk_classifications", [column])

    op.create_table(
        "bullpen008_joint_loss_scenarios",
        *_user_run_columns(),
        sa.Column("workflow_profile", sa.String(64), nullable=False),
        sa.Column("scenario_id", sa.String(128), nullable=False),
        sa.Column("scenario_version", sa.String(128), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("risk_tier", sa.String(64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        *_user_run_constraints(),
        sa.UniqueConstraint("run_id", "scenario_id", name="uq_b008_joint_loss_scenario"),
    )
    for column in ("user_id", "run_id", "workflow_profile", "scenario_id", "status", "risk_tier"):
        op.create_index(f"ix_bullpen008_joint_loss_scenarios_{column}", "bullpen008_joint_loss_scenarios", [column])

    op.create_table(
        "bullpen008_scenario_memberships",
        *_user_run_columns(),
        sa.Column("scenario_id", sa.String(128), nullable=False),
        sa.Column("market_id", sa.String(500), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        *_user_run_constraints(),
        sa.UniqueConstraint("run_id", "scenario_id", "market_id", name="uq_b008_scenario_membership"),
    )
    for column in ("user_id", "run_id", "scenario_id", "market_id"):
        op.create_index(f"ix_bullpen008_scenario_memberships_{column}", "bullpen008_scenario_memberships", [column])

    op.create_table(
        "bullpen008_scenario_exposure_snapshots",
        *_user_run_columns(run_nullable=True),
        sa.Column("scenario_id", sa.String(128), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        *_user_run_constraints(),
    )
    for column in ("user_id", "run_id", "scenario_id", "observed_at"):
        op.create_index(f"ix_bullpen008_scenario_exposure_snapshots_{column}", "bullpen008_scenario_exposure_snapshots", [column])

    op.create_table(
        "bullpen008_evidence_packets",
        *_user_run_columns(),
        sa.Column("market_id", sa.String(500), nullable=False),
        sa.Column("packet_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        *_user_run_constraints(),
        sa.UniqueConstraint("run_id", "market_id", "packet_hash", name="uq_b008_evidence_packet"),
    )
    for column in ("user_id", "run_id", "market_id", "status", "fetched_at"):
        op.create_index(f"ix_bullpen008_evidence_packets_{column}", "bullpen008_evidence_packets", [column])

    op.create_table(
        "bullpen008_regime_change_episodes",
        *_user_run_columns(run_nullable=True),
        sa.Column("scenario_id", sa.String(128), nullable=False),
        sa.Column("episode_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("recovered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        *_user_run_constraints(run_ondelete="SET NULL"),
        sa.UniqueConstraint("user_id", "scenario_id", "episode_hash", name="uq_b008_regime_episode"),
    )
    for column in ("user_id", "run_id", "scenario_id", "status", "activated_at"):
        op.create_index(f"ix_bullpen008_regime_change_episodes_{column}", "bullpen008_regime_change_episodes", [column])

    op.create_table(
        "bullpen008_quote_observations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("market_id", sa.String(500), nullable=False),
        sa.Column("side", sa.String(8), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("held_side_odds", sa.Float(), nullable=False),
        sa.Column("wallet_version", sa.String(64), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "market_id", "side", "observed_at", name="uq_b008_quote_observation"),
    )
    for column in ("user_id", "market_id", "observed_at"):
        op.create_index(f"ix_bullpen008_quote_observations_{column}", "bullpen008_quote_observations", [column])

    op.create_table(
        "bullpen008_contingent_exit_policies",
        *_user_run_columns(),
        sa.Column("market_id", sa.String(500), nullable=False),
        sa.Column("policy_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        *_user_run_constraints(),
        sa.UniqueConstraint("run_id", "policy_hash", name="uq_b008_contingent_policy_hash"),
    )
    for column in ("user_id", "run_id", "market_id", "status"):
        op.create_index(f"ix_bullpen008_contingent_exit_policies_{column}", "bullpen008_contingent_exit_policies", [column])

    op.create_table(
        "bullpen008_contingent_exit_activations",
        *_user_run_columns(),
        sa.Column("market_id", sa.String(500), nullable=False),
        sa.Column("policy_hash", sa.String(64), nullable=False),
        sa.Column("episode_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        *_user_run_constraints(),
        sa.UniqueConstraint("user_id", "policy_hash", "episode_hash", name="uq_b008_contingent_activation"),
    )
    for column in ("user_id", "run_id", "market_id", "policy_hash", "status", "activated_at"):
        op.create_index(f"ix_bullpen008_contingent_exit_activations_{column}", "bullpen008_contingent_exit_activations", [column])

    op.create_table(
        "bullpen008_daily_equity_baselines",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("baseline_date", sa.String(10), nullable=False),
        sa.Column("baseline_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("wallet_version", sa.String(64), nullable=False),
        sa.Column("equity_usd", sa.Float(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "baseline_date", name="uq_b008_daily_equity_baseline"),
    )
    op.create_index("ix_bullpen008_daily_equity_baselines_user_id", "bullpen008_daily_equity_baselines", ["user_id"])
    op.create_index("ix_bullpen008_daily_equity_baselines_baseline_date", "bullpen008_daily_equity_baselines", ["baseline_date"])

    op.create_table(
        "bullpen008_drawdown_episodes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("baseline_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(64), nullable=False),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("recovered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["baseline_id"], ["bullpen008_daily_equity_baselines.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    for column in ("user_id", "baseline_id", "status", "activated_at"):
        op.create_index(f"ix_bullpen008_drawdown_episodes_{column}", "bullpen008_drawdown_episodes", [column])

    op.create_table(
        "bullpen008_scenario_cooldowns",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("scenario_id", sa.String(128), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    for column in ("user_id", "scenario_id", "status", "starts_at", "ends_at"):
        op.create_index(f"ix_bullpen008_scenario_cooldowns_{column}", "bullpen008_scenario_cooldowns", [column])

    op.create_table(
        "bullpen008_pnl_attributions",
        *_user_run_columns(),
        sa.Column("market_id", sa.String(500), nullable=False),
        sa.Column("scenario_id", sa.String(128), nullable=True),
        sa.Column("calendar_day", sa.String(10), nullable=False),
        sa.Column("realized_pnl_usd", sa.Float(), nullable=False),
        sa.Column("unrealized_pnl_usd", sa.Float(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        *_user_run_constraints(),
        sa.UniqueConstraint("run_id", "market_id", "calendar_day", name="uq_b008_pnl_attribution"),
    )
    for column in ("user_id", "run_id", "market_id", "scenario_id", "calendar_day"):
        op.create_index(f"ix_bullpen008_pnl_attributions_{column}", "bullpen008_pnl_attributions", [column])

    op.create_table(
        "bullpen008_loss_prevention_audits",
        *_user_run_columns(),
        sa.Column("market_id", sa.String(500), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        *_user_run_constraints(),
        sa.UniqueConstraint("run_id", "market_id", name="uq_b008_loss_prevention_audit"),
    )
    for column in ("user_id", "run_id", "market_id"):
        op.create_index(f"ix_bullpen008_loss_prevention_audits_{column}", "bullpen008_loss_prevention_audits", [column])


def downgrade() -> None:
    for table in (
        "bullpen008_loss_prevention_audits",
        "bullpen008_pnl_attributions",
        "bullpen008_scenario_cooldowns",
        "bullpen008_drawdown_episodes",
        "bullpen008_daily_equity_baselines",
        "bullpen008_contingent_exit_activations",
        "bullpen008_contingent_exit_policies",
        "bullpen008_quote_observations",
        "bullpen008_regime_change_episodes",
        "bullpen008_evidence_packets",
        "bullpen008_scenario_exposure_snapshots",
        "bullpen008_scenario_memberships",
        "bullpen008_joint_loss_scenarios",
        "bullpen008_risk_classifications",
    ):
        op.drop_table(table)
