from __future__ import annotations

import asyncio
import json
from uuid import uuid4

import redis as sync_redis

from app.core.config import settings
from app.core.logging import get_logger
from app.domains.bullpen_trade_analysis.service import (
    BullpenTradeHistorySyncResult,
    sync_bullpen_trade_history_for_user,
)
from app.infrastructure.messaging.celery_app import celery

logger = get_logger(__name__)

_SYNC_NAMESPACE = "bullpen:trade-analysis:history-sync"
_PENDING_TTL_SECONDS = 300
_LEASE_TTL_SECONDS = 150
_DELETE_IF_OWNER_SCRIPT = (
    "if redis.call('get', KEYS[1]) == ARGV[1] "
    "then return redis.call('del', KEYS[1]) "
    "else return 0 end"
)


def _sync_key(kind: str, user_id: int) -> str:
    return f"{_SYNC_NAMESPACE}:{kind}:{int(user_id)}"


def _trade_history_sync_redis_client() -> sync_redis.Redis:
    return sync_redis.from_url(
        settings.redis_url,
        decode_responses=True,
        socket_connect_timeout=1,
        socket_timeout=1,
    )


def _delete_if_owner(
    redis_client: sync_redis.Redis,
    *,
    key: str,
    token: str,
) -> None:
    redis_client.eval(_DELETE_IF_OWNER_SCRIPT, 1, key, token)


def _log_event(level: str, event: str, **fields: object) -> None:
    getattr(logger, level)(
        json.dumps(
            {
                "event": event,
                **fields,
            },
            sort_keys=True,
            default=str,
        )
    )


def request_bullpen_trade_analysis_history_sync(user_id: int) -> bool:
    """Queue one bounded history refresh without delaying the list response.

    Redis is the duplicate-execution boundary. If Redis or Celery is
    unavailable, persisted PostgreSQL data remains readable and this function
    deliberately does not run the Bullpen CLI inside the API process.
    """

    normalized_user_id = int(user_id)
    pending_key = _sync_key("pending", normalized_user_id)
    token = str(uuid4())
    redis_client: sync_redis.Redis | None = None
    try:
        redis_client = _trade_history_sync_redis_client()
        acquired = redis_client.set(
            pending_key,
            token,
            nx=True,
            ex=_PENDING_TTL_SECONDS,
        )
        if not acquired:
            _log_event(
                "info",
                "bullpen_trade_analysis_history_sync_deduplicated",
                user_id=normalized_user_id,
                reason="refresh_already_pending",
            )
            return False

        refresh_bullpen_trade_analysis_history.apply_async(  # type: ignore[attr-defined]
            kwargs={
                "user_id": normalized_user_id,
                "request_token": token,
            },
            queue="ai",
        )
        _log_event(
            "info",
            "bullpen_trade_analysis_history_sync_queued",
            user_id=normalized_user_id,
        )
        return True
    except Exception:
        logger.exception(
            "Unable to queue Bullpen trade-analysis history sync for user %s; "
            "serving the persisted database snapshot without inline fallback.",
            normalized_user_id,
        )
        if redis_client is not None:
            try:
                _delete_if_owner(redis_client, key=pending_key, token=token)
            except Exception:
                logger.warning(
                    "Unable to clear failed Bullpen trade-analysis history sync "
                    "marker for user %s.",
                    normalized_user_id,
                    exc_info=True,
                )
        return False
    finally:
        if redis_client is not None:
            redis_client.close()


@celery.task(
    bind=True,
    max_retries=0,
    soft_time_limit=120,
    time_limit=135,
    name=(
        "app.domains.bullpen_trade_analysis.tasks."
        "refresh_bullpen_trade_analysis_history"
    ),
    queue="ai",
)
def refresh_bullpen_trade_analysis_history(
    self,
    *,
    user_id: int,
    request_token: str,
) -> str:
    """Refresh history once for the token-owning request.

    The pending token rejects expired or superseded messages and the lease
    rejects concurrent/redelivered workers. The underlying upserts are
    idempotent, while this task intentionally has no Celery retries.
    """

    del self
    normalized_user_id = int(user_id)
    token = str(request_token).strip()
    pending_key = _sync_key("pending", normalized_user_id)
    lease_key = _sync_key("lease", normalized_user_id)
    redis_client: sync_redis.Redis | None = None
    lease_acquired = False

    if not token:
        _log_event(
            "warning",
            "bullpen_trade_analysis_history_sync_skipped",
            user_id=normalized_user_id,
            reason="missing_request_token",
        )
        return "skipped_invalid_token"

    try:
        redis_client = _trade_history_sync_redis_client()
        if redis_client.get(pending_key) != token:
            _log_event(
                "info",
                "bullpen_trade_analysis_history_sync_skipped",
                user_id=normalized_user_id,
                reason="stale_or_superseded_request",
            )
            return "skipped_stale_request"

        lease_acquired = bool(
            redis_client.set(
                lease_key,
                token,
                nx=True,
                ex=_LEASE_TTL_SECONDS,
            )
        )
        if not lease_acquired:
            _log_event(
                "info",
                "bullpen_trade_analysis_history_sync_deduplicated",
                user_id=normalized_user_id,
                reason="worker_lease_already_held",
            )
            return "skipped_duplicate_worker"

        _log_event(
            "info",
            "bullpen_trade_analysis_history_sync_started",
            user_id=normalized_user_id,
        )
        result = asyncio.run(
            sync_bullpen_trade_history_for_user(normalized_user_id)
        )
        if (
            not isinstance(result, BullpenTradeHistorySyncResult)
            or not result.has_valid_source
        ):
            raise RuntimeError(
                "Bullpen trade-analysis history refresh produced no valid source."
            )
        if not (
            result.trade_history_succeeded
            and result.redeemed_history_succeeded
        ):
            _log_event(
                "warning",
                "bullpen_trade_analysis_history_sync_partial",
                user_id=normalized_user_id,
                reason="one_history_source_failed",
                trade_history_succeeded=result.trade_history_succeeded,
                redeemed_history_succeeded=result.redeemed_history_succeeded,
            )
        _log_event(
            "info",
            "bullpen_trade_analysis_history_sync_completed",
            user_id=normalized_user_id,
            trade_count=result.trade_count,
            redeemed_trade_count=result.redeemed_trade_count,
        )
        return "completed"
    except Exception:
        logger.exception(
            "Bullpen trade-analysis history sync failed for user %s. Celery "
            "retry is disabled; a later deduplicated page request may enqueue "
            "a fresh attempt.",
            normalized_user_id,
        )
        raise
    finally:
        if redis_client is not None:
            if lease_acquired:
                try:
                    _delete_if_owner(redis_client, key=lease_key, token=token)
                except Exception:
                    logger.warning(
                        "Unable to release Bullpen trade-analysis history sync "
                        "lease for user %s.",
                        normalized_user_id,
                        exc_info=True,
                    )
                try:
                    _delete_if_owner(redis_client, key=pending_key, token=token)
                except Exception:
                    logger.warning(
                        "Unable to clear Bullpen trade-analysis history sync pending "
                        "marker for user %s.",
                        normalized_user_id,
                        exc_info=True,
                    )
            redis_client.close()
