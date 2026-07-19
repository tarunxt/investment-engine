import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.polymarket import bullpen as bullpen_module
from app.domains.polymarket import runtime_broker as runtime_broker_module
from app.domains.polymarket.runtime_broker import (
    BullpenCommandDiagnostics,
    BullpenCredentialArtifact,
    BullpenPositionsSnapshot,
    BullpenRawCommandResult,
    BullpenRuntimeBroker,
    BullpenRuntimeCommandError,
)
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

    async def eval(self, _script: str, _numkeys: int, key: str, token: str):
        existing = await self.get(key)
        if existing != token:
            return 0
        self._values.pop(key, None)
        return 1

    async def aclose(self):
        return None


def _build_broker(
    monkeypatch: pytest.MonkeyPatch,
    fake_redis: FakeRedis | None = None,
) -> BullpenRuntimeBroker:
    redis = fake_redis or FakeRedis()
    monkeypatch.setattr(runtime_broker_module.aioredis, "from_url", lambda *args, **kwargs: redis)
    broker = BullpenRuntimeBroker()
    broker._redis = redis
    broker._lock = RedisLock(redis)
    return broker


def _build_raw_result(
    stdout: str,
    *,
    command_category: str = "positions",
    auth_refresh_attempted: bool = False,
) -> BullpenRawCommandResult:
    return BullpenRawCommandResult(
        stdout=stdout,
        diagnostics=BullpenCommandDiagnostics(
            command_category=command_category,
            pid=1234,
            unix_user="investor",
            effective_home="/home/investor",
            auth_refresh_attempted=auth_refresh_attempted,
        ),
    )


def _build_snapshot(*, seconds_ago: int = 0) -> BullpenPositionsSnapshot:
    fetched_at = datetime.now(UTC).timestamp() - seconds_ago
    return BullpenPositionsSnapshot(
        payload={"positions": []},
        fetched_at=datetime.fromtimestamp(fetched_at, tz=UTC).isoformat(),
        cli_version="bullpen 0.1.115",
        auth_checked_at="2026-07-19T12:00:00+00:00",
        source="live-cli",
        freshness_state="fresh",
        diagnostics=BullpenCommandDiagnostics(
            command_category="positions",
            pid=1234,
            unix_user="investor",
            effective_home="/home/investor",
        ),
    )


@pytest.mark.anyio
async def test_positions_refresh_singleflight_shares_one_cli_execution(monkeypatch):
    broker = _build_broker(monkeypatch)
    calls = 0
    started = asyncio.Event()
    release = asyncio.Event()

    async def fake_ensure_auth_ready(*, force_refresh: bool = False):
        assert force_refresh is False
        return "2026-07-19T12:00:00+00:00"

    async def fake_cli_version():
        return "bullpen 0.1.115"

    async def fake_execute_raw(*args, **kwargs):
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return _build_raw_result(
            json.dumps(
                {
                    "positions": [
                        {
                            "slug": "shared-wallet-position",
                            "market": "Shared wallet position",
                            "outcome": "No",
                            "shares": 3,
                            "avg_price": 0.41,
                            "current_price": 0.39,
                            "invested_usd": 1.23,
                        }
                    ]
                }
            )
        )

    monkeypatch.setattr(broker, "ensure_auth_ready", fake_ensure_auth_ready)
    monkeypatch.setattr(broker, "cli_version", fake_cli_version)
    monkeypatch.setattr(broker, "execute_raw", fake_execute_raw)

    first = asyncio.create_task(broker.get_positions_snapshot(force_fresh=True))
    await started.wait()
    second = asyncio.create_task(broker.get_positions_snapshot(force_fresh=True))
    await asyncio.sleep(0)
    release.set()

    first_snapshot, second_snapshot = await asyncio.gather(first, second)

    assert calls == 1
    assert first_snapshot.payload == second_snapshot.payload
    assert first_snapshot.diagnostics.cache_status == "miss"


@pytest.mark.anyio
async def test_execute_raw_retries_once_after_auth_rejection_and_refresh(monkeypatch):
    broker = _build_broker(monkeypatch)
    execute_calls: list[tuple[list[str], bool]] = []
    refresh_calls = 0

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: BullpenCredentialArtifact(
            path="/home/investor/.bullpen/config.toml",
            inode=11,
            mtime=22.0,
        ),
    )

    async def fake_execute_process(args, **kwargs):
        execute_calls.append((list(args), kwargs.get("auth_refresh_attempted", False)))
        if len(execute_calls) == 1:
            raise BullpenRuntimeCommandError(
                "AUTH_REFRESH_REJECTED_LOGIN_REQUIRED",
                classification="auth_rejected",
            )
        return _build_raw_result(json.dumps({"positions": []}), auth_refresh_attempted=True)

    async def fake_refresh_auth_under_lock(**kwargs):
        nonlocal refresh_calls
        refresh_calls += 1
        return "2026-07-19T12:01:00+00:00"

    monkeypatch.setattr(broker, "_execute_process", fake_execute_process)
    monkeypatch.setattr(broker, "_refresh_auth_under_lock", fake_refresh_auth_under_lock)

    result = await broker.execute_raw(["polymarket", "positions", "--output", "json"])

    assert result.stdout == '{"positions": []}'
    assert refresh_calls == 1
    assert len(execute_calls) == 2
    assert execute_calls[0][1] is False
    assert execute_calls[1][1] is True


