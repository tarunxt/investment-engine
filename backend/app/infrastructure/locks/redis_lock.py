from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from time import monotonic
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


@dataclass
class LockLease:
    key: str
    lock_key: str
    token: str
    ttl_seconds: int
    timeout_seconds: int
    wait_duration_seconds: float
    acquired_at_monotonic: float
    released_at_monotonic: float | None = None

    @property
    def hold_duration_seconds(self) -> float | None:
        if self.released_at_monotonic is None:
            return None
        return max(0.0, self.released_at_monotonic - self.acquired_at_monotonic)


class RedisLock:
    """Distributed lock via Redis SET NX + Lua delete-if-owner pattern."""

    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    @asynccontextmanager
    async def acquire(self, key: str, ttl: int = 30, timeout: int = 10):
        """Context manager that holds lock for *key* or raises LockAcquisitionError."""
        lock_key = f"lock:{key}"
        token = str(uuid4())
        loop = asyncio.get_running_loop()
        started_at = monotonic()
        deadline = loop.time() + timeout

        while loop.time() < deadline:
            acquired = await self._redis.set(lock_key, token, nx=True, ex=ttl)
            if acquired:
                lease = LockLease(
                    key=key,
                    lock_key=lock_key,
                    token=token,
                    ttl_seconds=ttl,
                    timeout_seconds=timeout,
                    wait_duration_seconds=max(0.0, monotonic() - started_at),
                    acquired_at_monotonic=monotonic(),
                )
                try:
                    yield lease
                finally:
                    await self._redis.eval(_UNLOCK_SCRIPT, 1, lock_key, token)  # type: ignore[arg-type]
                    lease.released_at_monotonic = monotonic()
                return
            await asyncio.sleep(0.05)

        raise LockAcquisitionError(f"Timed out acquiring lock: {key}")
