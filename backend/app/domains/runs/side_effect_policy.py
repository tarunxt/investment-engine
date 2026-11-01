"""Immutable per-workflow opt-out; legacy absence retains existing preferences."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator
from sqlalchemy import select


class RunSideEffectPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1]
    mode: Literal["existing_preferences", "analysis_only"]

    @field_validator("version", mode="before")
    @classmethod
    def exact_version(cls, value):
        if type(value) is not int:
            raise ValueError("version must be an integer")
        return value


def permits_side_effects(policy: dict | None) -> bool:
    if policy is None:
        return True  # Existing runs and omitted policies retain their behavior.
    try:
        return RunSideEffectPolicy.model_validate(policy).mode == "existing_preferences"
    except ValidationError:
        return False  # Unknown persisted contracts cannot authorize external sends.


def workflow_policy_query(execution):
    from app.domains.runs.models import AutoRebalanceWorkflow
    return select(AutoRebalanceWorkflow.side_effect_policy_json).where(
        AutoRebalanceWorkflow.user_id == execution.user_id,
        AutoRebalanceWorkflow.portfolio == execution.auto_rebalance_portfolio,
        AutoRebalanceWorkflow.sequence == execution.auto_rebalance_sequence,
    )


async def execution_allows_side_effects(session, execution) -> bool:
    if not getattr(execution, "auto_rebalance_portfolio", None) or getattr(execution, "auto_rebalance_sequence", None) is None:
        return True
    return permits_side_effects((await session.execute(workflow_policy_query(execution))).scalar_one_or_none())


def execution_allows_side_effects_sync(session, execution) -> bool:
    if not getattr(execution, "auto_rebalance_portfolio", None) or getattr(execution, "auto_rebalance_sequence", None) is None:
        return True
    return permits_side_effects(session.execute(workflow_policy_query(execution)).scalar_one_or_none())