@pytest.mark.anyio
async def test_execute_raw_rereads_rotated_credentials_before_retry(monkeypatch):
    broker = _build_broker(monkeypatch)
    execute_calls = 0
    refresh_calls = 0
    artifacts = iter(
        [
            BullpenCredentialArtifact(
                path="/home/investor/.bullpen/config.toml",
                inode=11,
                mtime=22.0,
            ),
            BullpenCredentialArtifact(
                path="/home/investor/.bullpen/config.toml",
                inode=12,
                mtime=23.0,
            ),
        ]
    )

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: next(artifacts),
    )

    async def fake_execute_process(args, **kwargs):
        nonlocal execute_calls
        execute_calls += 1
        if execute_calls == 1:
            raise BullpenRuntimeCommandError(
                "AUTH_REFRESH_REJECTED_LOGIN_REQUIRED",
                classification="auth_rejected",
            )
        return _build_raw_result(json.dumps({"positions": []}))

    async def fake_refresh_auth_under_lock(**kwargs):
        nonlocal refresh_calls
        refresh_calls += 1
        return "2026-07-19T12:02:00+00:00"

    monkeypatch.setattr(broker, "_execute_process", fake_execute_process)
    monkeypatch.setattr(broker, "_refresh_auth_under_lock", fake_refresh_auth_under_lock)

    result = await broker.execute_raw(["polymarket", "positions", "--output", "json"])

    assert result.stdout == '{"positions": []}'
    assert execute_calls == 2
    assert refresh_calls == 0


@pytest.mark.anyio
async def test_execute_raw_caps_auth_retry_at_one_attempt(monkeypatch):
    broker = _build_broker(monkeypatch)
    execute_calls = 0
    refresh_calls = 0

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: BullpenCredentialArtifact(
            path="/home/investor/.bullpen/config.toml",
            inode=11,
            mtime=22.0,
        ),
    )

    async def fake_execute_process(args, **kwargs):
        nonlocal execute_calls
        execute_calls += 1
        raise BullpenRuntimeCommandError(
            "AUTH_REFRESH_REJECTED_LOGIN_REQUIRED",
            classification="auth_rejected",
        )

    async def fake_refresh_auth_under_lock(**kwargs):
        nonlocal refresh_calls
        refresh_calls += 1
        return "2026-07-19T12:03:00+00:00"

    monkeypatch.setattr(broker, "_execute_process", fake_execute_process)
    monkeypatch.setattr(broker, "_refresh_auth_under_lock", fake_refresh_auth_under_lock)

    with pytest.raises(BullpenRuntimeCommandError) as exc_info:
        await broker.execute_raw(["polymarket", "positions", "--output", "json"])

    assert exc_info.value.classification == "auth_rejected"
    assert execute_calls == 2
    assert refresh_calls == 1


@pytest.mark.anyio
async def test_positions_refresh_uses_waited_snapshot_after_lock_timeout(monkeypatch):
    broker = _build_broker(monkeypatch)
    waited_snapshot = _build_snapshot()

    @asynccontextmanager
    async def fake_acquire(*args, **kwargs):
        raise LockAcquisitionError("lock busy")
        yield

    async def fake_poll_for_positions_snapshot(**kwargs):
        return waited_snapshot

    monkeypatch.setattr(broker._lock, "acquire", fake_acquire)
    monkeypatch.setattr(broker, "_poll_for_positions_snapshot", fake_poll_for_positions_snapshot)

    snapshot = await broker.get_positions_snapshot(force_fresh=True)

    assert snapshot.source == "redis-cache"
    assert snapshot.freshness_state == "cached"
    assert snapshot.diagnostics.cache_status == "hit"


@pytest.mark.anyio
async def test_doctor_rejects_passive_status_when_active_auth_refresh_fails(monkeypatch):
    class FakeBroker:
        async def ensure_auth_ready(self, *, force_refresh: bool = False):
            assert force_refresh is False
            raise RuntimeError("AUTH_REFRESH_REJECTED_LOGIN_REQUIRED")

    async def fake_run_bullpen(
        args,
        *,
        timeout_seconds: int,
        read_only: bool,
        extra_env=None,
    ):
        assert timeout_seconds == 15
        assert read_only is True
        assert args == ["status"]
        return (
            "JWT observed: 2026-07-19 12:00:00 UTC\n"
            "JWT expires: 2026-07-20 12:00:00 UTC\n"
        )

    monkeypatch.setattr(bullpen_module, "get_bullpen_runtime_broker", lambda: FakeBroker())
    monkeypatch.setattr(bullpen_module, "run_bullpen", fake_run_bullpen)

    status = await bullpen_module.BullpenLiveExecutor().doctor()

    assert status.ok is False
    assert "Bullpen doctor failed" in status.message
    assert status.bullpen_jwt_expires_at == "2026-07-20T12:00:00+00:00"
