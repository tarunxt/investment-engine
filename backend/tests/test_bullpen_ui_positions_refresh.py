import json
import os
import time

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.polymarket import runtime_broker as runtime_broker_module
from app.domains.polymarket.runtime_broker import (
    BullpenAuthReadyCache,
    BullpenCommandDiagnostics,
    BullpenCredentialArtifact,
    BullpenRawCommandResult,
    BullpenRuntimeActiveAuthResult,
    BullpenRuntimeBroker,
)
from app.domains.polymarket.runtime_positions_refresh import (
    install_bullpen_ui_positions_refresh,
)

install_bullpen_ui_positions_refresh()


class FakeRedis:
    def __init__(self) -> None:
        self._values: dict[str, tuple[str, float | None]] = {}

    async def get(self, key: str):
        record = self._values.get(key)
        if record is None:
            return None
        value, expires_at = record
        if expires_at is not None and time.time() >= expires_at:
            self._values.pop(key, None)
            return None
        return value

    async def set(
        self,
        key: str,
        value: str,
        ex: int | None = None,
        nx: bool = False,
    ):
        existing = await self.get(key)
        if nx and existing is not None:
            return None
        self._values[key] = (
            value,
            time.time() + ex if ex is not None else None,
        )
        return True

    async def delete(self, key: str):
        removed = key in self._values
        self._values.pop(key, None)
        return 1 if removed else 0

    async def aclose(self):
        return None


def _credential_artifact() -> BullpenCredentialArtifact:
    return BullpenCredentialArtifact(
        path="/home/investor/.bullpen/credentials.json.enc",
        inode=11,
        mtime=1.0,
        mtime_ns=1_000_000_000,
        size=128,
    )


def _positions_result(
    artifact: BullpenCredentialArtifact,
) -> BullpenRawCommandResult:
    return BullpenRawCommandResult(
        stdout=json.dumps(
            {
                "wallet_address": "0xwallet-a",
                "positions": [
                    {"slug": "position-one", "shares": 5.495},
                    {"slug": "position-two", "shares": 5.263},
                    {"slug": "position-three", "shares": 3.017},
                ],
            }
        ),
        diagnostics=BullpenCommandDiagnostics(
            command_category="positions",
            pid=1234,
            unix_user="investor",
            effective_home="/home/investor",
            credential_artifact=artifact,
        ),
    )


def _build_broker(
    monkeypatch: pytest.MonkeyPatch,
    redis: FakeRedis,
) -> BullpenRuntimeBroker:
    monkeypatch.setattr(
        runtime_broker_module.aioredis,
        "from_url",
        lambda *args, **kwargs: redis,
    )
    broker = BullpenRuntimeBroker()
    broker._redis = redis
    return broker


@pytest.mark.anyio
async def test_history_portfolio_refresh_reads_positions_before_trade_auth(
    monkeypatch: pytest.MonkeyPatch,
):
    redis = FakeRedis()
    broker = _build_broker(monkeypatch, redis)
    artifact = _credential_artifact()
    await redis.set(
        runtime_broker_module._ACTIVE_AUTH_RESULT_KEY,
        BullpenRuntimeActiveAuthResult(
            checked_at="2026-08-09T04:45:00+00:00",
            healthy=False,
            login_required=True,
            doctor_refresh_succeeded=False,
            credentials_valid=True,
            refresh_succeeded=False,
            token_valid=False,
            trade_auth_blocked=True,
            requires_login=True,
            failure_reason="Not logged in",
            error_classification="auth_rejected",
            credential_artifact=artifact,
        ).model_dump_json(),
    )

    calls: list[tuple[list[str], int, bool]] = []

    async def fake_execute_raw(
        args: list[str],
        *,
        timeout_seconds: int,
        retry_auth_once: bool,
        **_kwargs,
    ) -> BullpenRawCommandResult:
        calls.append((args, timeout_seconds, retry_auth_once))
        return _positions_result(artifact)

    async def fail_if_proactive_auth_runs(**_kwargs):
        raise AssertionError("UI wallet read must not pre-gate on doctor auth")

    monkeypatch.setattr(broker, "execute_raw", fake_execute_raw)
    monkeypatch.setattr(
        broker,
        "ensure_auth_ready_under_lock",
        fail_if_proactive_auth_runs,
    )

    snapshot = await broker.get_positions_snapshot(
        force_fresh=True,
        allow_refresh=True,
        caller_source="ui-history-portfolio-refresh",
        max_age_seconds=0,
        timeout_seconds=17,
    )

    assert calls == [
        (["polymarket", "positions", "--output", "json"], 17, True)
    ]
    assert snapshot.source == "live-cli"
    assert snapshot.freshness_state == "fresh"
    assert snapshot.auth_checked_at is None
    assert len(snapshot.payload["positions"]) == 3
    assert (
        await redis.get(runtime_broker_module._POSITIONS_DISPLAY_LKG_KEY)
        is not None
    )
    assert await redis.get(runtime_broker_module._POSITIONS_SNAPSHOT_KEY) is None


@pytest.mark.anyio
async def test_history_portfolio_refresh_promotes_only_with_current_auth_proof(
    monkeypatch: pytest.MonkeyPatch,
):
    redis = FakeRedis()
    broker = _build_broker(monkeypatch, redis)
    artifact = _credential_artifact()
    auth_cache_key = f"{runtime_broker_module._REDIS_PREFIX}:auth:ready"
    await redis.set(
        auth_cache_key,
        BullpenAuthReadyCache(
            checked_at="2026-08-09T04:46:00+00:00",
            credential_artifact=artifact,
            account_identity="0xwallet-a",
        ).model_dump_json(),
    )

    async def fake_execute_raw(
        _args: list[str],
        **_kwargs,
    ) -> BullpenRawCommandResult:
        return _positions_result(artifact)

    monkeypatch.setattr(broker, "execute_raw", fake_execute_raw)

    snapshot = await broker.get_positions_snapshot(
        force_fresh=True,
        allow_refresh=True,
        caller_source="ui-history-portfolio-refresh",
        max_age_seconds=0,
    )

    assert snapshot.auth_checked_at == "2026-08-09T04:46:00+00:00"
    assert (
        await redis.get(runtime_broker_module._POSITIONS_DISPLAY_LKG_KEY)
        is not None
    )
    assert await redis.get(runtime_broker_module._POSITIONS_SNAPSHOT_KEY) is not None
