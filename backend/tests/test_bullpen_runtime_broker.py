import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

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
    BullpenRuntimeActiveAuthResult,
    BullpenRuntimeBroker,
    BullpenRuntimeCommandError,
)
from app.infrastructure.locks.redis_lock import LockAcquisitionError, RedisLock

AUTH_READY_CACHE_KEY = "bullpen:runtime:auth:ready"
ACTIVE_AUTH_RESULT_KEY = "bullpen:runtime:auth:latest-active"
POSITIONS_SNAPSHOT_CACHE_KEY = "bullpen:runtime:positions:snapshot"
POSITIONS_DISPLAY_LKG_KEY = "bullpen:runtime:positions:display-lkg"


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

    async def ttl(self, key: str):
        record = self._values.get(key)
        if not record:
            return -2
        _, expires_at = record
        if expires_at is None:
            return -1
        remaining = expires_at - time.time()
        if remaining <= 0:
            self._values.pop(key, None)
            return -2
        return max(0, int(remaining))

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


class LoopBoundRedis(FakeRedis):
    def __init__(self) -> None:
        super().__init__()
        self._owner_loop: asyncio.AbstractEventLoop | None = None

    def _assert_current_loop(self) -> None:
        loop = asyncio.get_running_loop()
        if self._owner_loop is None:
            self._owner_loop = loop
            return
        if self._owner_loop is not loop:
            raise RuntimeError("Event loop is closed")

    async def get(self, key: str):
        self._assert_current_loop()
        return await super().get(key)

    async def set(self, key: str, value: str, ex: int | None = None, nx: bool = False):
        self._assert_current_loop()
        return await super().set(key, value, ex=ex, nx=nx)

    async def delete(self, key: str):
        self._assert_current_loop()
        return await super().delete(key)

    async def ttl(self, key: str):
        self._assert_current_loop()
        return await super().ttl(key)

    async def eval(self, _script: str, _numkeys: int, key: str, token: str, *args):
        self._assert_current_loop()
        return await super().eval(_script, _numkeys, key, token, *args)

    async def aclose(self):
        self._assert_current_loop()
        return await super().aclose()


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


def test_get_broker_recreates_async_singleton_for_new_event_loop(monkeypatch):
    created_redis: list[LoopBoundRedis] = []

    def fake_from_url(*args, **kwargs):
        redis = LoopBoundRedis()
        created_redis.append(redis)
        return redis

    monkeypatch.setattr(runtime_broker_module.aioredis, "from_url", fake_from_url)
    monkeypatch.setattr(runtime_broker_module, "_runtime_broker", None)
    monkeypatch.setattr(runtime_broker_module, "_runtime_broker_loop", None)

    async def touch_broker() -> tuple[int, None]:
        broker = runtime_broker_module.get_bullpen_runtime_broker()
        snapshot = await broker.read_cached_positions_snapshot()
        return id(broker), snapshot

    first_broker_id, first_snapshot = asyncio.run(touch_broker())
    second_broker_id, second_snapshot = asyncio.run(touch_broker())

    assert first_snapshot is None
    assert second_snapshot is None
    assert first_broker_id != second_broker_id
    assert len(created_redis) == 2


def test_run_with_bullpen_runtime_cleanup_resets_global_broker(monkeypatch):
    created_redis: list[LoopBoundRedis] = []
    disposed_on_loops: list[asyncio.AbstractEventLoop] = []

    def fake_from_url(*args, **kwargs):
        redis = LoopBoundRedis()
        created_redis.append(redis)
        return redis

    class FakeAsyncEngine:
        async def dispose(self) -> None:
            disposed_on_loops.append(asyncio.get_running_loop())

    monkeypatch.setattr(runtime_broker_module.aioredis, "from_url", fake_from_url)
    monkeypatch.setattr(runtime_broker_module, "async_engine", FakeAsyncEngine())
    monkeypatch.setattr(runtime_broker_module, "_runtime_broker", None)
    monkeypatch.setattr(runtime_broker_module, "_runtime_broker_loop", None)

    async def touch_broker() -> int:
        broker = runtime_broker_module.get_bullpen_runtime_broker()
        await broker.read_cached_positions_snapshot()
        return id(broker)

    first_broker_id = runtime_broker_module.run_with_bullpen_runtime_cleanup(
        touch_broker()
    )
    assert runtime_broker_module._runtime_broker is None
    assert runtime_broker_module._runtime_broker_loop is None

    second_broker_id = runtime_broker_module.run_with_bullpen_runtime_cleanup(
        touch_broker()
    )

    assert first_broker_id != second_broker_id
    assert len(created_redis) == 2
    assert len(disposed_on_loops) == 2
    assert disposed_on_loops[0] is not disposed_on_loops[1]
    assert all(loop.is_closed() for loop in disposed_on_loops)


