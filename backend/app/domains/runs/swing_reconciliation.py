"""Repair stale Swing status from fenced, already-returned provider evidence."""
from math import isfinite
from time import time

from sqlalchemy import select

from app.domains.jobs.execution_claim import KEY, TERMINAL
from app.domains.jobs.models import Job
from app.domains.jobs.output_runtime import configure_output_context, output_validation_metadata, reset_output_context
from app.domains.jobs.stage_status import aggregate_stage_status
from app.domains.runs.models import Run, RunJob
from app.domains.runs.run_identity import analysis_run_identity
from app.shared.types import JobStatus


def returned_after_owner_expiry(job, now):
    claim = (job.runtime_metadata_json or {}).get(KEY) or {}
    expiry = claim.get("expires_at")
    return (
        job.status == JobStatus.PROCESSING
        and bool(job.response)
        and claim.get("state") in {"owned", "reconciliation_needed"}
        and claim.get("provider_started") is True
        and (claim.get("pending_calls") == 0 or claim.get("state") == "reconciliation_needed")
        and isinstance(expiry, (int, float))
        and isfinite(expiry) and expiry <= now
        and not job.scheduled_at
    )


async def reconcile_swing(db, run):
    if (run.status != JobStatus.PROCESSING or not run.auto_rebalance_sequence
            or analysis_run_identity(run).stage != "swing"):
        return
    stage = run.current_stage
    jobs = [link.job for link in run.run_jobs if link.stage == stage]
    if not jobs or not all(j.status in TERMINAL or returned_after_owner_expiry(j, time()) for j in jobs):
        return

    # Serialize competing pollers. Refresh the identity map after acquiring locks
    # so cancellation, renewal or a newer stage always wins over a stale read.
    locked = (await db.execute(select(Run.status, Run.current_stage).where(Run.id == run.id)
              .with_for_update())).one()
    if locked.status != JobStatus.PROCESSING or locked.current_stage != stage:
        return
    jobs = (await db.execute(select(Job).join(RunJob, RunJob.job_id == Job.id)
            .where(RunJob.run_id == run.id, RunJob.stage == stage)
            .order_by(Job.id).with_for_update(of=Job)
            .execution_options(populate_existing=True))).scalars().all()
    if not jobs or not all(j.status in TERMINAL or returned_after_owner_expiry(j, time()) for j in jobs):
        return
    for job in jobs:
        if job.status in TERMINAL:
            continue
        claim = job.runtime_metadata_json[KEY]
        if claim.get("pending_calls") != 0:
            # reconcile() has fenced this attempt: require_owner rejects further
            # writes and admit refuses a replay. Preserve its uncertain billing
            # and raw response, but never publish the response as usable.
            job.status = JobStatus.FAILED
            job.error_message = "Worker ownership expired with an unconfirmed provider call. Saved response excluded; no replay."
            job.runtime_metadata_json = {**job.runtime_metadata_json, "swing_reconciliation": job.error_message}
            continue
        token = configure_output_context(job, {"run_id": str(run.id)})
        try:
            validation = output_validation_metadata(job.response)
        finally:
            reset_output_context(token)
        if validation and validation.get("safe_to_render"):
            job.status = JobStatus.PARTIAL
            job.error_message = "Recovered validated Swing output after worker ownership expired."
        else:
            job.status = JobStatus.FAILED
            job.error_message = "Saved Swing response failed contract validation after worker ownership expired."
        job.runtime_metadata_json = {**job.runtime_metadata_json, "swing_reconciliation": job.error_message,
                                     "deterministic_output": validation}
    run.status = aggregate_stage_status(j.status for j in jobs)
    await db.commit()
