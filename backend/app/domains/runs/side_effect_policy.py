"""Immutable per-workflow opt-out; legacy absence retains existing preferences."""
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from app.shared.exceptions import AppException


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
    try:
        return permits_side_effects((await session.execute(workflow_policy_query(execution))).scalar_one_or_none())
    except DBAPIError as exc:
        await session.rollback()
        if missing_policy_column(exc):
            raise WorkflowSchemaNotReady() from exc
        raise


def execution_allows_side_effects_sync(session, execution) -> bool:
    if not getattr(execution, "auto_rebalance_portfolio", None) or getattr(execution, "auto_rebalance_sequence", None) is None:
        return True
    try:
        return permits_side_effects(session.execute(workflow_policy_query(execution)).scalar_one_or_none())
    except DBAPIError as exc:
        session.rollback()
        if missing_policy_column(exc):
            raise WorkflowSchemaNotReady() from exc
        raise


class WorkflowSchemaNotReady(AppException):
    def __init__(self):
        super().__init__(message="Workflow history and policy are unavailable until the workflow schema is ready.", code="WORKFLOW_SCHEMA_NOT_READY", status_code=503)


def missing_policy_column(exc):
    """Only the named missing column; never reinterpret other database errors."""
    original = exc.orig
    state = getattr(original, "sqlstate", None) or getattr(original, "pgcode", None)
    cause = getattr(original, "__cause__", None)
    state = state or getattr(cause, "sqlstate", None)
    message = str(original)
    if state == "42703":
        return re.search(r'column (?:(?:"?\w+"?)\.)?"?side_effect_policy_json"? does not exist', message) is not None
    # SQLite is used only in offline tests/local development.
    return state is None and message == "no such column: auto_rebalance_workflows.side_effect_policy_json"


async def require_workflow_policy_schema(session):
    from app.domains.runs.models import AutoRebalanceWorkflow
    try:
        # No rows, no values, no cache: repeated reads recover after migration.
        await session.execute(select(AutoRebalanceWorkflow.side_effect_policy_json).limit(0))
    except DBAPIError as exc:
        await session.rollback()
        if missing_policy_column(exc):
            raise WorkflowSchemaNotReady() from exc
        raise
