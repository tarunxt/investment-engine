from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from uuid import uuid4

from celery.exceptions import SoftTimeLimitExceeded
from sqlalchemy import and_, select

from app.core.logging import get_logger
from app.domains.bullpen_trade_analysis.service import (
    sync_auto_live_position_snapshots_sync,
)
from app.domains.polymarket.logger import redact_secrets
from app.domains.polymarket_auto_live.bot import (
    BullpenAutoLiveBot,
    build_initial_run_summary,
    build_initial_scan_stage_result,
    effective_dry_run,
    live_execution_requested,
)
from app.domains.polymarket_auto_live.event_exit import ExitSignal, PositionPriceSnapshot
from app.domains.polymarket_auto_live.engine import BullpenAutoLiveEngine, PositionSnapshot
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveRunRecord,
    PolymarketAutoLiveSettingsRecord,
    PolymarketAutoLiveStateRecord,
)
from app.domains.polymarket_auto_live.run_recovery import (
    finalize_failed_run_progress,
    reconcile_running_auto_live_run,
)
from app.domains.polymarket_auto_live.repository import (
    SyncPolymarketAutoLiveRepository,
    record_to_run,
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
        current_yes_odds=(
            float(payload["current_yes_odds"])
            if isinstance(payload.get("current_yes_odds"), (int, float))
            else None
        ),
        current_no_odds=(
            float(payload["current_no_odds"])
            if isinstance(payload.get("current_no_odds"), (int, float))
            else None
        ),
        best_bid_cents=(
            float(payload["best_bid_cents"])
            if isinstance(payload.get("best_bid_cents"), (int, float))
            else None
        ),
        best_ask_cents=(
            float(payload["best_ask_cents"])
            if isinstance(payload.get("best_ask_cents"), (int, float))
            else None
        ),
        price_history=[
            PositionPriceSnapshot.model_validate(snapshot)
            for snapshot in payload.get("price_history", [])
            if isinstance(snapshot, dict)
        ],
        exit_signals=[
            ExitSignal.model_validate(signal)
            for signal in payload.get("exit_signals", [])
            if isinstance(signal, dict)
        ],
        exit_state=payload.get("exit_state") if isinstance(payload.get("exit_state"), str) else "ACTIVE",
        estimated_freeable_value_usd=(
            float(payload["estimated_freeable_value_usd"])
            if isinstance(payload.get("estimated_freeable_value_usd"), (int, float))
            else None
        ),
    )

_finalize_failed_run_progress = finalize_failed_run_progress


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


def persist_auto_live_progress_sync(
    *,
    user_id: int,
    repo: SyncPolymarketAutoLiveRepository,
    session,
    run: BullpenAutoLiveRun,
    state,
) -> None:
    repo.save_run(user_id, run)
    repo.replace_run_decisions_from_stage3_payload(user_id, run)
    repo.save_state(user_id, state)
    session.commit()


@celery.task(
    bind=True,
    max_retries=2,
    default_retry_delay=30,
    # Keep this aligned with AUTO_LIVE_RUN_ABSOLUTE_TIMEOUT.  The soft limit
    # lets the task persist a failed run; the hard limit is the final guard
    # against a worker process stuck in an uninterruptible call.
    soft_time_limit=60 * 60 * 2,
    time_limit=(60 * 60 * 2) + 60,
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
                persist_auto_live_progress_sync(
                    user_id=user_id,
                    repo=repo,
                    session=session,
                    run=current_run,
                    state=current_state,
                )

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
            sanitized_error = redact_secrets(str(exc))
            current_retries = int(getattr(self.request, "retries", 0) or 0)
            max_retries = int(getattr(self, "max_retries", 0) or 0)
            if current_retries < max_retries and not isinstance(exc, SoftTimeLimitExceeded):
                retry_number = current_retries + 1
                run.status = "running"
                run.completed_at = None
                run.error_message = None
                run.summary = (
                    f"Auto-Live worker hit a retryable error and is automatically "
                    f"retrying attempt {retry_number} of {max_retries}: {sanitized_error}"
                )
                state.last_error = None
                state.last_action = run.summary
                state.last_run_id = run.id
                state.last_run_at = datetime.now(UTC).isoformat()
                repo.save_run(user_id, run)
                repo.save_state(user_id, state)
                session.commit()
                raise self.retry(exc=exc)

            completed_at = datetime.now(UTC).isoformat()
            run.status = "failed"
            run.completed_at = completed_at
            run.error_message = sanitized_error
            run.summary = finalize_failed_run_progress(
                run,
                failure_message=sanitized_error,
                completed_at=completed_at,
            )
            state.last_error = run.summary
            state.last_action = run.summary
            state.last_run_id = run.id
            state.last_run_at = completed_at
            persist_auto_live_progress_sync(
                user_id=user_id,
                repo=repo,
                session=session,
                run=run,
                state=state,
            )
            logger.exception("Auto-Live run %s exhausted retries", run_id)
            return

        repo.save_run(user_id, engine_result.run)
        repo.replace_run_decisions(user_id, run_id, engine_result.decisions)
        repo.replace_positions(user_id, engine_result.positions)
        repo.save_state(user_id, engine_result.state)
        session.commit()
        try:
            sync_auto_live_position_snapshots_sync(
                user_id=user_id,
                positions=engine_result.positions,
            )
        except Exception:
            logger.warning(
                "Auto-Live trade-analysis periodic snapshot sync failed for run %s.",
                run_id,
                exc_info=True,
            )


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
            state = record_to_state(state_record)
            active_run = session.execute(
                select(PolymarketAutoLiveRunRecord).where(
                    and_(
                        PolymarketAutoLiveRunRecord.user_id == user_id,
                        PolymarketAutoLiveRunRecord.status == "running",
                    )
                )
            ).scalar_one_or_none()
            if active_run is not None:
                recovered_run = reconcile_running_auto_live_run(
                    record_to_run(active_run),
                    started_at=active_run.started_at,
                    updated_at=active_run.updated_at,
                )
                if recovered_run is None:
                    continue

                state.last_run_id = recovered_run.id
                state.last_run_at = recovered_run.completed_at
                state.last_action = recovered_run.summary
                state.last_error = (
                    None if recovered_run.status == "completed" else recovered_run.summary
                )
                state = BullpenAutoLiveBot(user_id=user_id)._synchronize_state(
                    settings,
                    state,
                )
                repo.save_run(user_id, recovered_run)
                repo.replace_run_decisions_from_stage3_payload(user_id, recovered_run)
                repo.save_state(user_id, state)
                session.commit()

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