def _build_raw_result(
    stdout: str,
    *,
    command_category: str = "positions",
    auth_refresh_attempted: bool = False,
    credential_artifact: BullpenCredentialArtifact | None = None,
) -> BullpenRawCommandResult:
    return BullpenRawCommandResult(
        stdout=stdout,
        diagnostics=BullpenCommandDiagnostics(
            command_category=command_category,
            pid=1234,
            unix_user="investor",
            effective_home="/home/investor",
            auth_refresh_attempted=auth_refresh_attempted,
            credential_artifact=credential_artifact or BullpenCredentialArtifact(),
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
async def test_execute_process_records_post_command_credential_artifact(monkeypatch):
    broker = _build_broker(monkeypatch)
    before = _credential_artifact(inode=11, mtime_ns=22, size=33)
    after = _credential_artifact(inode=12, mtime_ns=23, size=34)
    artifacts = iter((before, after))

    class CompletedProcess:
        pid = 4321
        returncode = 0
        stdout = None
        stderr = None

        async def communicate(self):
            return b'{"positions":[]}', b""

    async def fake_create_subprocess_exec(*_args, **_kwargs):
        return CompletedProcess()

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: next(artifacts),
    )
    monkeypatch.setattr(
        runtime_broker_module.asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    result = await broker._execute_process(
        ["polymarket", "positions", "--output", "json"],
        timeout_seconds=5,
        command_category="positions",
        is_write=False,
        requires_auth=True,
    )

    assert result.diagnostics.credential_artifact == after
    assert broker._last_health.credential_artifact == after


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
async def test_positions_refresh_rebinds_auth_lineage_and_persists_display_lkg(
    monkeypatch,
):
    broker = _build_broker(monkeypatch)
    before = _credential_artifact(inode=11, mtime_ns=22, size=33)
    after = _credential_artifact(inode=12, mtime_ns=23, size=34)
    checked_at = "2026-07-19T12:00:00+00:00"

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: after,
    )
    await broker._write_auth_ready_cache(
        cache_key=AUTH_READY_CACHE_KEY,
        checked_at=checked_at,
        credential_artifact=before,
        account_identity="0xwallet-a",
    )
    await broker._write_active_auth_result(
        BullpenRuntimeActiveAuthResult(
            checked_at="2026-07-19T12:00:01+00:00",
            auth_checked_at=checked_at,
            healthy=True,
            login_required=False,
            doctor_refresh_succeeded=True,
            account_identity="0xwallet-a",
            credential_artifact=before,
        )
    )

    async def fake_ensure_auth_ready_under_lock(**_kwargs):
        return checked_at

    async def fake_execute_raw_under_lock(*_args, **_kwargs):
        return _build_raw_result(
            json.dumps(
                {
                    "wallet_address": "0xWallet-A",
                    "positions": [{"slug": "live-position", "shares": 2}],
                }
            ),
            credential_artifact=after,
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

    snapshot = await broker.get_positions_snapshot(
        force_fresh=True,
        caller_source="stage1-console-profile",
    )
    rebound = await broker._read_auth_ready_cache(AUTH_READY_CACHE_KEY)

    assert rebound is not None
    assert rebound.checked_at == checked_at
    assert rebound.credential_artifact == after
    assert rebound.account_identity == "0xwallet-a"
    assert snapshot.credential_artifact == after
    assert snapshot.account_identity == "0xwallet-a"
    assert await broker._redis.get(POSITIONS_DISPLAY_LKG_KEY) is not None
    assert await broker._redis.ttl(POSITIONS_DISPLAY_LKG_KEY) > 23 * 60 * 60
    active_auth = await broker.read_latest_active_auth_result()
    assert active_auth is not None
    assert active_auth.account_identity == "0xwallet-a"
    assert active_auth.credential_artifact == after


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
async def test_historical_auth_rejection_is_stale_after_healthy_active_doctor_refresh(
    monkeypatch,
):
    broker = _build_broker(monkeypatch)
    artifact = _credential_artifact()
    payloads = iter(
        [
            {
                "credentials_valid": False,
                "refresh_succeeded": False,
                "token_valid": False,
                "trade_auth_blocked": True,
                "requires_login": True,
                "wallet_ready": False,
            },
            {
                "credentials_valid": True,
                "refresh_succeeded": True,
                "token_valid": True,
                "trade_auth_blocked": False,
                "requires_login": False,
                "wallet_ready": True,
            },
        ]
    )

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: artifact,
    )

    async def fake_execute_process(_args, **_kwargs):
        return _build_raw_result(
            json.dumps(next(payloads)),
            command_category="doctor-auth-refresh",
            auth_refresh_attempted=True,
            credential_artifact=artifact,
        )

    monkeypatch.setattr(broker, "_execute_process", fake_execute_process)

    with pytest.raises(BullpenRuntimeCommandError):
        await broker.ensure_auth_ready(force_refresh=True)

    rejected = await broker.read_latest_active_auth_result()
    assert rejected is not None
    assert rejected.login_required is True
    assert rejected.healthy is False

    await broker.ensure_auth_ready(force_refresh=True)
    recovered = await broker.read_latest_active_auth_result()

    assert recovered is not None
    assert recovered.healthy is True
    assert recovered.login_required is False
    assert recovered.credentials_valid is True
    assert recovered.refresh_succeeded is True
    assert recovered.token_valid is True
    assert recovered.trade_auth_blocked is False
    assert recovered.wallet_ready is True
    assert recovered.recovered_failure_at == rejected.checked_at
    assert recovered.historical_error_stale is True
    assert await broker._redis.get(ACTIVE_AUTH_RESULT_KEY) is not None
    passive_health = await broker.read_passive_health()
    assert passive_health.ok is False
    assert passive_health.broker_health.error_classification == "passive_cache_miss"
    assert passive_health.last_failure is not None
    assert passive_health.last_failure.stale is True
    assert passive_health.last_failure.recovered_at == recovered.checked_at


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
async def test_positions_refresh_uses_waited_snapshot_from_another_refresh(
    monkeypatch,
):
    broker = _build_broker(monkeypatch)
    waited_snapshot = _build_snapshot()
    waited_snapshot.diagnostics.caller_source = "stage1-owner"

    @asynccontextmanager
    async def fake_acquire(*args, **kwargs):
        raise LockAcquisitionError("lock busy")
        yield

    async def fake_poll_for_positions_snapshot(**kwargs):
        published_snapshot = waited_snapshot.model_copy(
            update={
                "fetched_at": (
                    datetime.fromisoformat(kwargs["refresh_requested_at"])
                    + timedelta(milliseconds=1)
                ).isoformat()
            }
        )
        published_snapshot.diagnostics.caller_source = "stage1-owner"
        return runtime_broker_module._PositionsRefreshWaitOutcome(
            snapshot=published_snapshot,
            lock_state=runtime_broker_module._PositionsRefreshLockState(
                lock_key="lock:bullpen:runtime:positions-refresh",
                token="owner-token",
                ttl_seconds=90,
                age_ms=1500.0,
                caller_source="stage1-owner",
                refresh_requested_at=kwargs["refresh_requested_at"],
            ),
            waited_ms=1250.0,
        )

    monkeypatch.setattr(broker._lock, "acquire", fake_acquire)
    monkeypatch.setattr(broker, "_poll_for_positions_snapshot", fake_poll_for_positions_snapshot)

    snapshot = await broker.get_positions_snapshot(
        force_fresh=True,
        caller_source="stage1-waiter",
    )

    assert snapshot.source == "redis-cache"
    assert snapshot.freshness_state == "fresh"
    assert snapshot.diagnostics.cache_status == "hit"
    assert snapshot.diagnostics.caller_source == "stage1-waiter"
    assert snapshot.diagnostics.snapshot_producer_source == "stage1-owner"
    assert snapshot.diagnostics.produced_by_another_refresh is True
    assert snapshot.diagnostics.refresh_lock_key == "lock:bullpen:runtime:positions-refresh"
    assert snapshot.diagnostics.refresh_lock_wait_ms == 1250.0


@pytest.mark.anyio
async def test_poll_for_positions_snapshot_rejects_stale_snapshot_for_force_fresh_waiter(
    monkeypatch,
):
    broker = _build_broker(monkeypatch)
    artifact = _credential_artifact()
    waited_snapshot = _build_snapshot(
        seconds_ago=120,
        credential_artifact=artifact,
    )

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: artifact,
    )
    await broker._redis.set(
        POSITIONS_SNAPSHOT_CACHE_KEY,
        waited_snapshot.model_dump_json(),
        ex=300,
    )

    outcome = await broker._poll_for_positions_snapshot(
        cache_key=POSITIONS_SNAPSHOT_CACHE_KEY,
        force_fresh=True,
        max_age_seconds=1,
        timeout_seconds=0.05,
        refresh_requested_at=datetime.now(UTC).isoformat(),
    )

    assert outcome.snapshot is None


