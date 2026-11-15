"""Derive a current stage's outcome without changing persisted child outcomes."""
from collections.abc import Iterable

from app.shared.types import JobStatus


def aggregate_stage_status(statuses: Iterable[JobStatus]) -> JobStatus:
    outcomes = set(statuses)
    if outcomes & {JobStatus.PENDING, JobStatus.PROCESSING, JobStatus.SCHEDULED}:
        return JobStatus.PROCESSING
    if JobStatus.PARTIAL in outcomes:
        return JobStatus.PARTIAL
    if outcomes == {JobStatus.COMPLETED}:
        return JobStatus.COMPLETED
    if JobStatus.COMPLETED in outcomes:
        return JobStatus.PARTIAL
    return JobStatus.FAILED
