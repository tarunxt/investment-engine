"""Rebuild an unpublished Stage 2 revision from the workflow's own saved inputs."""
from datetime import datetime
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import select

from app.domains.jobs.models import Job
from app.domains.runs.models import Run, RunJob
from app.domains.runs.run_identity import analysis_run_identity
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot as Snapshot
from . import storage
from .universe import digest, publish_manifest


async def prepare_swing_source(db, owner, workflow):
    # The caller holds the same parent lock as the normal publication endpoint.
    key = f"workflow-{workflow.sequence}"
    revision = await storage.by_key(db, "revision", key, workflow_id=workflow.id)
    if revision:
        return revision

    if workflow.status not in ("interrupted", "failed"):
        raise HTTPException(409, "This workflow must be stopped before preparing its saved Swing results.")
    stages = {s.stage: s for s in (await db.scalars(select(storage.Stage).where(
        storage.Stage.workflow_id == workflow.id,
        storage.Stage.stage.in_(("sync", "swing", "rebalance", "technical", "threats", "pairwise", "actionables")),
    ))).all()}
    sync, swing = stages.get("sync"), stages.get("swing")
    if not sync or sync.status != "completed" or not swing:
        raise HTTPException(409, "Recovery requires the completed portfolio sync and saved Swing scan from this workflow.")
    if any(
        s.run_id or s.job_id or s.status in ("completed", "partial")
        for name, s in stages.items() if name not in ("sync", "swing")
    ):
        raise HTTPException(409, "This workflow already has downstream execution. Review its saved scorecards.")
    runs = (await db.scalars(select(Run).where(
        Run.user_id == owner, Run.auto_rebalance_portfolio == "india",
        Run.auto_rebalance_sequence == workflow.sequence,
    ))).all()
    candidates = [r for r in runs if analysis_run_identity(r).stage == "swing" and (not swing.run_id or r.id == swing.run_id)]
    if len(candidates) != 1 or len(runs) != 1:
        raise HTTPException(409, "Cannot identify a single saved Swing run before scorecard execution.")
    run = candidates[0]
    if run.status not in ("completed", "partial"):
        raise HTTPException(409, "Wait for the Swing workers to finish before preparing inputs.")
    jobs = list((await db.scalars(select(Job.id).join(RunJob, RunJob.job_id == Job.id).where(
        RunJob.run_id == run.id, RunJob.stage == 1, Job.user_id == owner,
        Job.status.in_(("completed", "partial")), Job.response.is_not(None),
    ).order_by(Job.id))).all())
    if not jobs:
        raise HTTPException(409, "The saved Swing run has no usable model responses.")
    receipt = (sync.summary_json or {}).get("final_inputs") or {}
    query = select(Snapshot).where(Snapshot.user_id == owner)
    if receipt.get("snapshot_at"):
        try:
            captured_at = datetime.fromisoformat(receipt["snapshot_at"].replace("Z", "+00:00"))
        except (AttributeError, ValueError) as exc:
            raise HTTPException(409, "Invalid saved sync timestamp.") from exc
        query = query.where(Snapshot.captured_at == captured_at)
    if receipt.get("snapshot_id"):
        query = query.where(Snapshot.id == receipt["snapshot_id"])
    else:
        # Older workflows recorded only the sync interval. Reject ambiguous matches.
        query = query.where(Snapshot.captured_at >= workflow.created_at, Snapshot.captured_at <= run.created_at)
    snapshots = (await db.scalars(query.limit(2))).all()
    if len(snapshots) != 1:
        raise HTTPException(409, "Cannot uniquely identify the holdings snapshot captured for this Swing run.")
    snapshot = snapshots[0]
    inputs = SimpleNamespace(snapshot_id=snapshot.id, captured_at=snapshot.captured_at, swing_job_ids=jobs, verified_listings=[])
    manifest = await publish_manifest(db, owner, workflow, inputs)
    return await storage.append(db, workflow.id, "revision", key, {"digest": digest(manifest), "manifest": manifest})
