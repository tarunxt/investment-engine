from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, load_only, selectinload

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

    async def list(self, query: PagedQuery, *, summary: bool = False) -> PagedResult[Run]:
        stmt = select(Run)
        count_stmt = select(func.count()).select_from(stmt.subquery())
        total: int = (await self._session.execute(count_stmt)).scalar_one()
        if summary:
            stmt = stmt.options(
                load_only(
                    Run.id,
                    Run.prompt,
                    Run.prompt_id,
                    Run.status,
                    Run.current_stage,
                    Run.auto_export_enabled,
                    Run.export_status,
                    Run.export_error,
                    Run.exported_at,
                    Run.exported_sheet_url,
                    Run.auto_rebalance_portfolio,
                    Run.auto_rebalance_sequence,
                    Run.auto_rebalance_label,
                    Run.created_at,
                    Run.updated_at,
                ),
                selectinload(Run.run_jobs)
                .load_only(RunJob.id, RunJob.run_id, RunJob.job_id, RunJob.stage)
                .selectinload(RunJob.job)
                .load_only(
                    Job.id,
                    Job.provider,
                    Job.model,
                    Job.status,
                    Job.error_message,
                    Job.tokens_in,
                    Job.tokens_out,
                    Job.estimated_cost,
                    Job.request_context_json,
                    Job.export_status,
                    Job.export_error,
                    Job.exported_at,
                    Job.exported_sheet_url,
                    Job.auto_rebalance_portfolio,
                    Job.auto_rebalance_sequence,
                    Job.auto_rebalance_label,
                    Job.scheduled_at,
                    Job.created_at,
                    Job.updated_at,
                ),
            )
        else:
            stmt = stmt.options(selectinload(Run.run_jobs).selectinload(RunJob.job))

        items_result = await self._session.execute(
            stmt.order_by(Run.id.desc()).offset(query.offset).limit(query.limit)
        )
        return PagedResult(
            items=list(items_result.scalars()),
            total=total,
            page=query.page,
            limit=query.limit,
        )

    async def get_latest_active_for_user(self, user_id: int) -> Run | None:
        result = await self._session.execute(
            select(Run)
            .where(
                Run.user_id == user_id,
                Run.status.in_([JobStatus.SCHEDULED, JobStatus.PENDING, JobStatus.PROCESSING]),
            )
            .order_by(Run.id.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()


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

    def update_export_state(
        self,
        run: Run,
        *,
        export_status: str,
        export_error: str | None = None,
        exported_at: datetime | None = None,
        exported_sheet_url: str | None = None,
    ) -> None:
        run.export_status = export_status
        run.export_error = export_error
        run.exported_at = exported_at
        run.exported_sheet_url = exported_sheet_url
        self._session.commit()
