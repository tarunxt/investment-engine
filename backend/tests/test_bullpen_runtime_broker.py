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
from app.domains.polymarket.position_classification import (
    BULLPEN_POSITION_CLASSIFIER_VERSION,
)
from app.domains.polymarket import runtime_broker as runtime_broker_module
from app.domains.polymarket.runtime_broker import (
    BullpenCommandDiagnostics,
    BullpenCredentialArtifact,
    BullpenPositionsSnapshotMetadata,
    BullpenPositionsSnapshot,
    BullpenRawCommandResult,
    BullpenRuntimeBroker,
    BullpenRuntimeCommandError,
)
from app.infrastructure.locks.redis_lock import LockAcquisitionError, RedisLock

AUTH_READY_CACHE_KEY = "bullpen:runtime:auth:ready"
POSITIONS_SNAPSHOT_CACHE_KEY = "bullpen:runtime:positions:snapshot"


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

    async def delete(self, key: str):
        removed = key in self._values
        self._values.pop(key, None)
        return 1 if removed else 0

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


def _credential_artifact(
    *,
    path: str = "/home/investor/.bullpen/credentials.json.enc",
    inode: int = 11,
    mtime_ns: int = 22,
    size: int = 33,
) -> BullpenCredentialArtifact:
    return BullpenCredentialArtifact(
        path=path,
        inode=inode,
        mtime=mtime_ns / 1_000_000_000,
        mtime_ns=mtime_ns,
        size=size,
    )


def _build_snapshot(
    *,
    seconds_ago: int = 0,
    credential_artifact: BullpenCredentialArtifact | None = None,
    account_identity: str | None = "wallet-a",
    position_classifier_version: int = BULLPEN_POSITION_CLASSIFIER_VERSION,
) -> BullpenPositionsSnapshot:
    fetched_at = datetime.now(UTC).timestamp() - seconds_ago
    return BullpenPositionsSnapshot(
        payload={"positions": []},
        fetched_at=datetime.fromtimestamp(fetched_at, tz=UTC).isoformat(),
        cli_version="bullpen 0.1.115",
        credential_artifact=credential_artifact or _credential_artifact(),
        account_identity=account_identity,
        position_classifier_version=position_classifier_version,
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

    async def fake_ensure_auth_ready_under_lock(**kwargs):
        assert kwargs["force_refresh"] is False
        return "2026-07-19T12:00:00+00:00"

    async def fake_execute_raw_under_lock(*args, **kwargs):
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

    monkeypatch.setattr(
        broker,
        "ensure_auth_ready_under_lock",
        fake_ensure_auth_ready_under_lock,
    )
    monkeypatch.setattr(
        broker,
        "_execute_raw_under_lock",
        fake_execute_raw_under_lock,
    )

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
async def test_passive_health_polling_during_stage1_refresh_stays_cli_passive(monkeypatch):
    broker = _build_broker(monkeypatch)
    active_authenticated_commands = 0
    max_authenticated_commands = 0
    started = asyncio.Event()
    release = asyncio.Event()
    artifact = _credential_artifact()

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: artifact,
    )
    await broker._write_auth_ready_cache(
        cache_key=AUTH_READY_CACHE_KEY,
        checked_at="2026-07-19T12:00:00+00:00",
        credential_artifact=artifact,
    )

    async def fake_execute_process(args, **kwargs):
        nonlocal active_authenticated_commands, max_authenticated_commands
        if kwargs.get("requires_auth"):
            active_authenticated_commands += 1
            max_authenticated_commands = max(
                max_authenticated_commands,
                active_authenticated_commands,
            )
            started.set()
            await release.wait()
            active_authenticated_commands -= 1
        return _build_raw_result(
            json.dumps({"positions": []}),
            command_category=kwargs.get("command_category", "positions"),
        )

    monkeypatch.setattr(broker, "_execute_process", fake_execute_process)

    refresh_task = asyncio.create_task(broker.get_positions_snapshot(force_fresh=True))
    await started.wait()
    passive_health = await broker.read_passive_health()
    release.set()
    snapshot = await refresh_task

    assert passive_health.auth_checked_at == "2026-07-19T12:00:00+00:00"
    assert snapshot.payload == {"positions": []}
    assert max_authenticated_commands == 1


