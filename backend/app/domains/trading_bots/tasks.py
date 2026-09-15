from __future__ import annotations

import asyncio
from uuid import uuid4

from sqlalchemy import select

from app.core.logging import get_logger
from app.domains.polymarket_auto_live.scanner import scan_candidate_markets
from app.domains.trading_bots.universal_scan import (
    UniversalExportWriter,
    due_user_ids,
    finish_run,
    mark_queued,
    mark_started,
    read_state,
    utc_now,
)
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveStateRecord
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery

logger = get_logger("app.domains.trading_bots.tasks")


def queue_universal_scan(user_id: int, *, triggered_by: str) -> dict[str, object]:
    run_id = f"universal-scan-{uuid4().hex}"
    with SyncSessionLocal() as session:
        record = session.scalar(
            select(PolymarketAutoLiveStateRecord)
            .where(PolymarketAutoLiveStateRecord.user_id == user_id)
            .with_for_update()
        )
        state = read_state(record)
        if state["running"]:
            return state
        state = mark_queued(session, user_id, run_id, triggered_by=triggered_by)
        session.commit()
    try:
        execute_universal_polymarket_scan.apply_async(args=[user_id, run_id])
    except Exception as exc:
        with SyncSessionLocal() as session:
            finish_run(session, user_id, run_id, error=f"Could not queue Universal Scan: {exc}")
            session.commit()
        raise
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
            result = asyncio.run(scan_candidate_markets(
                min_liquidity_usd=0,
                apply_base_filters=False,
                use_keyset_pagination=True,
                filter_parent_deadlines=False,
                pagination_deadline_seconds=45 * 60,
                preserve_partial_on_error=False,
                accepted_callback=writer.add,
                progress_callback=writer.set_pages,
                retain_candidates=False,
            ))
            if not result.complete_universe:
                raise RuntimeError(result.details or result.warning or "Universal Scan was incomplete.")
            writer.complete()
            total_events = writer.count
        with SyncSessionLocal() as session:
            finish_run(session, user_id, run_id, total_events=total_events)
            session.commit()
        return {"run_id": run_id, "status": "completed", "total_events": total_events}
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
