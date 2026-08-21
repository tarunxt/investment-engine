from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from uuid import UUID, uuid4

from app.shared.types import JobId, UserId


@dataclass(frozen=True)
class DomainEvent:
    event_id: UUID = field(default_factory=uuid4)
    occurred_at: datetime = field(default_factory=datetime.utcnow)


@dataclass(frozen=True)
class JobCreated(DomainEvent):
    job_id: JobId = field(default=JobId(0))
    user_id: UserId | None = None
    provider: str = ""
    model: str = ""
    scheduled_at: datetime | None = None


@dataclass(frozen=True)
class JobCompleted(DomainEvent):
    job_id: JobId = field(default=JobId(0))
    provider: str = ""
    tokens_in: int = 0
    tokens_out: int = 0
    cost: float = 0.0


@dataclass(frozen=True)
class JobFailed(DomainEvent):
    job_id: JobId = field(default=JobId(0))
    provider: str = ""
    reason: str = ""
