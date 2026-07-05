from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from uuid import uuid4

from celery.exceptions import MaxRetriesExceededError
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


_PENDING_STAGE3_ORDER_DETAIL = "Order planned but not executed yet."
_WORKFLOW_STAGE_LABELS = {
    "scan": "Stage 1 · Bullpen Scan",
    "llm": "Stage 2 · Run LLM",
    "invest": "Stage 3 · Exit and Invest",
}


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


def _read_output_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = int(value)
        except ValueError:
            return None
        return parsed
    return None


def _append_failure_reason(reason: str, failure_message: str) -> str:
    normalized_reason = reason.strip()
    failure_suffix = f"Worker error: {failure_message}"
    if not normalized_reason:
        return failure_suffix
    if failure_message in normalized_reason or failure_suffix in normalized_reason:
        return normalized_reason
    separator = " " if normalized_reason.endswith((".", "!", "?")) else ". "
    return f"{normalized_reason}{separator}{failure_suffix}"


def _workflow_stage_label(stage) -> str:
    workflow_stage_key = stage.outputs.get("workflow_stage_key")
    if isinstance(workflow_stage_key, str):
        normalized_key = workflow_stage_key.strip().lower()
        if normalized_key in _WORKFLOW_STAGE_LABELS:
            return _WORKFLOW_STAGE_LABELS[normalized_key]
    return f"Stage {stage.stage_number}"


def _mark_stage3_decision_rows_failed(
    outputs: dict[str, object],
    *,
    failure_message: str,
) -> dict[str, object]:
    raw_decision_rows = outputs.get("decision_rows")
    if not isinstance(raw_decision_rows, list):
        return outputs

    updated_rows: list[object] = []
    failed_orders = 0
    processed_orders = 0

    for row in raw_decision_rows:
        if not isinstance(row, dict):
            updated_rows.append(row)
            continue

        next_row = dict(row)
        raw_order_plan = next_row.get("order_plan")
        if isinstance(raw_order_plan, dict):
            next_order_plan = dict(raw_order_plan)
            order_status = str(next_order_plan.get("status") or "").strip().lower()
            if order_status == "planned":
                next_order_plan["status"] = "failed"
                detail = str(next_order_plan.get("detail") or "").strip()
                if not detail or detail == _PENDING_STAGE3_ORDER_DETAIL:
                    next_order_plan["detail"] = failure_message
                next_row["order_plan"] = next_order_plan
                failed_orders += 1

            final_status = str(next_order_plan.get("status") or "").strip().lower()
            if final_status and final_status != "planned":
                processed_orders += 1

        updated_rows.append(next_row)

    outputs["decision_rows"] = updated_rows
    if failed_orders > 0:
        outputs["orders_failed"] = max(
            failed_orders,
            _read_output_int(outputs.get("orders_failed")) or 0,
        )
        outputs["orders_processed"] = max(
            processed_orders,
            _read_output_int(outputs.get("orders_processed")) or 0,
        )
    return outputs


def _finalize_failed_run_progress(
    run: BullpenAutoLiveRun,
    *,
    failure_message: str,
    completed_at: str,
) -> str:
    active_stage = next(
        (
            stage
            for stage in sorted(run.stage_results, key=lambda item: item.stage_number, reverse=True)
            if stage.completed_at is None
            or str(stage.outputs.get("phase_status") or "").strip().lower() == "running"
        ),
        None,
    )
    if active_stage is None:
        return f"Auto-Live run failed: {failure_message}"

    stage_outputs = dict(active_stage.outputs)
    stage_outputs["phase_status"] = "failed"
    stage_outputs["error_message"] = failure_message
    stage_outputs["failure_message"] = failure_message
    if str(stage_outputs.get("workflow_stage_key") or "").strip().lower() == "invest":
        stage_outputs = _mark_stage3_decision_rows_failed(
            stage_outputs,
            failure_message=failure_message,
        )

    active_stage.outputs = stage_outputs
    active_stage.status = "fail"
    active_stage.reason = _append_failure_reason(active_stage.reason, failure_message)
    active_stage.completed_at = completed_at

    return f"Auto-Live run failed during {_workflow_stage_label(active_stage)}: {failure_message}"


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
            sanitized_error = redact_secrets(str(exc))
            completed_at = datetime.now(UTC).isoformat()
            run.status = "failed"
            run.completed_at = completed_at
            run.error_message = sanitized_error
            run.summary = _finalize_failed_run_progress(
                run,
                failure_message=sanitized_error,
                completed_at=completed_at,
            )
            state.last_error = run.summary
            state.last_action = run.summary
            state.last_run_id = run.id
            state.last_run_at = completed_at
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
