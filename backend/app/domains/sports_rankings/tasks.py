import hashlib
import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import OperationalError

from app.core.logging import get_logger
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery
from .catalogue import SOURCE_IDS
from .models import SportsRankingSnapshot
from .providers import fetch_source
from .feeds import CRICKET_SOURCE_IDS

logger = get_logger(__name__)

# Spread one refresh cycle across fourteen minutes.  Queueing every source at
# once exhausts the shared worker/database pool and can make the HTTP backend
# unreachable exactly when the quarter-hour refresh begins.
REFRESH_DISPATCH_WINDOW_SECONDS = 14 * 60
REFRESH_CONCURRENCY_SLOTS = 4
REFRESH_ADVISORY_LOCK_BASE = 764_210


def _refresh_slot(source_id: str) -> int:
    digest = hashlib.sha256(source_id.encode()).digest()
    return int.from_bytes(digest[:4], "big") % REFRESH_CONCURRENCY_SLOTS


def _refresh_deferral_seconds(source_id: str) -> int:
    digest = hashlib.sha256(source_id.encode()).digest()
    return 30 + int.from_bytes(digest[4:6], "big") % 60

# Backfill pre-release scan indexes after deployment.  The normal beat schedule
# owns source refreshes; dispatching the full catalogue again from worker startup
# creates a duplicate burst and can starve the API during deployments.
from celery.signals import worker_ready


@worker_ready.connect
def prime_rankings_on_start(sender=None, **kwargs):
    from redis import Redis
    from app.core.config import settings
    try:
        with Redis.from_url(settings.redis_url, socket_timeout=2, socket_connect_timeout=2) as redis:
            if redis.set("sports-rankings:startup:v4", "1", nx=True, ex=300):
                rebuild_polymarket_participant_indexes.apply_async(retry=False)
    except Exception:
        logger.exception("Sports ranking startup dispatch failed; scheduled refresh remains enabled")


@celery.task(bind=True, max_retries=2, soft_time_limit=20, time_limit=25)
def dispatch_refresh(self):
    try:
        source_ids = sorted(SOURCE_IDS)
        source_count = len(source_ids)
        for index, source_id in enumerate(source_ids):
            countdown = (
                index * REFRESH_DISPATCH_WINDOW_SECONDS // source_count
                if source_count
                else 0
            )
            refresh_source.apply_async(
                args=[source_id],
                countdown=countdown,
                retry=False,
            )
        return {"status": "queued", "sources": source_count}
    except Exception as exc:
        logger.exception("Sports ranking dispatch failed")
        raise self.retry(exc=exc, countdown=60)


@celery.task(bind=True, max_retries=2, soft_time_limit=20, time_limit=25)
def reconcile_cricket(self):
    """Daily full-source reconciliation, also available on demand from the UI."""
    try:
        for source_id in sorted(CRICKET_SOURCE_IDS):
            refresh_source.apply_async(args=[source_id], retry=False)
        return {"status": "queued", "sources": len(CRICKET_SOURCE_IDS)}
    except Exception as exc:
        logger.exception("Cricket reconciliation dispatch failed")
        raise self.retry(exc=exc, countdown=60)


@celery.task(bind=True, max_retries=1, soft_time_limit=240, time_limit=300)
def rebuild_polymarket_participant_indexes(self):
    """Backfill compact participant indexes for scans completed before this release."""
    from app.domains.sports_rankings.polymarket_participants import (
        participant_index_path,
        write_participant_index,
    )
    from app.domains.trading_bots.models import UniversalScanStateRecord
    from app.domains.trading_bots.universal_scan import (
        iter_universal_scan_markets,
        latest_completed_universal_export,
    )

    try:
        with SyncSessionLocal() as db:
            user_ids = list(db.scalars(select(UniversalScanStateRecord.user_id)).all())
        rebuilt = 0
        for user_id in user_ids:
            resolved = latest_completed_universal_export(user_id)
            if resolved is None:
                continue
            metadata, rows_path = resolved
            if participant_index_path(rows_path).is_file():
                continue
            _, markets = iter_universal_scan_markets(user_id, export_id=metadata.get("exportId"))
            write_participant_index(rows_path, markets, export_id=metadata.get("exportId"))
            rebuilt += 1
        return {"status": "ready", "rebuilt": rebuilt}
    except Exception as exc:
        logger.exception("Polymarket sports participant index backfill failed")
        raise self.retry(exc=exc, countdown=120)


@celery.task(bind=True, max_retries=2, soft_time_limit=70, time_limit=80)
def refresh_source(self, source_id):
    if source_id not in SOURCE_IDS:
        raise ValueError("Unknown ranking source")
    now = datetime.now(UTC)
    with SyncSessionLocal() as db:
        # A cycle can contain hundreds of sources.  Keep only a small bounded
        # number of network fetches/transactions alive across every worker and
        # defer overflow instead of exhausting PostgreSQL connections or RAM.
        lock_key = REFRESH_ADVISORY_LOCK_BASE + _refresh_slot(source_id)
        has_slot = bool(db.scalar(select(func.pg_try_advisory_xact_lock(lock_key))))
        if not has_slot:
            refresh_source.apply_async(
                args=[source_id],
                countdown=_refresh_deferral_seconds(source_id),
                retry=False,
            )
            return {"status": "deferred"}
        db.execute(insert(SportsRankingSnapshot).values(source_id=source_id, status="pending", rows=[]).on_conflict_do_nothing(index_elements=["source_id"]))
        db.commit()
        # One writer per source, including duplicate deliveries and manual refresh.
        try:
            snapshot = db.scalar(select(SportsRankingSnapshot).where(SportsRankingSnapshot.source_id == source_id).with_for_update(nowait=True))
        except OperationalError as exc:
            db.rollback()
            if getattr(exc.orig, "pgcode", None) == "55P03":
                return {"status": "already_processing"}
            logger.exception("Sports ranking lock failed: %s", source_id)
            raise self.retry(exc=exc, countdown=60)
        checked = snapshot.checked_at
        if checked and checked.tzinfo is None:
            checked = checked.replace(tzinfo=UTC)
        if checked and now - checked < timedelta(seconds=60):
            return {"status": "cooldown"}
        try:
            result = fetch_source(source_id)
            digest = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
            if digest != snapshot.content_hash:
                for key, value in result.items():
                    setattr(snapshot, key, value)
                snapshot.content_hash = digest
            snapshot.status = "ready"
            snapshot.error = None
            snapshot.checked_at = datetime.now(UTC)
            snapshot.successful_at = snapshot.checked_at
            db.commit()
            return {"status": "ready", "rows": len(result["rows"])}
        except Exception as exc:
            # Retain last successful rows on source failures. Never publish empty rankings.
            logger.exception("Sports ranking refresh failed: %s", source_id)
            snapshot.status = "failed"
            snapshot.checked_at = datetime.now(UTC)
            snapshot.error = f"{type(exc).__name__}: {str(exc)[:350]}"
            db.commit()
            raise self.retry(exc=exc, countdown=120 * (self.request.retries + 1))
