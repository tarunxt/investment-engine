"""Resolve optional usage dimensions from authenticated persisted job links."""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import or_, select

from app.domains.runs.models import AutoRebalanceWorkflow, AutoRebalanceWorkflowStage, Run, RunJob
from app.domains.runs.run_identity import analysis_run_identity

logger = logging.getLogger(__name__)


def resolve_job_usage_identity(db: Any, job: Any) -> dict[str, str | None]:
    """No model-name dedup or guessed sample ordinal; unknown links stay unknown.

    Job IDs are the existing independent sample identities. A RunJob link adds
    its stable membership identity; this never collapses repeated model targets.
    Metadata lookup is isolated from the job transaction so telemetry failures
    cannot leave that transaction aborted.
    """
    identity = analysis_run_identity(job)
    job_id = getattr(job, "id", None)
    dimensions: dict[str, str | None] = {
        "run_id": None,
        "workflow_id": None,
        "market": identity.market,
        "stage": identity.stage,
        "sample_id": f"job:{job_id}" if isinstance(job_id, int) and not isinstance(job_id, bool) else None,
    }
    user_id = getattr(job, "user_id", None)
    if user_id is None or job_id is None:
        return dimensions
    if not callable(getattr(db, "begin_nested", None)):
        return dimensions
    stage_conflicted = False
    try:
        with db.begin_nested():
            links = db.execute(
                select(
                    RunJob.id.label("run_job_id"), RunJob.run_id,
                    Run.prompt, Run.auto_rebalance_portfolio, Run.auto_rebalance_label,
                )
                .join(Run, Run.id == RunJob.run_id)
                .where(RunJob.job_id == job_id, Run.user_id == user_id)
            ).all()
            run_id = links[0].run_id if len(links) == 1 else None
            if len(links) == 1:
                linked_identity = analysis_run_identity(links[0])
                # Prefer the persisted parent, but don't assert a conflicting link.
                if not (identity.market and linked_identity.market and identity.market != linked_identity.market):
                    stage_conflicted = bool(identity.stage and linked_identity.stage and identity.stage != linked_identity.stage)
                    dimensions.update(
                        run_id=str(run_id),
                        sample_id=f"run-job:{links[0].run_job_id}",
                        market=linked_identity.market or identity.market,
                        stage=None if stage_conflicted else linked_identity.stage or identity.stage,
                    )
                else:
                    run_id = None
                    stage_conflicted = True
                    dimensions.update(market=None, stage=None)
            targets = [AutoRebalanceWorkflowStage.job_id == job_id]
            if run_id is not None:
                targets.append(AutoRebalanceWorkflowStage.run_id == run_id)
            workflows = db.execute(
                select(AutoRebalanceWorkflow.id, AutoRebalanceWorkflowStage.stage)
                .join(AutoRebalanceWorkflowStage, AutoRebalanceWorkflowStage.workflow_id == AutoRebalanceWorkflow.id)
                .where(AutoRebalanceWorkflow.user_id == user_id, or_(*targets))
            ).all()
            if len(workflows) == 1:
                dimensions["workflow_id"] = str(workflows[0].id)
                stage = workflows[0].stage
                if not stage_conflicted and stage in {"threats", "swing", "rebalance", "technical"}:
                    if dimensions["stage"] is None:
                        dimensions["stage"] = stage
                    elif dimensions["stage"] != stage:
                        dimensions["stage"] = None
    except Exception as exc:
        # Do not log SQL, connection data, prompt text, or error message bodies.
        logger.warning("Usage identity lookup unavailable (%s)", type(exc).__name__)
    return dimensions
