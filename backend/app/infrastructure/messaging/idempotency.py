from __future__ import annotations

import json
import logging

from redis.asyncio import Redis

logger = logging.getLogger(__name__)

_PREFIX = "idem:"
_DEFAULT_TTL = 86_400  # 24 h


class IdempotencyStore:
    """Redis cache with explicit actor/operation/payload-bound user APIs.

    This is time-bounded caching, not durable admission. Legacy unscoped values
    are never consumed by job creation. A cached ID must still pass DB ownership
    and payload checks before replay.
    """

    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def get(self, key: str) -> dict | None:
        raw = await self._redis.get(f"{_PREFIX}{key}")
        if raw is None:
            return None
        return json.loads(raw)  # type: ignore[arg-type]

    async def set(self, key: str, result: dict, ttl: int = _DEFAULT_TTL) -> None:
        await self._redis.setex(f"{_PREFIX}{key}", ttl, json.dumps(result))

    async def exists(self, key: str) -> bool:
        return bool(await self._redis.exists(f"{_PREFIX}{key}"))

    async def get_for_request(self, user_id, operation: str, key: str, fingerprint: str):
        from app.domains.jobs.creation_identity import request_key
        from app.shared.exceptions import ConflictException
        cached = await self.get(request_key(user_id, operation, key))
        if cached is None:
            return None
        if (not isinstance(cached, dict) or cached.get("actor_id") != int(user_id)
                or cached.get("operation") != operation):
            raise ConflictException("Cached request is unavailable. Use a new request key.")
        if cached.get("payload_fingerprint") != fingerprint:
            raise ConflictException("Idempotency key was already used with a different request.")
        result = cached.get("result")
        if not isinstance(result, dict) or "job_id" not in result:
            raise ConflictException("Cached request is unavailable. Use a new request key.")
        return result

    async def set_for_request(self, user_id, operation: str, key: str, fingerprint: str, result: dict):
        from app.domains.jobs.creation_identity import request_key
        await self.set(request_key(user_id, operation, key), {
            "actor_id": int(user_id), "operation": operation,
            "payload_fingerprint": fingerprint, "result": result,
        })
