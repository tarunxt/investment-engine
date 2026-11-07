"""Durable actor/request identity. Redis never authorizes a replay."""
from __future__ import annotations

from datetime import timezone
import hashlib
import json

from sqlalchemy import ForeignKey, String, UniqueConstraint, select
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database.base import Base, TimestampMixin
from app.shared.exceptions import ConflictException, NotFoundException

from app.domains.jobs.creation_identity import OPERATION, payload_fingerprint


class JobAdmission(Base, TimestampMixin):
    __tablename__ = "job_admissions"
    __table_args__ = (UniqueConstraint("user_id", "operation", "request_key_hash",
                                      name="uq_job_admission_actor_key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    operation: Mapped[str] = mapped_column(String(64), nullable=False)
    request_key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"), nullable=False, unique=True)


def utc_schedule(value):
    if value is None:
        return None
    return (value.replace(tzinfo=timezone.utc) if value.tzinfo is None
            else value.astimezone(timezone.utc))


def request_identity(cmd):
    """Preserve prompt/model/source semantics; normalize only equivalent UTC ETA."""
    fingerprint = payload_fingerprint(cmd)
    key_hash = hashlib.sha256(cmd.idempotency_key.encode()).hexdigest()
    cache_key = f"{cmd.user_id}:{OPERATION}:{key_hash}:{fingerprint}"
    return key_hash, fingerprint, cache_key


async def replay_admission(session, repo, cmd, key_hash, fingerprint):
    admission = (await session.execute(select(JobAdmission).where(
        JobAdmission.user_id == cmd.user_id, JobAdmission.operation == OPERATION,
        JobAdmission.request_key_hash == key_hash,
    ))).scalar_one_or_none()
    if admission is None:
        return None
    if admission.fingerprint != fingerprint:
        raise ConflictException("Idempotency key was already used with a different request.")
    job = await repo.get_for_user(admission.job_id, cmd.user_id)
    if job is None:
        raise NotFoundException("Job not found")
    return job
