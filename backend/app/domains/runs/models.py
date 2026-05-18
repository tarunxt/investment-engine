from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.database.base import Base, TimestampMixin
from app.domains.jobs.models import JobStatusType
from app.shared.types import JobStatus

if TYPE_CHECKING:
    from app.domains.auth.models import User
    from app.domains.jobs.models import Job
    from app.domains.prompts.models import Prompt


class Run(Base, TimestampMixin):
    __tablename__ = "runs"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    prompt_id: Mapped[int | None] = mapped_column(
        ForeignKey("prompts.id", ondelete="SET NULL"), nullable=True
    )
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[JobStatus] = mapped_column(
        JobStatusType, default=JobStatus.PENDING, nullable=False, index=True
    )
    current_stage: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    synthesis_response: Mapped[str | None] = mapped_column(Text, nullable=True)
    decision_response: Mapped[str | None] = mapped_column(Text, nullable=True)

    run_jobs: Mapped[list[RunJob]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )
    user: Mapped[User | None] = relationship()


class RunJob(Base, TimestampMixin):
    __tablename__ = "run_jobs"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    run_id: Mapped[int] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    job_id: Mapped[int] = mapped_column(
        ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    stage: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    run: Mapped[Run] = relationship(back_populates="run_jobs")
    job: Mapped[Job] = relationship()
