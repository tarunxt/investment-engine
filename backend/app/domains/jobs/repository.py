from __future__ import annotations

from typing import Protocol

from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.domains.jobs.models import Job
from app.shared.pagination import PagedQuery, PagedResult
from app.shared.types import JobId, JobStatus


class JobRepository(Protocol):
    async def create(self, job: Job) -> Job: ...
    async def get(self, job_id: JobId) -> Job | None: ...
    async def list(
        self,
        query: PagedQuery,
        status: JobStatus | None = None,
        search: str | None = None,
    ) -> PagedResult[Job]: ...
    async def update_status(
        self,
        job_id: JobId,
        status: JobStatus,
        *,
        response: str | None = None,
        error_message: str | None = None,
        tokens_in: int | None = None,
        tokens_out: int | None = None,
        estimated_cost: float | None = None,
    ) -> None: ...


class PostgresJobRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def create(self, job: Job) -> Job:
        self._session.add(job)
        await self._session.flush()   # populate job.id without committing
        await self._session.refresh(job)
        return job

    async def get(self, job_id: JobId) -> Job | None:
        result = await self._session.execute(
            select(Job).where(Job.id == job_id)
        )
        return result.scalar_one_or_none()

    async def list(
        self,
        query: PagedQuery,
        status: JobStatus | None = None,
        search: str | None = None,
    ) -> PagedResult[Job]:
        stmt = select(Job)
        if status:
            stmt = stmt.where(Job.status == status)
        if search:
            stmt = stmt.where(
                or_(
                    Job.prompt.ilike(f"%{search}%"),
                    cast(Job.id, String).like(f"%{search}%"),
                )
            )
        count_stmt = select(func.count()).select_from(stmt.subquery())
        total: int = (await self._session.execute(count_stmt)).scalar_one()

        items_result = await self._session.execute(
            stmt.order_by(Job.id.desc())
            .offset(query.offset)
            .limit(query.limit)
        )
        return PagedResult(
            items=list(items_result.scalars()),
            total=total,
            page=query.page,
            limit=query.limit,
        )

    async def update_status(
        self,
        job_id: JobId,
        status: JobStatus,
        *,
        response: str | None = None,
        error_message: str | None = None,
        tokens_in: int | None = None,
        tokens_out: int | None = None,
        estimated_cost: float | None = None,
    ) -> None:
        job = await self.get(job_id)
        if not job:
            return
        job.status = status
        if response is not None:
            job.response = response
        if error_message is not None:
            job.error_message = error_message
        if tokens_in is not None:
            job.tokens_in = tokens_in
        if tokens_out is not None:
            job.tokens_out = tokens_out
        if estimated_cost is not None:
            job.estimated_cost = estimated_cost
        await self._session.flush()


# ── Sync repository (for Celery workers) ────────────────────────────────────

class SyncJobRepository:
    """Thin sync wrapper used by Celery workers (no event loop required)."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, job_id: int) -> Job | None:
        return self._session.get(Job, job_id)

    def update_status(
        self,
        job: Job,
        status: JobStatus,
        *,
        response: str | None = None,
        error_message: str | None = None,
        tokens_in: int | None = None,
        tokens_out: int | None = None,
        estimated_cost: float | None = None,
    ) -> None:
        job.status = status
        if response is not None:
            job.response = response
        if error_message is not None:
            job.error_message = error_message
        if tokens_in is not None:
            job.tokens_in = tokens_in
        if tokens_out is not None:
            job.tokens_out = tokens_out
        if estimated_cost is not None:
            job.estimated_cost = estimated_cost
        self._session.commit()
