from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, selectinload

from app.domains.jobs.models import Job
from app.domains.runs.models import Run, RunJob
from app.shared.pagination import PagedQuery, PagedResult
from app.shared.types import JobStatus


class PostgresRunRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def create(self, run: Run) -> Run:
        self._session.add(run)
        await self._session.flush()
        await self._session.refresh(run)
        return run

    async def get(self, run_id: int) -> Run | None:
        result = await self._session.execute(
            select(Run)
            .where(Run.id == run_id)
            .options(selectinload(Run.run_jobs).selectinload(RunJob.job))
        )
        return result.scalar_one_or_none()

    async def list(self, query: PagedQuery) -> PagedResult[Run]:
        stmt = select(Run)
        count_stmt = select(func.count()).select_from(stmt.subquery())
        total: int = (await self._session.execute(count_stmt)).scalar_one()
        items_result = await self._session.execute(
            stmt.order_by(Run.id.desc()).offset(query.offset).limit(query.limit)
        )
        return PagedResult(
            items=list(items_result.scalars()),
            total=total,
            page=query.page,
            limit=query.limit,
        )


class SyncRunRepository:
    """For Celery workers — sync session only."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, run_id: int) -> Run | None:
        # Use execute() so we always hit the DB — session.get() can return expired
        # objects from the identity map that only reload lazily on attribute access.
        result = self._session.execute(select(Run).where(Run.id == run_id))
        return result.scalar_one_or_none()

    def get_stage_run_jobs(self, run_id: int, stage: int) -> list[tuple[RunJob, Job]]:
        # JOIN fetches both rows in one round-trip and bypasses the identity map,
        # guaranteeing that job.status reflects what is actually in the DB right now.
        rows = self._session.execute(
            select(RunJob, Job)
            .join(Job, RunJob.job_id == Job.id)
            .where(RunJob.run_id == run_id, RunJob.stage == stage)
        ).all()
        return [(rj, job) for rj, job in rows]

    def update_status(self, run: Run, status: JobStatus) -> None:
        run.status = status
        self._session.commit()
