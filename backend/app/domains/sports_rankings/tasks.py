import hashlib
import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import OperationalError

from app.core.logging import get_logger
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery
from .catalogue import SOURCE_IDS
from .models import SportsRankingSnapshot
from .providers import fetch_source

logger = get_logger(__name__)


@celery.task(bind=True, max_retries=2, soft_time_limit=20, time_limit=25)
def dispatch_refresh(self):
    try:
        for source_id in sorted(SOURCE_IDS):
            refresh_source.delay(source_id)
    except Exception as exc:
        logger.exception("Sports ranking dispatch failed")
        raise self.retry(exc=exc, countdown=60)


@celery.task(bind=True, max_retries=2, soft_time_limit=70, time_limit=80)
def refresh_source(self, source_id):
    if source_id not in SOURCE_IDS:
        raise ValueError("Unknown ranking source")
    now = datetime.now(UTC)
    with SyncSessionLocal() as db:
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