@pytest.mark.anyio
async def test_cli_timeout_does_not_wait_forever_for_descendant_pipes(monkeypatch):
    broker = _build_broker(monkeypatch)

    class HangingProcess:
        pid = 987654
        stdout = None
        stderr = None

        def __init__(self):
            self.killed = False

        async def communicate(self):
            await asyncio.Event().wait()

        async def wait(self):
            return -9

        def kill(self):
            self.killed = True

    process = HangingProcess()

    async def fake_create_subprocess_exec(*_args, **_kwargs):
        return process

    monkeypatch.setattr(
        runtime_broker_module.asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )
    monkeypatch.setattr(
        runtime_broker_module.os,
        "killpg",
        lambda *_args: (_ for _ in ()).throw(ProcessLookupError()),
    )

    with pytest.raises(BullpenRuntimeCommandError, match="timed out"):
        await asyncio.wait_for(
            broker._execute_process(
                ["polymarket", "discover"],
                timeout_seconds=0.01,
                command_category="discover",
                is_write=False,
                requires_auth=True,
            ),
            timeout=1,
        )

    assert process.killed is True


@pytest.mark.anyio
async def test_passive_ui_poll_waits_for_stage1_refresh_without_starting_second_cli(
    monkeypatch,
):
    redis = FakeRedis()
    broker_stage1 = _build_broker(monkeypatch, redis)
    broker_ui = _build_broker(monkeypatch, redis)
    artifact = _credential_artifact()
    calls = 0
    started = asyncio.Event()
    release = asyncio.Event()

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: artifact,
    )
    monkeypatch.setattr(runtime_broker_module, "_POLL_INTERVAL_SECONDS", 0.01)

    async def fake_ensure_auth_ready_under_lock(**kwargs):
        return "2026-07-19T12:00:00+00:00"

    async def fake_execute_raw_under_lock(*args, **kwargs):
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return _build_raw_result(
            json.dumps({"positions": []}),
            credential_artifact=artifact,
        )

    for broker in (broker_stage1, broker_ui):
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

    stage1_task = asyncio.create_task(
        broker_stage1.get_positions_snapshot(
            force_fresh=True,
            caller_source="stage1-console-profile",
        )
    )
    await started.wait()
    ui_task = asyncio.create_task(
        broker_ui.get_positions_snapshot(
            allow_refresh=False,
            caller_source="ui-interval-poll",
        )
    )
    await asyncio.sleep(0.05)

    assert calls == 1

    release.set()
    stage1_snapshot, ui_snapshot = await asyncio.gather(stage1_task, ui_task)

    assert stage1_snapshot.source == "live-cli"
    assert ui_snapshot.source == "redis-cache"
    assert ui_snapshot.diagnostics.caller_source == "ui-interval-poll"
    assert (
        ui_snapshot.diagnostics.snapshot_producer_source
        == "stage1-console-profile"
    )
    assert ui_snapshot.diagnostics.produced_by_another_refresh is True
    assert calls == 1


