import asyncio
import time

import pytest

from app.infrastructure.locks.redis_lock import LockAcquisitionError, RedisLock


class FakeRedis:
    def __init__(self) -> None:
        self._values: dict[str, tuple[str, float | None]] = {}

    async def get(self, key: str):
        record = self._values.get(key)
        if not record:
            return None
        value, expires_at = record
        if expires_at is not None and time.time() >= expires_at:
            self._values.pop(key, None)
            return None
        return value

    async def set(self, key: str, value: str, ex: int | None = None, nx: bool = False):
        existing = await self.get(key)
        if nx and existing is not None:
            return None
        expires_at = time.time() + ex if ex else None
        self._values[key] = (value, expires_at)
        return True

    async def eval(self, _script: str, _numkeys: int, key: str, token: str, *args):
        existing = await self.get(key)
        if existing != token:
            return 0
        if args:
            ttl = int(args[0])
            self._values[key] = (token, time.time() + ttl)
            return 1
        self._values.pop(key, None)
        return 1


@pytest.mark.anyio
async def test_lock_heartbeat_prevents_expiry_during_long_command():
    redis = FakeRedis()
    lock = RedisLock(redis)
    release = asyncio.Event()
    acquired = asyncio.Event()

    async def hold_lock():
        async with lock.acquire("bullpen:runtime:authenticated-cli", ttl=1, timeout=1, renew_interval=0.1):
            acquired.set()
            await release.wait()

    holder = asyncio.create_task(hold_lock())
    await acquired.wait()
    await asyncio.sleep(1.05)

    with pytest.raises(LockAcquisitionError):
        async with lock.acquire(
            "bullpen:runtime:authenticated-cli",
            ttl=1,
            timeout=0.2,
            renew_interval=0.1,
        ):
            raise AssertionError("Heartbeat should keep the original lease active.")

    release.set()
    await holder


@pytest.mark.anyio
async def test_lock_release_does_not_delete_a_new_owner_token():
    redis = FakeRedis()
    lock = RedisLock(redis)
    preserved_value: str | None = None

    async with lock.acquire("bullpen:runtime:authenticated-cli", ttl=5, timeout=1, renew_interval=0.1) as lease:
        await redis.set(lease.lock_key, "different-owner", ex=5)
        preserved_value = await redis.get(lease.lock_key)

    assert preserved_value == "different-owner"
    assert await redis.get("lock:bullpen:runtime:authenticated-cli") == "different-owner"
