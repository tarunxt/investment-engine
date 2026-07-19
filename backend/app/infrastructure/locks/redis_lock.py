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
_RENEW_SCRIPT = (
    "if redis.call('get',KEYS[1])==ARGV[1] "
    "then return redis.call('expire',KEYS[1],ARGV[2]) "
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
    async def acquire(
        self,
        key: str,
        ttl: int = 30,
        timeout: int = 10,
        renew_interval: float | None = None,
    ):
        """Context manager that holds lock for *key* or raises LockAcquisitionError."""
        lock_key = f"lock:{key}"
        token = str(uuid4())
        loop = asyncio.get_running_loop()
        started_at = monotonic()
        deadline = loop.time() + timeout
        resolved_renew_interval = (
            renew_interval if renew_interval is not None else max(1.0, ttl / 4)
        )

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
                stop_heartbeat = asyncio.Event()
                heartbeat_task = asyncio.create_task(
                    self._heartbeat(
                        lock_key=lock_key,
                        token=token,
                        ttl=ttl,
                        renew_interval=resolved_renew_interval,
                        stop_event=stop_heartbeat,
                    )
                )
                try:
                    yield lease
                finally:
                    stop_heartbeat.set()
                    try:
                        await heartbeat_task
                    finally:
                        await self._redis.eval(  # type: ignore[arg-type]
                            _UNLOCK_SCRIPT,
                            1,
                            lock_key,
                            token,
                        )
                    lease.released_at_monotonic = monotonic()
                return
            await asyncio.sleep(0.05)

        raise LockAcquisitionError(f"Timed out acquiring lock: {key}")

    async def _heartbeat(
        self,
        *,
        lock_key: str,
        token: str,
        ttl: int,
        renew_interval: float,
        stop_event: asyncio.Event,
    ) -> None:
        while True:
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=renew_interval)
                return
            except asyncio.TimeoutError:
                pass

            renewed = await self._redis.eval(  # type: ignore[arg-type]
                _RENEW_SCRIPT,
                1,
                lock_key,
                token,
                int(ttl),
            )
            if renewed == 1:
                continue

            logger.warning(
                "Redis lock heartbeat stopped after ownership changed for %s",
                lock_key,
            )
            return