@pytest.mark.anyio
async def test_cross_broker_force_fresh_callers_share_one_cli_execution(
    monkeypatch,
):
    redis = FakeRedis()
    broker_one = _build_broker(monkeypatch, redis)
    broker_two = _build_broker(monkeypatch, redis)
    artifact = _credential_artifact()
    calls = 0
    started = asyncio.Event()
    release = asyncio.Event()

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: artifact,
    )
    monkeypatch.setattr(runtime_broker_module, "_POLL_INTERVAL_SECONDS", 0.01)

    async def fake_ensure_auth_ready_under_lock(**kwargs):
        return "2026-07-19T12:00:00+00:00"

    async def fake_execute_raw_under_lock(*args, **kwargs):
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return _build_raw_result(
            json.dumps({"positions": []}),
            credential_artifact=artifact,
        )

    for broker in (broker_one, broker_two):
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

    first = asyncio.create_task(
        broker_one.get_positions_snapshot(
            force_fresh=True,
            caller_source="force-fresh-owner",
        )
    )
    await started.wait()
    second = asyncio.create_task(
        broker_two.get_positions_snapshot(
            force_fresh=True,
            caller_source="force-fresh-waiter",
        )
    )
    await asyncio.sleep(0.05)

    assert calls == 1

    release.set()
    first_snapshot, second_snapshot = await asyncio.gather(first, second)

    assert first_snapshot.source == "live-cli"
    assert second_snapshot.source == "redis-cache"
    assert second_snapshot.freshness_state == "fresh"
    assert second_snapshot.diagnostics.caller_source == "force-fresh-waiter"
    assert (
        second_snapshot.diagnostics.snapshot_producer_source
        == "force-fresh-owner"
    )
    assert second_snapshot.diagnostics.produced_by_another_refresh is True
    assert calls == 1


