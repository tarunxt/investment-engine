from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.domains.bullpen_run_audit.provenance import build_native_run_audit_metadata
from app.domains.bullpen_run_audit.service import materialize_run_audit_snapshot_sync
from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveSettings


def build_run_audit_metadata_for_settings(
    settings: BullpenAutoLiveSettings,
) -> dict[str, Any]:
    return build_native_run_audit_metadata(
        settings_snapshot=settings.model_dump(mode="json"),
        prompt_template=settings.console_llm_prompt_template,
        execution_version=None,
        strategy_version=settings.strategy_profile,
    )


def materialize_run_snapshot(
    session: Session,
    *,
    user_id: int,
    run_id: str,
    freeze: bool | None = None,
    force: bool = False,
) -> None:
    materialize_run_audit_snapshot_sync(
        session,
        user_id=user_id,
        run_id=run_id,
        freeze=freeze,
        force=force,
    )