@pytest.mark.anyio
async def test_execute_raw_retries_once_after_auth_rejection_and_refresh(monkeypatch):
    broker = _build_broker(monkeypatch)
    execute_calls: list[tuple[list[str], bool]] = []
    refresh_calls = 0

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: _credential_artifact(),
    )
    await broker._redis.set(
        AUTH_READY_CACHE_KEY,
        json.dumps(
            {
                "checked_at": "2026-07-19T12:00:00+00:00",
                "credential_artifact": _credential_artifact().model_dump(mode="json"),
            }
        ),
        ex=60,
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
    assert await broker._redis.get(AUTH_READY_CACHE_KEY) is None
    assert refresh_calls == 1
    assert len(execute_calls) == 2
    assert execute_calls[0][1] is False
    assert execute_calls[1][1] is True


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("updated_inode", "updated_mtime_ns", "updated_size"),
    [
        (12, 22, 33),
        (11, 23, 33),
        (11, 22, 34),
    ],
)
async def test_ensure_auth_ready_refreshes_when_credentials_json_enc_metadata_changes(
    monkeypatch,
    updated_inode,
    updated_mtime_ns,
    updated_size,
):
    broker = _build_broker(monkeypatch)
    refresh_calls = 0
    artifacts = iter(
        [
            _credential_artifact(inode=11, mtime_ns=22, size=33),
            _credential_artifact(
                inode=updated_inode,
                mtime_ns=updated_mtime_ns,
                size=updated_size,
            ),
        ]
    )

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: next(artifacts),
    )

    async def fake_refresh_auth_under_lock(**kwargs):
        nonlocal refresh_calls
        refresh_calls += 1
        return "2026-07-19T12:02:00+00:00"

    monkeypatch.setattr(broker, "_refresh_auth_under_lock", fake_refresh_auth_under_lock)
    await broker._redis.set(
        AUTH_READY_CACHE_KEY,
        json.dumps(
            {
                "checked_at": "2026-07-19T12:00:00+00:00",
                "credential_artifact": _credential_artifact(
                    inode=11,
                    mtime_ns=22,
                    size=33,
                ).model_dump(mode="json"),
            }
        ),
        ex=60,
    )

    checked_at = await broker.ensure_auth_ready(force_refresh=False)

    assert checked_at == "2026-07-19T12:02:00+00:00"
    assert refresh_calls == 1


def test_credential_artifact_candidates_prioritize_encrypted_credentials(monkeypatch):
    monkeypatch.setenv("BULLPEN_HOME", "/home/investor/.bullpen")
    monkeypatch.setenv("BULLPEN_AUTH_FILE", "/tmp/explicit-auth.json")

    config = runtime_broker_module._runtime_config()
    candidates = [str(candidate) for candidate in runtime_broker_module._credential_artifact_candidates(config)]

    assert candidates == [
        "/home/investor/.bullpen/credentials.json.enc",
        "/home/investor/.bullpen/credentials.json",
        "/tmp/explicit-auth.json",
        "/home/investor/.bullpen",
    ]