@pytest.mark.anyio
async def test_stage1_force_fresh_survives_other_refresh_with_30s_auth_lock_wait(
    monkeypatch,
):
    redis = FakeRedis()
    broker_owner = _build_broker(monkeypatch, redis)
    broker_stage1 = _build_broker(monkeypatch, redis)
    artifact = _credential_artifact()
    started = asyncio.Event()
    release = asyncio.Event()

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: artifact,
    )
    monkeypatch.setattr(runtime_broker_module, "_POLL_INTERVAL_SECONDS", 0.01)

    async def fake_ensure_auth_ready_under_lock(**kwargs):
        return "2026-07-19T12:00:00+00:00"

    async def fake_execute_raw_under_lock(*args, **kwargs):
        started.set()
        await release.wait()
        result = _build_raw_result(
            json.dumps({"positions": []}),
            credential_artifact=artifact,
        )
        result.diagnostics.lock_wait_ms = kwargs.get("lock_wait_ms")
        return result

    def _wrap_lock_acquire(original_acquire):
        def wrapped_acquire(key, ttl=30, timeout=10, renew_interval=None):
            if key == runtime_broker_module._AUTHENTICATED_CLI_LOCK_KEY:
                @asynccontextmanager
                async def fake_auth_lease():
                    yield SimpleNamespace(
                        lock_key=f"lock:{key}",
                        wait_duration_seconds=30.0,
                        hold_duration_seconds=0.0,
                        ttl_seconds=ttl,
                        token="auth-token",
                    )

                return fake_auth_lease()
            return original_acquire(
                key,
                ttl=ttl,
                timeout=timeout,
                renew_interval=renew_interval,
            )

        return wrapped_acquire

    for broker in (broker_owner, broker_stage1):
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
        monkeypatch.setattr(
            broker._lock,
            "acquire",
            _wrap_lock_acquire(broker._lock.acquire),
        )

    owner_task = asyncio.create_task(
        broker_owner.get_positions_snapshot(
            force_fresh=True,
            caller_source="manual-refresh-owner",
        )
    )
    await started.wait()
    stage1_task = asyncio.create_task(
        broker_stage1.get_positions_snapshot(
            force_fresh=True,
            caller_source="stage1-console-profile",
        )
    )
    await asyncio.sleep(0.05)
    release.set()
    owner_snapshot, stage1_snapshot = await asyncio.gather(owner_task, stage1_task)

    assert owner_snapshot.diagnostics.lock_wait_ms == 30_000
    assert stage1_snapshot.source == "redis-cache"
    assert stage1_snapshot.freshness_state == "fresh"
    assert stage1_snapshot.diagnostics.caller_source == "stage1-console-profile"
    assert (
        stage1_snapshot.diagnostics.snapshot_producer_source
        == "manual-refresh-owner"
    )
    assert stage1_snapshot.diagnostics.produced_by_another_refresh is True


