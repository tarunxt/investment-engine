from __future__ import annotations

import copy
import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import redis as sync_redis

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

CURRENT_MONTH_CACHE_TTL_SECONDS = 6 * 60 * 60
HISTORICAL_MONTH_CACHE_TTL_SECONDS = 24 * 60 * 60
MANUAL_REFRESH_COOLDOWN_SECONDS = 15 * 60
STALE_GOOD_TTL_SECONDS = 7 * 24 * 60 * 60

_CACHE_NAMESPACE = "cost-drivers:v2"
_LOCAL_CACHE: dict[str, dict[str, Any]] = {}
_LOCAL_STALE: dict[str, dict[str, Any]] = {}
_LOCAL_COOLDOWNS: dict[str, float] = {}


class RefreshCooldownError(RuntimeError):
    def __init__(self, retry_after_seconds: int):
        self.retry_after_seconds = retry_after_seconds
        super().__init__(
            f"Refresh is rate-limited. Try again in {retry_after_seconds} seconds."
        )


@dataclass
class CacheRecord:
    data: dict[str, Any]
    cached_at: str | None


def dashboard_cache_ttl_seconds(is_current_month: bool) -> int:
    return (
        CURRENT_MONTH_CACHE_TTL_SECONDS
        if is_current_month
        else HISTORICAL_MONTH_CACHE_TTL_SECONDS
    )


def refresh_cooldown_seconds() -> int:
    return MANUAL_REFRESH_COOLDOWN_SECONDS


def _cache_key(kind: str, cache_key: str) -> str:
    return f"{_CACHE_NAMESPACE}:{kind}:{cache_key}"


def _redis_client() -> sync_redis.Redis | None:
    try:
        return sync_redis.from_url(settings.redis_url, decode_responses=True)
    except Exception:
        logger.exception("Unable to create Redis client for cost dashboard cache")
        return None


def _decode_record(raw: str | None) -> CacheRecord | None:
    if not raw:
        return None
    try:
        payload = json.loads(raw)
        data = payload.get("data")
        if not isinstance(data, dict):
            return None
        return CacheRecord(
            data=copy.deepcopy(data),
            cached_at=payload.get("cachedAt"),
        )
    except (TypeError, ValueError):
        logger.exception("Unable to decode cost dashboard cache payload")
        return None


def _encode_record(data: dict[str, Any], cached_at: str) -> str:
    return json.dumps({"data": data, "cachedAt": cached_at})


def load_cached_dashboard(cache_key: str) -> CacheRecord | None:
    redis_client = _redis_client()
    if redis_client is not None:
        try:
            return _decode_record(redis_client.get(_cache_key("dashboard", cache_key)))
        except Exception:
            logger.exception("Unable to read cost dashboard cache from Redis")
        finally:
            redis_client.close()

    record = _LOCAL_CACHE.get(cache_key)
    if not record or time.time() >= float(record.get("expiresAt", 0)):
        return None

    data = record.get("data")
    if not isinstance(data, dict):
        return None

    return CacheRecord(
        data=copy.deepcopy(data),
        cached_at=record.get("cachedAt"),
    )


def load_stale_good_dashboard(cache_key: str) -> CacheRecord | None:
    redis_client = _redis_client()
    if redis_client is not None:
        try:
            return _decode_record(redis_client.get(_cache_key("stale-good", cache_key)))
        except Exception:
            logger.exception("Unable to read stale-good cost dashboard cache from Redis")
        finally:
            redis_client.close()

    record = _LOCAL_STALE.get(cache_key)
    if not record or time.time() >= float(record.get("expiresAt", 0)):
        return None

    data = record.get("data")
    if not isinstance(data, dict):
        return None

    return CacheRecord(
        data=copy.deepcopy(data),
        cached_at=record.get("cachedAt"),
    )


def store_dashboard(cache_key: str, data: dict[str, Any], ttl_seconds: int) -> str:
    cached_at = datetime.now(timezone.utc).isoformat()
    payload = _encode_record(copy.deepcopy(data), cached_at)
    redis_client = _redis_client()
    if redis_client is not None:
        try:
            redis_client.set(_cache_key("dashboard", cache_key), payload, ex=ttl_seconds)
            redis_client.set(
                _cache_key("stale-good", cache_key),
                payload,
                ex=STALE_GOOD_TTL_SECONDS,
            )
            return cached_at
        except Exception:
            logger.exception("Unable to write cost dashboard cache to Redis")
        finally:
            redis_client.close()

    expires_at = time.time() + ttl_seconds
    stale_expires_at = time.time() + STALE_GOOD_TTL_SECONDS
    _LOCAL_CACHE[cache_key] = {
        "data": copy.deepcopy(data),
        "expiresAt": expires_at,
        "cachedAt": cached_at,
    }
    _LOCAL_STALE[cache_key] = {
        "data": copy.deepcopy(data),
        "expiresAt": stale_expires_at,
        "cachedAt": cached_at,
    }
    return cached_at


def claim_refresh_cooldown(cache_key: str) -> None:
    ttl_seconds = refresh_cooldown_seconds()
    redis_client = _redis_client()
    if redis_client is not None:
        try:
            cooldown_key = _cache_key("refresh-cooldown", cache_key)
            if redis_client.set(cooldown_key, "1", nx=True, ex=ttl_seconds):
                return
            retry_after = redis_client.ttl(cooldown_key)
            if retry_after is None or retry_after < 0:
                retry_after = ttl_seconds
            raise RefreshCooldownError(int(retry_after))
        except RefreshCooldownError:
            raise
        except Exception:
            logger.exception("Unable to claim shared refresh cooldown in Redis")
        finally:
            redis_client.close()

    now = time.time()
    expires_at = _LOCAL_COOLDOWNS.get(cache_key)
    if expires_at and now < expires_at:
        raise RefreshCooldownError(int(expires_at - now))

    _LOCAL_COOLDOWNS[cache_key] = now + ttl_seconds


def reset_local_cost_dashboard_cache_state() -> None:
    _LOCAL_CACHE.clear()
    _LOCAL_STALE.clear()
    _LOCAL_COOLDOWNS.clear()
