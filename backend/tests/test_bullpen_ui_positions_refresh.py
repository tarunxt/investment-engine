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
from app.domains.polymarket import runtime_positions_refresh as refresh_module
from app.domains.polymarket.runtime_broker import (
    BullpenAuthReadyCache,
    BullpenCommandDiagnostics,
    BullpenCredentialArtifact,
    BullpenRawCommandResult,
    BullpenRuntimeActiveAuthResult,
    BullpenRuntimeBroker,
    BullpenRuntimeCommandError,
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
@pytest.mark.parametrize(
    "caller_source",
    ["ui-history-portfolio-refresh", "ui-manual-refresh"],
)
async def test_ui_portfolio_refresh_reads_positions_before_trade_auth(
    monkeypatch: pytest.MonkeyPatch,
    caller_source: str,
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
        caller_source=caller_source,
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
        caller_source="ui-manual-refresh",
        max_age_seconds=0,
    )

    assert snapshot.auth_checked_at == "2026-08-09T04:46:00+00:00"
    assert (
        await redis.get(runtime_broker_module._POSITIONS_DISPLAY_LKG_KEY)
        is not None
    )
    assert await redis.get(runtime_broker_module._POSITIONS_SNAPSHOT_KEY) is not None


@pytest.mark.anyio
async def test_manual_ui_refresh_falls_back_to_fresh_public_wallet_display(
    monkeypatch: pytest.MonkeyPatch,
):
    redis = FakeRedis()
    broker = _build_broker(monkeypatch, redis)
    artifact = _credential_artifact()
    wallet = "0xa70b18abdebf0704b41901c33e8477ea1085afdf"
    calls: list[list[str]] = []

    async def fake_execute_raw(
        args: list[str],
        **_kwargs,
    ) -> BullpenRawCommandResult:
        calls.append(args)
        if args[:2] == ["polymarket", "positions"]:
            raise BullpenRuntimeCommandError(
                "Not logged in",
                classification="auth_rejected",
            )
        if args[0] == "status":
            return BullpenRawCommandResult(
                stdout=json.dumps(
                    {
                        "account": {
                            "address": wallet,
                            "logged_in": False,
                        }
                    }
                ),
                diagnostics=BullpenCommandDiagnostics(
                    command_category="status",
                    pid=1234,
                    unix_user="investor",
                    effective_home="/home/investor",
                    credential_artifact=artifact,
                ),
            )
        raise AssertionError(f"Unexpected command: {args}")

    async def fake_public_payload(resolved_wallet: str):
        assert resolved_wallet == wallet
        return {
            "_meta": {
                "source": "polymarket-public-data-api",
                "wallet_address": wallet,
                "display_only": True,
            },
            "positions": [
                {
                    "market": "Position 1",
                    "shares": 5.49,
                    "current_value": 5.08,
                    "redeemable": False,
                },
                {
                    "market": "Position 2",
                    "shares": 5.26,
                    "current_value": 4.97,
                    "redeemable": False,
                },
                {
                    "market": "Position 3",
                    "shares": 3.02,
                    "current_value": 2.88,
                    "redeemable": False,
                },
            ],
            "summary": {
                "active_count": 3,
                "cash_balance": 9.628045,
                "claimable_count": 0,
                "claimable_value": 0.0,
                "total_value": 22.565045,
                "unrealized_pnl": 1.127,
                "wallet_value": 12.937,
            },
        }

    monkeypatch.setattr(broker, "execute_raw", fake_execute_raw)
    monkeypatch.setattr(
        refresh_module,
        "_read_public_positions_payload",
        fake_public_payload,
    )

    snapshot = await broker.get_positions_snapshot(
        force_fresh=True,
        allow_refresh=True,
        caller_source="ui-manual-refresh",
        max_age_seconds=0,
    )

    assert calls[0][:2] == ["polymarket", "positions"]
    assert calls[1][0] == "status"
    assert snapshot.source == "redis-cache"
    assert snapshot.freshness_state == "cached"
    assert snapshot.account_identity == wallet
    assert snapshot.payload["summary"]["total_value"] == pytest.approx(22.565045)
    assert snapshot.payload["summary"]["wallet_value"] == pytest.approx(12.937)
    assert snapshot.payload["summary"]["cash_balance"] == pytest.approx(9.628045)
    assert snapshot.diagnostics.snapshot_producer_source == "polymarket-public-data-api"
    assert (
        await redis.get(runtime_broker_module._POSITIONS_DISPLAY_LKG_KEY)
        is not None
    )
    # Display fallback must never become the execution-authoritative snapshot.
    assert await redis.get(runtime_broker_module._POSITIONS_SNAPSHOT_KEY) is None


@pytest.mark.anyio
@pytest.mark.parametrize(
    "caller_source",
    ["ui-history-portfolio-load", "ui-passive-refresh"],
)
async def test_passive_ui_cache_miss_uses_same_public_wallet_fallback(
    monkeypatch: pytest.MonkeyPatch,
    caller_source: str,
):
    redis = FakeRedis()
    broker = _build_broker(monkeypatch, redis)
    wallet = "0xa70b18abdebf0704b41901c33e8477ea1085afdf"

    async def fake_original(*_args, **_kwargs):
        raise BullpenRuntimeCommandError(
            "No fresh shared Bullpen positions snapshot is cached for passive caller.",
            classification="passive_cache_miss",
        )

    async def fake_status_address(_broker):
        return wallet

    async def fake_public_payload(resolved_wallet: str):
        assert resolved_wallet == wallet
        return {
            "positions": [],
            "summary": {
                "active_count": 0,
                "cash_balance": 9.628045,
                "claimable_count": 0,
                "claimable_value": 0.0,
                "total_value": 9.628045,
                "unrealized_pnl": 0.0,
                "wallet_value": 0.0,
            },
        }

    monkeypatch.setattr(refresh_module, "_ORIGINAL_GET_POSITIONS_SNAPSHOT", fake_original)
    monkeypatch.setattr(refresh_module, "_status_wallet_address", fake_status_address)
    monkeypatch.setattr(
        refresh_module,
        "_read_public_positions_payload",
        fake_public_payload,
    )

    snapshot = await broker.get_positions_snapshot(
        force_fresh=False,
        allow_refresh=False,
        caller_source=caller_source,
        max_age_seconds=20,
    )

    assert snapshot.account_identity == wallet
    assert snapshot.source == "redis-cache"
    assert snapshot.freshness_state == "cached"
    assert snapshot.payload["summary"]["cash_balance"] == pytest.approx(9.628045)


def test_public_wallet_position_normalization_and_summary_use_current_evidence():
    rows = [
        {
            "conditionId": "0xcondition-1",
            "size": 5.4945,
            "avgPrice": 0.9099,
            "curPrice": 0.925,
            "initialValue": 4.9999,
            "currentValue": 5.0824,
            "cashPnl": 0.0824,
            "percentPnl": 1.648,
            "title": "Israel x Iran ceasefire continues through August 15?",
            "outcome": "Yes",
            "slug": "position-1",
            "redeemable": False,
        },
        {
            "conditionId": "0xcondition-2",
            "size": 3.0166,
            "avgPrice": 0.6,
            "curPrice": 0.955,
            "initialValue": 1.8099,
            "currentValue": 2.8809,
            "cashPnl": 1.0709,
            "percentPnl": 59.1657,
            "title": "Iran full airspace closure by August 15?",
            "outcome": "No",
            "slug": "position-2",
            "redeemable": False,
        },
    ]
    positions = [refresh_module._normalize_public_position(row) for row in rows]
    normalized = [row for row in positions if row is not None]
    summary = refresh_module._build_public_summary(
        normalized,
        cash_balance=9.628045,
    )

    assert len(normalized) == 2
    assert summary["active_count"] == 2
    assert summary["wallet_value"] == pytest.approx(7.9633)
    assert summary["total_value"] == pytest.approx(17.591345)
    assert summary["unrealized_pnl"] == pytest.approx(1.1533)