@pytest.mark.anyio
async def test_force_fresh_retries_once_after_owner_failure_without_snapshot(
    monkeypatch,
):
    redis = FakeRedis()
    broker_owner = _build_broker(monkeypatch, redis)
    broker_retry = _build_broker(monkeypatch, redis)
    artifact = _credential_artifact()
    owner_started = asyncio.Event()
    owner_release = asyncio.Event()
    retry_calls = 0

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: artifact,
    )
    monkeypatch.setattr(runtime_broker_module, "_POLL_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(
        runtime_broker_module,
        "_POSITIONS_OWNER_RELEASE_GRACE_SECONDS",
        0.02,
    )

    async def fake_ensure_auth_ready_under_lock(**kwargs):
        return "2026-07-19T12:00:00+00:00"

    async def owner_execute_raw_under_lock(*args, **kwargs):
        owner_started.set()
        await owner_release.wait()
        raise BullpenRuntimeCommandError(
            "owner refresh failed",
            classification="runtime_error",
        )

    async def retry_execute_raw_under_lock(*args, **kwargs):
        nonlocal retry_calls
        retry_calls += 1
        return _build_raw_result(
            json.dumps({"positions": []}),
            credential_artifact=artifact,
        )

    monkeypatch.setattr(
        broker_owner,
        "ensure_auth_ready_under_lock",
        fake_ensure_auth_ready_under_lock,
    )
    monkeypatch.setattr(
        broker_retry,
        "ensure_auth_ready_under_lock",
        fake_ensure_auth_ready_under_lock,
    )
    monkeypatch.setattr(
        broker_owner,
        "_execute_raw_under_lock",
        owner_execute_raw_under_lock,
    )
    monkeypatch.setattr(
        broker_retry,
        "_execute_raw_under_lock",
        retry_execute_raw_under_lock,
    )

    owner_task = asyncio.create_task(
        broker_owner.get_positions_snapshot(
            force_fresh=True,
            caller_source="owner-failure",
        )
    )
    await owner_started.wait()
    retry_task = asyncio.create_task(
        broker_retry.get_positions_snapshot(
            force_fresh=True,
            caller_source="stage1-console-profile",
        )
    )
    await asyncio.sleep(0.05)
    owner_release.set()

    with pytest.raises(BullpenRuntimeCommandError) as exc_info:
        await owner_task
    retry_snapshot = await retry_task

    assert exc_info.value.classification == "runtime_error"
    assert retry_calls == 1
    assert retry_snapshot.source == "live-cli"
    assert retry_snapshot.diagnostics.caller_source == "stage1-console-profile"
    assert retry_snapshot.diagnostics.produced_by_another_refresh is False


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
async def test_display_lkg_accepts_same_account_after_credential_rotation_but_execution_does_not(
    monkeypatch,
):
    broker = _build_broker(monkeypatch)
    snapshot_artifact = _credential_artifact(inode=11, mtime_ns=22, size=33)
    current_artifact = _credential_artifact(inode=12, mtime_ns=23, size=34)
    snapshot = _build_snapshot(
        seconds_ago=600,
        credential_artifact=snapshot_artifact,
        account_identity="wallet-a",
    )
    refresh_called = False

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: current_artifact,
    )
    await broker._write_auth_ready_cache(
        cache_key=AUTH_READY_CACHE_KEY,
        checked_at="2026-07-19T12:00:00+00:00",
        credential_artifact=current_artifact,
        account_identity="wallet-a",
    )
    await broker._redis.set(
        POSITIONS_DISPLAY_LKG_KEY,
        snapshot.model_dump_json(),
        ex=24 * 60 * 60,
    )

    display_snapshot = await broker.read_display_positions_snapshot()

    assert display_snapshot is not None
    assert display_snapshot.source == "redis-cache"
    assert display_snapshot.freshness_state == "stale"
    assert display_snapshot.diagnostics.cache_status == "stale"

    async def fail_if_execution_falls_back_to_lkg(**_kwargs):
        nonlocal refresh_called
        refresh_called = True
        raise BullpenRuntimeCommandError(
            "fresh execution snapshot required",
            classification="passive_cache_miss",
        )

    monkeypatch.setattr(
        broker,
        "_refresh_positions_snapshot",
        fail_if_execution_falls_back_to_lkg,
    )

    with pytest.raises(BullpenRuntimeCommandError, match="fresh execution snapshot"):
        await broker.get_positions_snapshot(
            caller_source="stage1-console-profile",
        )

    assert refresh_called is True


