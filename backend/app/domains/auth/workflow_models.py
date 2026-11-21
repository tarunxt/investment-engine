"""Account-owned stage model choices, stored like the existing mail preference events."""
from __future__ import annotations

import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.auth.models import ActivityLog
from app.domains.jobs.resource_policy import MAX_TARGETS
from app.domains.jobs.resource_validation import MODEL_IDENTIFIER_MAX_CHARS

ModelStage = Literal["swing", "rebalance", "technical", "threats", "pairwise"]
ACTION = "workflow.models_selected"


class StageModelSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stage: ModelStage
    keys: list[Annotated[str, Field(min_length=4, max_length=2 * MODEL_IDENTIFIER_MAX_CHARS + 2)]] = Field(max_length=MAX_TARGETS)

    @model_validator(mode="after")
    def validate_selection(self):
        for key in self.keys:
            parts = key.split("::")
            if len(parts) != 2 or any(not part or len(part) > MODEL_IDENTIFIER_MAX_CHARS or not part.isprintable() or part != part.strip() for part in parts):
                raise ValueError("Expected a provider::model selection")
        return self


async def read_stage_models(db: AsyncSession, user_id: int) -> dict[str, list[str]]:
    latest = select(func.max(ActivityLog.id)).where(
        ActivityLog.user_id == user_id, ActivityLog.action == ACTION,
    ).group_by(ActivityLog.resource_type)
    rows = await db.execute(select(ActivityLog.resource_type, ActivityLog.details).where(ActivityLog.id.in_(latest)))
    return {stage: json.loads(details) for stage, details in rows}


async def save_stage_models(db: AsyncSession, user_id: int, selection: StageModelSelection) -> None:
    db.add(ActivityLog(user_id=user_id, action=ACTION, resource_type=selection.stage,
                       details=json.dumps(selection.keys)))
    await db.commit()
