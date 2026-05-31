from __future__ import annotations

import httpx
from celery.exceptions import MaxRetriesExceededError
from datetime import datetime, timezone

from app.core.logging import get_logger
from app.domains.zerodha.audit import SyncZerodhaAuditRepository
from app.domains.zerodha.portfolio import build_portfolio_snapshot, current_snapshot_date
from app.domains.zerodha.repository import (
    SyncZerodhaCredentialRepository,
    SyncZerodhaPortfolioSnapshotRepository,
)
from app.domains.zerodha.service import KiteError, ZerodhaService
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery

logger = get_logger(__name__)
_svc = ZerodhaService()


def _error_text(exc: Exception) -> str:
    text = str(exc).strip()
    if text:
        return text[:500]
    return f"{exc.__class__.__name__}: unknown Zerodha sync error"


def _is_terminal_kite_error(exc: KiteError) -> bool:
    text = exc.message.lower()
    return any(
        marker in text
        for marker in (
            "token is invalid",
            "session is invalid",
            "invalid api key",
            "invalid token",
            "permission denied",
            "forbidden",
            "not connected",
        )
    )


def _retry_countdown(attempt: int) -> int:
    return 30 * (2 ** attempt)


@celery.task(bind=True, max_retries=3, soft_time_limit=60, time_limit=90)
def sync_portfolio_snapshot_task(self, user_id: int, source: str = "manual"):
    with SyncSessionLocal() as db:
        cred_repo = SyncZerodhaCredentialRepository(db)
        snapshot_repo = SyncZerodhaPortfolioSnapshotRepository(db)
        audit = SyncZerodhaAuditRepository(db)
        now = datetime.now(tz=timezone.utc)

        cred = cred_repo.get_by_user(user_id)
        if not cred:
            audit.log(
                user_id,
                "portfolio_sync_skipped",
                details={"reason": "not_connected", "source": source},
            )
            db.commit()
            return {"status": "skipped", "reason": "not_connected"}

        if cred.expires_at <= now:
            audit.log(
                user_id,
                "portfolio_sync_skipped",
                details={"reason": "session_expired", "source": source},
            )
            db.commit()
            return {"status": "skipped", "reason": "session_expired"}

        token = cred_repo.get_plaintext_token(user_id)
        if not token:
            audit.log(
                user_id,
                "portfolio_sync_skipped",
                details={"reason": "missing_token", "source": source},
            )
            db.commit()
            return {"status": "skipped", "reason": "missing_token"}

        try:
            holdings = _svc.get_holdings_sync(token)
            positions = _svc.get_positions_sync(token)
            snapshot_data = build_portfolio_snapshot(
                holdings,
                positions,
                captured_at=now,
                source=source,
            )
            snapshot = snapshot_repo.upsert_snapshot(user_id, snapshot_data)
            audit.log(
                user_id,
                "portfolio_sync_completed",
                details={
                    "source": source,
                    "snapshot_date": snapshot.snapshot_date.isoformat(),
                    "captured_at": snapshot.captured_at.isoformat(),
                    "holdings_count": snapshot.holdings_count,
                    "net_positions_count": snapshot.net_positions_count,
                    "day_positions_count": snapshot.day_positions_count,
                },
            )
            db.commit()
            logger.info(
                "Zerodha portfolio snapshot synced for user %s on %s via %s",
                user_id,
                snapshot.snapshot_date,
                source,
            )
            return {
                "status": "completed",
                "snapshot_date": snapshot.snapshot_date.isoformat(),
                "captured_at": snapshot.captured_at.isoformat(),
            }
        except KiteError as exc:
            reason = _error_text(exc)
            audit.log(
                user_id,
                "portfolio_sync_failed",
                details={"error": reason, "source": source},
            )
            db.commit()

            if _is_terminal_kite_error(exc):
                logger.warning(
                    "Terminal Zerodha portfolio sync failure for user %s: %s",
                    user_id,
                    reason,
                )
                return {"status": "failed", "reason": reason}

            try:
                raise self.retry(exc=exc, countdown=_retry_countdown(self.request.retries))
            except MaxRetriesExceededError:
                logger.exception("Max retries exceeded for Zerodha portfolio sync user %s", user_id)
                return {"status": "failed", "reason": reason}
        except httpx.HTTPError as exc:
            reason = _error_text(exc)
            audit.log(
                user_id,
                "portfolio_sync_failed",
                details={"error": reason, "source": source},
            )
            db.commit()
            try:
                raise self.retry(exc=exc, countdown=_retry_countdown(self.request.retries))
            except MaxRetriesExceededError:
                logger.exception("HTTP retries exhausted for Zerodha portfolio sync user %s", user_id)
                return {"status": "failed", "reason": reason}
        except Exception as exc:
            reason = _error_text(exc)
            logger.exception("Unexpected Zerodha portfolio sync failure for user %s", user_id)
            audit.log(
                user_id,
                "portfolio_sync_failed",
                details={"error": reason, "source": source},
            )
            db.commit()
            try:
                raise self.retry(exc=exc, countdown=_retry_countdown(self.request.retries))
            except MaxRetriesExceededError:
                return {"status": "failed", "reason": reason}


@celery.task(bind=True, max_retries=2, soft_time_limit=120, time_limit=180)
def enqueue_daily_portfolio_sync(self):
    with SyncSessionLocal() as db:
        cred_repo = SyncZerodhaCredentialRepository(db)
        active_user_ids = cred_repo.list_active_user_ids(datetime.now(tz=timezone.utc))

    for user_id in active_user_ids:
        sync_portfolio_snapshot_task.delay(user_id, "scheduled")  # type: ignore[attr-defined]

    logger.info(
        "Queued daily Zerodha portfolio sync for %s users on %s",
        len(active_user_ids),
        current_snapshot_date(),
    )
    return {
        "status": "queued",
        "users": len(active_user_ids),
        "snapshot_date": current_snapshot_date().isoformat(),
    }