@pytest.mark.anyio
async def test_execute_raw_caps_auth_retry_at_one_attempt(monkeypatch):
    broker = _build_broker(monkeypatch)
    execute_calls = 0
    refresh_calls = 0

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: _credential_artifact(),
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
async def test_authenticated_commands_share_one_global_cli_lock_across_brokers(
    monkeypatch,
):
    redis = FakeRedis()
    broker_one = _build_broker(monkeypatch, redis)
    broker_two = _build_broker(monkeypatch, redis)
    active_authenticated_commands = 0
    max_authenticated_commands = 0
    first_started = asyncio.Event()
    release = asyncio.Event()
    artifact = _credential_artifact()

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: artifact,
    )
    await broker_one._write_auth_ready_cache(
        cache_key=AUTH_READY_CACHE_KEY,
        checked_at="2026-07-19T12:00:00+00:00",
        credential_artifact=artifact,
    )

    async def fake_execute_process(args, **kwargs):
        nonlocal active_authenticated_commands, max_authenticated_commands
        if kwargs.get("requires_auth"):
            active_authenticated_commands += 1
            max_authenticated_commands = max(
                max_authenticated_commands,
                active_authenticated_commands,
            )
            if not first_started.is_set():
                first_started.set()
                await release.wait()
            active_authenticated_commands -= 1
        return _build_raw_result(
            json.dumps({"positions": []}),
            command_category=kwargs.get("command_category", "positions"),
            auth_refresh_attempted=bool(kwargs.get("auth_refresh_attempted")),
        )

    monkeypatch.setattr(broker_one, "_execute_process", fake_execute_process)
    monkeypatch.setattr(broker_two, "_execute_process", fake_execute_process)

    first = asyncio.create_task(
        broker_one.execute_raw(["polymarket", "positions", "--output", "json"])
    )
    await first_started.wait()
    second = asyncio.create_task(
        broker_two.execute_raw(["polymarket", "positions", "--output", "json"])
    )
    await asyncio.sleep(0.1)

    assert max_authenticated_commands == 1
    assert second.done() is False

    release.set()
    await asyncio.gather(first, second)

    assert max_authenticated_commands == 1


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
async def test_positions_refresh_force_fresh_rejects_stale_waited_snapshot_after_lock_timeout(
    monkeypatch,
):
    broker = _build_broker(monkeypatch)
    waited_snapshot = _build_snapshot(seconds_ago=120)

    @asynccontextmanager
    async def fake_acquire(*args, **kwargs):
        raise LockAcquisitionError("lock busy")
        yield

    async def fake_poll_for_positions_snapshot(**kwargs):
        return waited_snapshot

    monkeypatch.setattr(broker._lock, "acquire", fake_acquire)
    monkeypatch.setattr(
        broker,
        "_poll_for_positions_snapshot",
        fake_poll_for_positions_snapshot,
    )

    with pytest.raises(BullpenRuntimeCommandError) as exc_info:
        await broker.get_positions_snapshot(force_fresh=True, max_age_seconds=1)

    assert exc_info.value.classification == "lock_timeout"


@pytest.mark.anyio
async def test_read_cached_positions_snapshot_invalidates_when_classifier_version_changes(
    monkeypatch,
):
    broker = _build_broker(monkeypatch)
    artifact = _credential_artifact()
    snapshot = _build_snapshot(
        credential_artifact=artifact,
        position_classifier_version=BULLPEN_POSITION_CLASSIFIER_VERSION - 1,
    )

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: artifact,
    )
    await broker._redis.set(
        POSITIONS_SNAPSHOT_CACHE_KEY,
        snapshot.model_dump_json(),
        ex=60,
    )

    cached = await broker.read_cached_positions_snapshot()

    assert cached is None
    assert await broker._redis.get(POSITIONS_SNAPSHOT_CACHE_KEY) is None


@pytest.mark.anyio
async def test_read_cached_positions_snapshot_invalidates_when_account_identity_changes(
    monkeypatch,
):
    broker = _build_broker(monkeypatch)
    artifact = _credential_artifact()
    snapshot = _build_snapshot(
        credential_artifact=artifact,
        account_identity="wallet-a",
    )

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: artifact,
    )
    await broker._write_auth_ready_cache(
        cache_key=AUTH_READY_CACHE_KEY,
        checked_at="2026-07-19T12:00:00+00:00",
        credential_artifact=artifact,
        account_identity="wallet-b",
    )
    await broker._redis.set(
        POSITIONS_SNAPSHOT_CACHE_KEY,
        snapshot.model_dump_json(),
        ex=60,
    )

    cached = await broker.read_cached_positions_snapshot()

    assert cached is None
    assert await broker._redis.get(POSITIONS_SNAPSHOT_CACHE_KEY) is None


@pytest.mark.anyio
async def test_read_cached_positions_snapshot_invalidates_when_credential_artifact_changes(
    monkeypatch,
):
    broker = _build_broker(monkeypatch)
    snapshot_artifact = _credential_artifact(inode=11, mtime_ns=22, size=33)
    current_artifact = _credential_artifact(inode=12, mtime_ns=22, size=33)
    snapshot = _build_snapshot(credential_artifact=snapshot_artifact)

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: current_artifact,
    )
    await broker._redis.set(
        POSITIONS_SNAPSHOT_CACHE_KEY,
        snapshot.model_dump_json(),
        ex=60,
    )

    cached = await broker.read_cached_positions_snapshot()

    assert cached is None
    assert await broker._redis.get(POSITIONS_SNAPSHOT_CACHE_KEY) is None


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
