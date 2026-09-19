from __future__ import annotations

import asyncio
import time
from datetime import timedelta
from uuid import uuid4

from sqlalchemy import select

from app.core.logging import get_logger
from app.domains.polymarket_auto_live.scanner import scan_candidate_markets
from app.domains.trading_bots.universal_scan import (
    UniversalExportWriter,
    due_user_ids,
    finish_run,
    latest_completed_universal_export,
    mark_queued,
    mark_started,
    parse_datetime,
    read_state,
    save_state,
    update_progress,
    utc_now,
)
from app.domains.trading_bots.models import UniversalScanStateRecord
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery

logger = get_logger("app.domains.trading_bots.tasks")

WORKFLOW_TRIGGER_REDISPATCH_AFTER = timedelta(minutes=45)


def _workflow_trigger_batch_id(universal_export_id: str) -> str:
    return f"universal-export-{universal_export_id}"


def ensure_completed_universal_scan_workflow_trigger(
    *,
    user_id: int,
    universal_export_id: str | None = None,
) -> dict[str, object]:
    """Publish or repair the durable Universal Scan -> Stage 1 handoff.

    Scan completion is committed before broker publication. The state marker
    below makes that gap recoverable: Beat republishes an unmarked completion,
    while deterministic workflow run IDs keep a replay idempotent.
    """

    resolved = latest_completed_universal_export(
        user_id,
        export_id=universal_export_id,
    )
    if resolved is None:
        return {"status": "missing_export", "user_id": user_id}
    metadata, _ = resolved
    export_id = str(metadata.get("exportId") or universal_export_id or "").strip()
    if not export_id:
        return {"status": "missing_export_id", "user_id": user_id}

    from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord
    from app.domains.polymarket_auto_live.tasks import (
        bullpen_workflow_trigger_run_id,
        queue_bullpen_workflow_trigger_batch,
    )
    from app.domains.polymarket_auto_live.workspace_profiles import (
        WORKFLOW_TRIGGER_PROFILES,
    )

    batch_id = _workflow_trigger_batch_id(export_id)
    now = utc_now()
    with SyncSessionLocal() as session:
        record = session.scalar(
            select(UniversalScanStateRecord)
            .where(UniversalScanStateRecord.user_id == user_id)
            .with_for_update()
        )
        state = read_state(record)
        missing_profiles = tuple(
            profile
            for profile in WORKFLOW_TRIGGER_PROFILES
            if session.get(
                PolymarketAutoLiveRunRecord,
                bullpen_workflow_trigger_run_id(
                    user_id=user_id,
                    triggered_by="universal_scan",
                    batch_id=batch_id,
                    workspace_profile=profile,
                ),
            )
            is None
        )
        if not missing_profiles:
            state["workflow_trigger_export_id"] = export_id
            state["workflow_trigger_completed_export_id"] = export_id
            save_state(session, user_id, state)
            session.commit()
            return {
                "status": "completed",
                "user_id": user_id,
                "universal_export_id": export_id,
            }

        dispatched_at = (
            parse_datetime(state.get("workflow_trigger_dispatched_at"))
            if state.get("workflow_trigger_export_id") == export_id
            else None
        )
        if dispatched_at is not None and now - dispatched_at < WORKFLOW_TRIGGER_REDISPATCH_AFTER:
            return {
                "status": "already_dispatched",
                "user_id": user_id,
                "universal_export_id": export_id,
                "missing_profiles": list(missing_profiles),
            }

        queue_bullpen_workflow_trigger_batch(
            user_id=user_id,
            triggered_by="universal_scan",
            batch_id=batch_id,
            universal_export_id=export_id,
            workspace_profiles=missing_profiles,
        )
        state["workflow_trigger_export_id"] = export_id
        state["workflow_trigger_dispatched_at"] = now.isoformat()
        save_state(session, user_id, state)
        session.commit()
        return {
            "status": "dispatched",
            "user_id": user_id,
            "universal_export_id": export_id,
            "missing_profiles": list(missing_profiles),
        }


class UniversalScanCancelled(RuntimeError):
    """Raised when the operator kills the active Universal Scan."""


def prepare_universal_scan(
    user_id: int,
    *,
    triggered_by: str,
) -> tuple[dict[str, object], bool]:
    run_id = f"universal-scan-{uuid4().hex}"
    with SyncSessionLocal() as session:
        record = session.scalar(
            select(UniversalScanStateRecord)
            .where(UniversalScanStateRecord.user_id == user_id)
            .with_for_update()
        )
        state = read_state(record)
        if state["running"]:
            return state, False
        state = mark_queued(session, user_id, run_id, triggered_by=triggered_by)
        session.commit()
    return state, True


