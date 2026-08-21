"""recover Bullpen Auto-Live Stage 2 LLM targets

Revision ID: c6d7e8f9g0h1
Revises: b5c6d7e8f9g0
Create Date: 2026-08-10

PR #770 made the console refuse to enable a new Bullpen Auto-Live schedule
without Stage 2 LLM targets. Schedules that were already enabled before that
frontend guard can still have an empty persisted ``console_llm_targets`` list.
Those schedules keep producing runs whose frozen Stage 2 target snapshot is
empty, so Stage 2 executes 0/0 LLM calls and Stage 3 has no authoritative
handoff.

This one-time data repair restores the most recent historically persisted,
non-empty target selection for an already-enabled console schedule. The source
is immutable run evidence only: first the run's frozen Stage 2 target snapshot,
then the run-audit settings snapshot. No provider/model is invented.
"""

from __future__ import annotations

from typing import Any

from alembic import op
import sqlalchemy as sa


revision = "c6d7e8f9g0h1"
down_revision = "b5c6d7e8f9g0"
branch_labels = None
depends_on = None

CONSOLE_PROFILE_ID = "bullpen_console_top10"


def _normalize_targets(value: object) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []

    normalized: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        provider = item.get("provider")
        model = item.get("model")
        if not isinstance(provider, str) or not isinstance(model, str):
            continue
        provider = provider.strip()
        model = model.strip()
        if not provider or not model:
            continue
        key = (provider, model)
        if key in seen:
            continue
        seen.add(key)
        normalized.append({"provider": provider, "model": model})
    return normalized


def _targets_from_run_payload(payload: object) -> list[dict[str, str]]:
    if not isinstance(payload, dict):
        return []

    frozen_targets = _normalize_targets(payload.get("stage2_llm_targets_snapshot"))
    if frozen_targets:
        return frozen_targets

    audit_metadata = payload.get("audit_metadata")
    if not isinstance(audit_metadata, dict):
        return []
    settings_snapshot = audit_metadata.get("settings_snapshot")
    if not isinstance(settings_snapshot, dict):
        return []
    return _normalize_targets(settings_snapshot.get("console_llm_targets"))


def upgrade() -> None:
    bind = op.get_bind()

    settings_table = sa.table(
        "polymarket_auto_live_settings",
        sa.column("user_id", sa.Integer()),
        sa.column("payload", sa.JSON()),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    runs_table = sa.table(
        "polymarket_auto_live_runs",
        sa.column("user_id", sa.Integer()),
        sa.column("started_at", sa.DateTime(timezone=True)),
        sa.column("payload", sa.JSON()),
    )

    settings_rows = bind.execute(
        sa.select(settings_table.c.user_id, settings_table.c.payload)
    ).mappings()

    missing_by_user: dict[int, dict[str, Any]] = {}
    for row in settings_rows:
        payload = row["payload"]
        if not isinstance(payload, dict):
            continue
        if payload.get("strategy_profile") != CONSOLE_PROFILE_ID:
            continue
        if payload.get("auto_live_enabled") is not True:
            continue
        if _normalize_targets(payload.get("console_llm_targets")):
            continue
        missing_by_user[int(row["user_id"])] = dict(payload)

    if not missing_by_user:
        return

    run_rows = bind.execute(
        sa.select(
            runs_table.c.user_id,
            runs_table.c.started_at,
            runs_table.c.payload,
        )
        .where(runs_table.c.user_id.in_(tuple(missing_by_user)))
        .order_by(runs_table.c.user_id.asc(), runs_table.c.started_at.desc())
    ).mappings()

    recovered_by_user: dict[int, list[dict[str, str]]] = {}
    for row in run_rows:
        user_id = int(row["user_id"])
        if user_id in recovered_by_user:
            continue
        targets = _targets_from_run_payload(row["payload"])
        if targets:
            recovered_by_user[user_id] = targets

    for user_id, targets in recovered_by_user.items():
        repaired_payload = dict(missing_by_user[user_id])
        repaired_payload["console_llm_targets"] = targets
        bind.execute(
            settings_table.update()
            .where(settings_table.c.user_id == user_id)
            .values(payload=repaired_payload, updated_at=sa.func.now())
        )


def downgrade() -> None:
    # This migration restores a previously persisted user choice from immutable
    # run evidence. Removing that recovered choice on downgrade would be a
    # destructive guess, so the data repair is intentionally retained.
    pass