@pytest.mark.anyio
async def test_display_lkg_uses_long_lived_active_auth_identity_after_ready_cache_expires(
    monkeypatch,
):
    broker = _build_broker(monkeypatch)
    snapshot_artifact = _credential_artifact(inode=11, mtime_ns=22, size=33)
    current_artifact = _credential_artifact(inode=12, mtime_ns=23, size=34)
    snapshot = _build_snapshot(
        seconds_ago=600,
        credential_artifact=snapshot_artifact,
        account_identity="wallet-a",
    )

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: current_artifact,
    )
    await broker._write_active_auth_result(
        BullpenRuntimeActiveAuthResult(
            checked_at="2026-07-19T12:00:01+00:00",
            auth_checked_at="2026-07-19T12:00:00+00:00",
            healthy=True,
            login_required=False,
            doctor_refresh_succeeded=True,
            account_identity="wallet-a",
            credential_artifact=current_artifact,
        )
    )
    await broker._redis.set(
        POSITIONS_DISPLAY_LKG_KEY,
        snapshot.model_dump_json(),
        ex=24 * 60 * 60,
    )

    assert await broker._redis.get(AUTH_READY_CACHE_KEY) is None
    display_snapshot = await broker.read_display_positions_snapshot()

    assert display_snapshot is not None
    assert display_snapshot.account_identity == "wallet-a"
    assert display_snapshot.freshness_state == "stale"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("account_identity", "classifier_version"),
    [
        ("wallet-b", BULLPEN_POSITION_CLASSIFIER_VERSION),
        ("wallet-a", BULLPEN_POSITION_CLASSIFIER_VERSION - 1),
    ],
)
async def test_display_lkg_rejects_account_or_classifier_mismatch(
    monkeypatch,
    account_identity,
    classifier_version,
):
    broker = _build_broker(monkeypatch)
    snapshot_artifact = _credential_artifact(inode=11, mtime_ns=22, size=33)
    current_artifact = _credential_artifact(inode=12, mtime_ns=23, size=34)
    snapshot = _build_snapshot(
        credential_artifact=snapshot_artifact,
        account_identity=account_identity,
        position_classifier_version=classifier_version,
    )

    monkeypatch.setattr(
        runtime_broker_module,
        "_stat_credential_artifact",
        lambda _config: current_artifact,
    )
    await broker._write_auth_ready_cache(
        cache_key=AUTH_READY_CACHE_KEY,
        checked_at="2026-07-19T12:00:00+00:00",
        credential_artifact=current_artifact,
        account_identity="wallet-a",
    )
    await broker._redis.set(
        POSITIONS_DISPLAY_LKG_KEY,
        snapshot.model_dump_json(),
        ex=24 * 60 * 60,
    )

    assert await broker.read_display_positions_snapshot() is None
    assert await broker._redis.get(POSITIONS_DISPLAY_LKG_KEY) is None


def test_account_identity_extraction_is_stable_across_payload_key_order():
    first = {
        "user_id": "generic-user",
        "wallet_address": "0xABCDEF",
    }
    second = {
        "wallet_address": "0xABCDEF",
        "user_id": "generic-user",
    }

    assert runtime_broker_module._extract_account_identity(first) == "0xabcdef"
    assert runtime_broker_module._extract_account_identity(second) == "0xabcdef"


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