def dispatch_universal_scan(user_id: int, run_id: str) -> None:
    try:
        execute_universal_polymarket_scan.apply_async(args=[user_id, run_id])
    except Exception as exc:
        with SyncSessionLocal() as session:
            finish_run(session, user_id, run_id, error=f"Could not queue Universal Scan: {exc}")
            session.commit()
        raise


def queue_universal_scan(user_id: int, *, triggered_by: str) -> dict[str, object]:
    state, should_dispatch = prepare_universal_scan(user_id, triggered_by=triggered_by)
    if should_dispatch:
        dispatch_universal_scan(user_id, str(state["run_id"]))
    return state


@celery.task(
    name="app.domains.trading_bots.tasks.execute_universal_polymarket_scan",
    bind=True,
    soft_time_limit=2_700,
    time_limit=3_000,
)
def execute_universal_polymarket_scan(_task, user_id: int, run_id: str) -> dict[str, object]:
    started_at = utc_now()
    with SyncSessionLocal() as session:
        if not mark_started(session, user_id, run_id):
            session.rollback()
            return {"run_id": run_id, "status": "ignored", "reason": "Run is no longer active."}
        session.commit()
    try:
        with UniversalExportWriter(user_id, started_at=started_at) as writer:
            def report_progress(events: int, pages: int) -> None:
                writer.set_pages(events, pages)
                while True:
                    with SyncSessionLocal() as progress_session:
                        control = update_progress(
                            progress_session,
                            user_id,
                            run_id,
                            events=events,
                            pages=pages,
                        )
                        progress_session.commit()
                    if control == "kill":
                        raise UniversalScanCancelled("Universal Scan cancelled by user.")
                    if control != "pause":
                        return
                    time.sleep(2)

            result = asyncio.run(scan_candidate_markets(
                min_liquidity_usd=0,
                apply_base_filters=False,
                use_keyset_pagination=True,
                filter_parent_deadlines=False,
                pagination_deadline_seconds=45 * 60,
                preserve_partial_on_error=False,
                accepted_callback=writer.add,
                progress_callback=report_progress,
                retain_candidates=False,
            ))
            if not result.complete_universe:
                raise RuntimeError(result.details or result.warning or "Universal Scan was incomplete.")
            writer.complete()
            total_events = writer.count
        with SyncSessionLocal() as session:
            state = finish_run(
                session,
                user_id,
                run_id,
                total_events=total_events,
            )
            state["workflow_trigger_export_id"] = writer.export_id
            state["workflow_trigger_dispatched_at"] = None
            save_state(session, user_id, state)
            session.commit()
        try:
            ensure_completed_universal_scan_workflow_trigger(
                user_id=user_id,
                universal_export_id=writer.export_id,
            )
        except Exception:
            logger.exception(
                "Universal Scan %s completed, but its Bullpen workflow trigger batch could not be queued.",
                run_id,
            )
        return {"run_id": run_id, "status": "completed", "total_events": total_events}
    except UniversalScanCancelled:
        with SyncSessionLocal() as session:
            state = read_state(session.get(UniversalScanStateRecord, user_id))
            finish_run(
                session,
                user_id,
                run_id,
                total_events=state["progress_events"],
                cancelled=True,
            )
            session.commit()
        return {"run_id": run_id, "status": "cancelled"}
    except Exception as exc:
        logger.exception("Universal Polymarket Scan %s failed", run_id)
        with SyncSessionLocal() as session:
            finish_run(session, user_id, run_id, error=str(exc)[:2_000])
            session.commit()
        raise


@celery.task(name="app.domains.trading_bots.tasks.enqueue_due_universal_polymarket_scans")
def enqueue_due_universal_polymarket_scans() -> dict[str, object]:
    with SyncSessionLocal() as session:
        user_ids = due_user_ids(session, utc_now())
        session.commit()
    queued = []
    for user_id in user_ids:
        try:
            state = queue_universal_scan(user_id, triggered_by="scheduler")
            if state.get("run_id"):
                queued.append(user_id)
        except Exception:
            logger.exception("Could not queue scheduled Universal Scan for user %s", user_id)
    return {"queued_user_ids": queued, "queued_count": len(queued)}


@celery.task(
    name="app.domains.trading_bots.tasks.reconcile_completed_universal_scan_workflow_triggers",
    queue="beat",
)
def reconcile_completed_universal_scan_workflow_triggers() -> dict[str, object]:
    """Repair completed scans whose Stage 1 broker handoff never became durable."""

    with SyncSessionLocal() as session:
        user_ids = list(
            session.execute(select(UniversalScanStateRecord.user_id)).scalars().all()
        )

    results: list[dict[str, object]] = []
    for user_id in user_ids:
        try:
            results.append(
                ensure_completed_universal_scan_workflow_trigger(user_id=user_id)
            )
        except Exception:
            logger.exception(
                "Could not reconcile the completed Universal Scan workflow trigger for user %s.",
                user_id,
            )
    return {"checked_user_ids": user_ids, "results": results}
