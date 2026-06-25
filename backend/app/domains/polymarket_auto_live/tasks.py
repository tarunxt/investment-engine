from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from uuid import uuid4

from celery.exceptions import MaxRetriesExceededError
from sqlalchemy import and_, select

from app.core.logging import get_logger
from app.domains.polymarket_auto_live.bot import (
    BullpenAutoLiveBot,
    build_initial_run_summary,
    build_initial_scan_stage_result,
    effective_dry_run,
    live_execution_requested,
)
from app.domains.polymarket_auto_live.engine import BullpenAutoLiveEngine, PositionSnapshot
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveRunRecord,
    PolymarketAutoLiveSettingsRecord,
    PolymarketAutoLiveStateRecord,
)
from app.domains.polymarket_auto_live.repository import (
    SyncPolymarketAutoLiveRepository,
    record_to_settings,
    record_to_state,
)
from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveRun
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery
from app.infrastructure.messaging.task_registry import (
    register_auto_live_run_task_sync,
)
import app.infrastructure.database.all_models  # noqa: F401

logger = get_logger("app.domains.polymarket_auto_live.tasks")


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _position_snapshot_from_record(record) -> PositionSnapshot:
    payload = record.payload or {}
    return PositionSnapshot(
        market_id=record.market_id,
        slug=record.slug,
        market_title=record.market_title,
        market_url=record.market_url,
        theme=record.theme,
        side=record.side,
        exposure_usd=float(record.exposure_usd),
        shares=float(record.shares),
        average_price_cents=float(record.average_price_cents),
        opened_at=record.opened_at.astimezone(UTC),
        updated_at=record.updated_at.astimezone(UTC),
        close_time=payload.get("close_time") if isinstance(payload.get("close_time"), str) else None,
        current_price_cents=(
            float(payload["current_price_cents"])
            if isinstance(payload.get("current_price_cents"), (int, float))
            else None
        ),
        condition_id=payload.get("condition_id") if isinstance(payload.get("condition_id"), str) else None,
    )


def _synchronize_state(
    user_id: int,
    repo: SyncPolymarketAutoLiveRepository,
) -> tuple:
    settings_record = repo.get_settings_record(user_id)
    state_record = repo.get_state_record(user_id)
    settings = record_to_settings(settings_record)
    state = record_to_state(state_record)
    normalized = BullpenAutoLiveBot(user_id=user_id)._synchronize_state(settings, state)
    repo.save_settings(user_id, settings)
    repo.save_state(user_id, normalized)
    return settings, normalized


@celery.task(
    bind=True,
    max_retries=2,
    default_retry_delay=30,
    name="app.domains.polymarket_auto_live.tasks.execute_polymarket_auto_live_run",
    queue="ai",
)
def execute_polymarket_auto_live_run(self, user_id: int, run_id: str) -> None:
    with SyncSessionLocal() as session:
        repo = SyncPolymarketAutoLiveRepository(session)
        if self.request.id:
            register_auto_live_run_task_sync(run_id, self.request.id)
        run = repo.get_run(run_id)
        if run is None:
            logger.warning("Auto-Live run %s for user %s was not found", run_id, user_id)
            return
        if run.status != "running":
            logger.info("Skipping inactive Auto-Live run %s with status %s", run_id, run.status)
            return

        settings, state = _synchronize_state(user_id, repo)
        position_records = repo.list_open_position_records(user_id)
        positions = [_position_snapshot_from_record(record) for record in position_records]
        historical_decisions = repo.list_decisions(user_id)

        try:
            def persist_progress(current_run: BullpenAutoLiveRun, current_state) -> None:
                repo.save_run(user_id, current_run)
                repo.save_state(user_id, current_state)
                session.commit()

            engine_result = asyncio.run(
                BullpenAutoLiveEngine().execute(
                    user_id=user_id,
                    settings=settings,
                    state=state,
                    run=run,
                    positions=positions,
                    historical_decisions=historical_decisions,
                    progress_callback=persist_progress,
                )
            )
        except Exception as exc:
            logger.exception("Auto-Live run %s failed before completion", run_id)
            run.status = "failed"
            run.completed_at = datetime.now(UTC).isoformat()
            run.error_message = str(exc)
            run.summary = f"Auto-Live run failed: {exc}"
            state.last_error = run.summary
            state.last_action = run.summary
            repo.save_run(user_id, run)
            repo.save_state(user_id, state)
            session.commit()
            try:
                raise self.retry(exc=exc)
            except MaxRetriesExceededError:
                logger.exception("Auto-Live run %s exhausted retries", run_id)
            return

        repo.save_run(user_id, engine_result.run)
        repo.replace_run_decisions(user_id, run_id, engine_result.decisions)
        repo.replace_positions(user_id, engine_result.positions)
        repo.save_state(user_id, engine_result.state)
        session.commit()


@celery.task(
    name="app.domains.polymarket_auto_live.tasks.enqueue_due_polymarket_auto_live_runs",
    queue="beat",
)
def enqueue_due_polymarket_auto_live_runs() -> None:
    now = _utc_now()
    with SyncSessionLocal() as session:
        repo = SyncPolymarketAutoLiveRepository(session)
        due_states = session.execute(
            select(PolymarketAutoLiveStateRecord).where(
                and_(
                    PolymarketAutoLiveStateRecord.running.is_(True),
                    PolymarketAutoLiveStateRecord.paused.is_(False),
                    PolymarketAutoLiveStateRecord.next_run_at.is_not(None),
                    PolymarketAutoLiveStateRecord.next_run_at <= now,
                )
            )
        ).scalars().all()

        for state_record in due_states:
            user_id = state_record.user_id
            settings_record = repo.get_settings_record(user_id)
            settings = record_to_settings(settings_record)
            if settings.emergency_stop or not settings.auto_live_enabled:
                continue
            active_run = session.execute(
                select(PolymarketAutoLiveRunRecord).where(
                    and_(
                        PolymarketAutoLiveRunRecord.user_id == user_id,
                        PolymarketAutoLiveRunRecord.status == "running",
                    )
                )
            ).scalar_one_or_none()
            if active_run is not None:
                continue

            state = record_to_state(state_record)
            state.last_action = "Queued scheduled Auto-Live run."
            BullpenAutoLiveBot(user_id=user_id)._schedule_next_cycles(
                settings,
                state,
                reference_time=now,
            )
            run = BullpenAutoLiveRun(
                id=str(uuid4()),
                triggered_by="scheduler",
                status="running",
                dry_run=effective_dry_run(settings),
                started_at=now.isoformat(),
                summary=build_initial_run_summary(),
                live_execution_requested=live_execution_requested(settings),
                guardrail_checks=state.latest_guardrail_checks,
                stage_results=[
                    build_initial_scan_stage_result(
                        started_at=now.isoformat(),
                    )
                ],
            )
            repo.save_run(user_id, run)
            repo.save_state(user_id, state)
            session.commit()
            task = execute_polymarket_auto_live_run.delay(user_id, run.id)  # type: ignore[attr-defined]
            register_auto_live_run_task_sync(run.id, task.id)
