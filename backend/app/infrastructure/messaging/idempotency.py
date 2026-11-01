from __future__ import annotations

import json
import logging

from redis.asyncio import Redis

logger = logging.getLogger(__name__)

_PREFIX = "idem:"
_DEFAULT_TTL = 86_400  # 24 h


class IdempotencyStore:
    """Optional cache of hints; never an authorization or admission authority.

    Creation callers supply actor/operation/key-hash/payload-fingerprint identity
    from jobs.admission.request_identity and always reread the durable owner.
    Legacy unscoped entries are deliberately not consumed by admission.
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
