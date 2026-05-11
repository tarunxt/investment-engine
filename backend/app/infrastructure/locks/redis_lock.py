from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from uuid import uuid4

from redis.asyncio import Redis

logger = logging.getLogger(__name__)

_UNLOCK_SCRIPT = (
    "if redis.call('get',KEYS[1])==ARGV[1] "
    "then return redis.call('del',KEYS[1]) "
    "else return 0 end"
)


class LockAcquisitionError(Exception):
    pass


class RedisLock:
    """Distributed lock via Redis SET NX + Lua delete-if-owner pattern."""

    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    @asynccontextmanager
    async def acquire(self, key: str, ttl: int = 30, timeout: int = 10):
        """Context manager that holds lock for *key* or raises LockAcquisitionError."""
        lock_key = f"lock:{key}"
        token = str(uuid4())
        deadline = asyncio.get_event_loop().time() + timeout

        while asyncio.get_event_loop().time() < deadline:
            acquired = await self._redis.set(lock_key, token, nx=True, ex=ttl)
            if acquired:
                try:
                    yield
                finally:
                    await self._redis.eval(_UNLOCK_SCRIPT, 1, lock_key, token)  # type: ignore[arg-type]
                return
            await asyncio.sleep(0.05)

        raise LockAcquisitionError(f"Timed out acquiring lock: {key}")
