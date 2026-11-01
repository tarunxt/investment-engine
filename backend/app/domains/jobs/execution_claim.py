"""Durable ordinary-job ownership. No broker state authorizes provider replay.

The reserved metadata key must survive diagnostic writes. All transitions lock the
job row; provider-started claims are never automatically replaced after expiry.
"""
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import select

from app.domains.jobs.models import Job
from app.shared.types import JobStatus

KEY = "execution_claim"
LEASE_SECONDS = 120
MAX_OWNER_SECONDS = 7200
TERMINAL = {JobStatus.COMPLETED, JobStatus.PARTIAL, JobStatus.FAILED}


class LostExecutionOwner(RuntimeError):
    pass


def timestamp():
    return datetime.now(timezone.utc).timestamp()


def locked_job(session, job_id):
    return session.execute(
        select(Job).where(Job.id == job_id).with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()


def save_claim(job, claim):
    job.runtime_metadata_json = {**(job.runtime_metadata_json or {}), KEY: claim}


def admit(session, job_id, delivery_id, *, now=None):
    now = timestamp() if now is None else now
    job = locked_job(session, job_id)
    if job is None or job.status in TERMINAL:
        session.rollback()
        return None
    old = (job.runtime_metadata_json or {}).get(KEY) or {}
    if old:
        if old.get("expires_at", 0) > now:
            session.rollback()
            return None
        if old.get("provider_started") or old.get("state") == "reconciliation_needed":
            save_claim(job, {**old, "state": "reconciliation_needed"})
            session.commit()
            return None
    token = str(uuid4())
    claim = {"owner_token": token, "attempt_id": str(uuid4()),
             "delivery_id": delivery_id, "started_at": now,
             "expires_at": now + LEASE_SECONDS, "provider_started": False,
             "state": "owned", "previous_attempts": [
                 *(old.get("previous_attempts", [])),
                 *([{k: v for k, v in old.items() if k != "previous_attempts"}] if old else []),
             ]}
    save_claim(job, claim)
    session.commit()
    return token


def require_owner(session, job_id, token, *, now=None):
    now = timestamp() if now is None else now
    job = locked_job(session, job_id)
    claim = (job.runtime_metadata_json or {}).get(KEY, {}) if job else {}
    if (not job or job.status in TERMINAL or claim.get("owner_token") != token
            or claim.get("state") != "owned" or claim.get("expires_at", 0) <= now
            or now >= claim.get("started_at", 0) + MAX_OWNER_SECONDS):
        session.rollback()
        raise LostExecutionOwner("Job ownership lost or canceled; reconciliation required")
    return job, claim


def checkpoint(session, job_id, token, *, provider_started=False, now=None):
    now = timestamp() if now is None else now
    job, claim = require_owner(session, job_id, token, now=now)
    save_claim(job, {**claim, "expires_at": min(now + LEASE_SECONDS,
                claim["started_at"] + MAX_OWNER_SECONDS),
                "provider_started": claim["provider_started"] or provider_started})
    session.commit()


def reconcile(session, job_id, token, *, evidence=None):
    """Best effort diagnostic only: never replaces an owner or terminal result."""
    session.rollback()
    job = locked_job(session, job_id)
    claim = (job.runtime_metadata_json or {}).get(KEY, {}) if job else {}
    if job and job.status not in TERMINAL and claim.get("owner_token") == token:
        # Retain returned normalized output/usage for reconciliation without
        # publishing a terminal result or replacing any historical output.
        for field in ("response", "tokens_in", "tokens_out", "estimated_cost"):
            value = (evidence or {}).get(field)
            if value is not None and getattr(job, field, None) is None:
                setattr(job, field, value)
        metadata = (evidence or {}).get("runtime_metadata_json")
        if metadata:
            job.runtime_metadata_json = {**(job.runtime_metadata_json or {}), **metadata}
        save_claim(job, {**claim, "state": "reconciliation_needed"})
        session.commit()
    else:
        session.rollback()
