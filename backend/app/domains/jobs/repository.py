from __future__ import annotations

from typing import Protocol

from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.domains.jobs.models import Job
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.pagination import PagedQuery, PagedResult
from app.shared.exceptions import ForbiddenException
from app.shared.types import JobId, JobStatus, UserId
from datetime import datetime


class JobRepository(Protocol):
    async def create(self, job: Job) -> Job: ...
    async def get(self, job_id: JobId) -> Job | None: ...
    async def get_for_user(self, job_id: JobId, user_id: UserId) -> Job | None: ...
    async def cancel_for_user(self, job_id: JobId, user_id: UserId) -> tuple[Job | None, bool]: ...
    async def list_for_user(self, user_id: UserId, query: PagedQuery,
                            status: JobStatus | None = None,
                            search: str | None = None) -> PagedResult[Job]: ...
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
        web_search_used: bool | None = None,
        web_search_queries: list[str] | None = None,
        web_sources: list[str] | None = None,
        runtime_metadata_json: dict | None = None,
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

    async def get_for_user(self, job_id: JobId, user_id: UserId) -> Job | None:
        """User-facing access; unscoped get is reserved for internal execution."""
        if user_id is None:
            return None
        result = await self._session.execute(
            select(Job, OutboxMessage.state).outerjoin(
                OutboxMessage, OutboxMessage.job_id == Job.id,
            ).where(Job.id == job_id, Job.user_id == user_id)
        )
        row = result.one_or_none()
        if row is None:
            return None
        job, state = row
        job.dispatch_status = state  # Additive projection; legacy rows stay unknown.
        return job

    async def cancel_for_user(self, job_id: JobId, user_id: UserId) -> tuple[Job | None, bool]:
        """Serialize cancellation against completion; caller commits the transition.

        Refresh under the row lock so a stale API identity cannot replace a
        previously committed terminal output. Worker terminal writes use the same
        row lock (and, after A11-002 integration, execution ownership).
        """
        if user_id is None:
            return None, False
        with self._session.no_autoflush:
            result = await self._session.execute(
                select(Job).where(Job.id == job_id, Job.user_id == user_id)
                .with_for_update().execution_options(populate_existing=True)
            )
        job = result.scalar_one_or_none()
        if job is None or job.status not in JobStatus.active():
            return job, False
        job.status = JobStatus.FAILED
        job.error_message = "Cancelled by user"
        if (job.export_status or "").lower() in {"", "pending", "queued", "processing"}:
            job.export_status = "failed"
            job.export_error = "Cancelled by user"
        await self._session.flush()
        return job, True

    async def list_for_user(
        self, user_id: UserId, query: PagedQuery,
        status: JobStatus | None = None, search: str | None = None,
    ) -> PagedResult[Job]:
        if user_id is None:
            raise ForbiddenException()
        return await self._list(query, status, search, user_id=user_id)

    async def list(
        self, query: PagedQuery, status: JobStatus | None = None,
        search: str | None = None,
    ) -> PagedResult[Job]:
        """Internal access only. HTTP callers must use list_for_user."""
        return await self._list(query, status, search)

    async def _list(
        self, query: PagedQuery, status: JobStatus | None = None,
        search: str | None = None, *, user_id: UserId | None = None,
    ) -> PagedResult[Job]:
        stmt = select(Job)
        if user_id is not None:
            stmt = stmt.where(Job.user_id == user_id)
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
        web_search_used: bool | None = None,
        web_search_queries: list[str] | None = None,
        web_sources: list[str] | None = None,
        runtime_metadata_json: dict | None = None,
    ) -> None:
        result = await self._session.execute(
            select(Job).where(Job.id == job_id).with_for_update()
            .execution_options(populate_existing=True)
        )
        job = result.scalar_one_or_none()
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
        if web_search_used is not None:
            job.web_search_used = web_search_used
        if web_search_queries is not None:
            job.web_search_queries = web_search_queries
        if web_sources is not None:
            job.web_sources = web_sources
        if runtime_metadata_json is not None:
            from app.domains.jobs.execution_claim import KEY
            existing_claim = (job.runtime_metadata_json or {}).get(KEY)
            job.runtime_metadata_json = {**(job.runtime_metadata_json or {}), **runtime_metadata_json}
            if existing_claim is not None:
                job.runtime_metadata_json = {**job.runtime_metadata_json, KEY: existing_claim}
        await self._session.flush()


# ── Sync repository (for Celery workers) ────────────────────────────────────

class SyncJobRepository:
    """Thin sync wrapper used by Celery workers (no event loop required)."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, job_id: int) -> Job | None:
        return self._session.get(Job, job_id)

    def get_fresh(self, job_id: int) -> Job | None:
        """Re-read cancellation state changed by an API session during generation."""
        return self._session.get(Job, job_id, populate_existing=True)

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
        web_search_used: bool | None = None,
        web_search_queries: list[str] | None = None,
        web_sources: list[str] | None = None,
        runtime_metadata_json: dict | None = None,
    ) -> None:
        from app.domains.jobs.execution_claim import KEY, require_owner, LostExecutionOwner, locked_job
        token = getattr(self, "execution_token", None)
        claim = None
        if token:
            if getattr(self, "execution_owner_lost", lambda: False)():
                raise LostExecutionOwner("Renewal failed")
            job, claim = require_owner(self._session, job.id, token)
        else:
            job = locked_job(self._session, job.id)
            if job is None or job.status in JobStatus.terminal():
                # The committed terminal transition wins for unclaimed writers.
                self._session.commit()
                return
            if (job.runtime_metadata_json or {}).get(KEY):
                self._session.rollback()
                raise LostExecutionOwner("Claimed job requires its execution token")
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
        if web_search_used is not None:
            job.web_search_used = web_search_used
        if web_search_queries is not None:
            job.web_search_queries = web_search_queries
        if web_sources is not None:
            job.web_sources = web_sources
        if runtime_metadata_json is not None:
            job.runtime_metadata_json = {**(job.runtime_metadata_json or {}), **runtime_metadata_json}
        if claim is not None:
            if status in {JobStatus.COMPLETED, JobStatus.PARTIAL, JobStatus.FAILED}:
                claim = {**claim, "state": "finished"}
            job.runtime_metadata_json = {**(job.runtime_metadata_json or {}), KEY: claim}
        from app.core.config import settings
        if settings.recommendation_audit_enabled:
            from app.domains.recommendation_audit.capture import capture_terminal
            try:
                # Advisory capture must not turn a successful provider response into
                # a failed/retried generation. Keep the existing job write outside
                # the audit savepoint and expose the capture gap explicitly.
                with self._session.begin_nested():
                    capture_terminal(self._session, job)
            except Exception as exc:
                import logging
                logging.getLogger(__name__).exception("Recommendation capture failed for job %s", job.id)
                job.runtime_metadata_json = {
                    **(job.runtime_metadata_json or {}),
                    "recommendation_audit": {"status": "capture_failed", "error_type": type(exc).__name__},
                }
        self._session.commit()

    def update_export_state(
        self,
        job: Job,
        *,
        export_status: str,
        export_error: str | None = None,
        exported_at: datetime | None = None,
        exported_sheet_url: str | None = None,
    ) -> None:
        job.export_status = export_status
        job.export_error = export_error
        job.exported_at = exported_at
        job.exported_sheet_url = exported_sheet_url
        self._session.commit()
