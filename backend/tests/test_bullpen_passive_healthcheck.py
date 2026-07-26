from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.polymarket import passive_healthcheck
from app.domains.polymarket import runtime_broker as runtime_broker_module
from app.domains.polymarket.passive_healthcheck import (
    BullpenPassiveHealthReport,
    PassiveAuthReport,
    PassivePositionsReport,
)
from app.domains.polymarket.runtime_broker import (
    BullpenCommandDiagnostics,
    BullpenCredentialArtifact,
    BullpenPositionsSnapshot,
    BullpenPositionsSnapshotMetadata,
    BullpenRuntimeActiveAuthResult,
    BullpenRuntimeBroker,
    BullpenRuntimeCachedHealth,
    BullpenRuntimeFailure,
    BullpenRuntimePassiveHealth,
)

_PRIVATE_WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


def _passive_health(*, ok: bool = True) -> BullpenRuntimePassiveHealth:
    secret_artifact = BullpenCredentialArtifact(
        path="/home/investor/.bullpen/credentials.json.enc",
        inode=42,
        mtime_ns=1726000000,
        size=512,
    )
    diagnostics = BullpenCommandDiagnostics(
        command_category="positions",
        pid=123,
        effective_home="/home/investor",
        credential_artifact=secret_artifact,
        caller_source="test-source",
    )
    return BullpenRuntimePassiveHealth(
        ok=ok,
        checked_at="2026-07-27T10:00:00+00:00",
        broker_health=BullpenRuntimeCachedHealth(
            ok=ok,
            checked_at="2026-07-27T09:59:59+00:00",
            message=(
                "Bullpen cache ready."
                if ok
                else (
                    "authorization=super-secret-value "
                    f"wallet={_PRIVATE_WALLET} "
                    "path=/home/investor/.bullpen/credentials.json.enc"
                )
            ),
            command_category="positions",
            error_classification=None if ok else "auth_rejected",
            command_path="/usr/local/bin/bullpen",
            effective_home="/home/investor",
            credential_artifact=secret_artifact,
        ),
        auth_checked_at="2026-07-27T09:59:58+00:00",
        latest_snapshot=BullpenPositionsSnapshotMetadata(
            fetched_at="2026-07-27T09:59:59+00:00",
            credential_artifact=secret_artifact,
            account_identity="0xwallet-must-not-escape",
            position_classifier_version=4,
            auth_checked_at="2026-07-27T09:59:58+00:00",
            source="redis-cache",
            freshness_state="cached",
            diagnostics=diagnostics,
        ),
        last_failure=BullpenRuntimeFailure(
            occurred_at="2026-07-27T09:50:00+00:00",
            classification="auth_rejected",
            message=(
                "refresh_token=another-secret "
                f"account_identity={_PRIVATE_WALLET} "
                "home=/home/investor"
            ),
            stale=ok,
            recovered_at="2026-07-27T09:59:58+00:00" if ok else None,
        ),
        active_auth=BullpenRuntimeActiveAuthResult(
            checked_at="2026-07-27T09:59:58+00:00",
            auth_checked_at="2026-07-27T09:59:58+00:00",
            healthy=ok,
            login_required=not ok,
            doctor_refresh_succeeded=ok,
            wallet_ready=ok,
            failure_reason=(
                None
                if ok
                else (
                    "api_key=active-secret "
                    f"wallet_address={_PRIVATE_WALLET} "
                    "credential_path=/home/investor/.bullpen/credentials.json.enc"
                )
            ),
            error_classification=None if ok else "auth_rejected",
            credential_artifact=secret_artifact,
        ),
        command_path="/usr/local/bin/bullpen",
    )


def _report() -> BullpenPassiveHealthReport:
    return BullpenPassiveHealthReport(
        ok=True,
        checked_at="2026-07-27T10:00:00+00:00",
        message="Shared broker cache is healthy.",
        auth=PassiveAuthReport(
            available=True,
            healthy=True,
            checked_at="2026-07-27T09:59:58+00:00",
        ),
        positions_snapshot=PassivePositionsReport(
            available=True,
            fetched_at="2026-07-27T09:59:59+00:00",
            freshness_state="cached",
            source="redis-cache",
            position_classifier_version=4,
        ),
    )


def test_report_is_bounded_sanitized_and_omits_wallet_runtime_and_credentials():
    report = passive_healthcheck.build_passive_health_report(
        _passive_health(ok=False)
    )
    serialized = passive_healthcheck._serialized_report(report)

    assert len(serialized) <= passive_healthcheck._MAX_REPORT_BYTES
    assert report.ok is False
    assert report.classification == "auth_rejected"
    assert report.message == "Shared Bullpen runtime cache reports unhealthy."
    assert report.last_failure is not None
    assert report.last_failure.message == (
        "A shared Bullpen runtime failure was recorded."
    )
    for forbidden in (
        "0xwallet-must-not-escape",
        _PRIVATE_WALLET,
        "credentials.json",
        "/usr/local/bin/bullpen",
        "/home/investor",
        "super-secret-value",
        "active-secret",
        "another-secret",
        "caller_source",
        '"pid"',
    ):
        assert forbidden.encode() not in serialized


def test_explicit_cached_wallet_not_ready_is_unhealthy_without_active_probe():
    passive = _passive_health(ok=True)
    assert passive.active_auth is not None
    passive.active_auth.wallet_ready = False

    report = passive_healthcheck.build_passive_health_report(passive)

    assert report.ok is False
    assert report.classification == "wallet_not_ready"
    assert report.auth.healthy is True
    assert report.auth.wallet_ready is False


def test_wallet_and_path_like_classifications_fall_back_to_known_runtime_error():
    passive = _passive_health(ok=False)
    assert passive.active_auth is not None
    assert passive.last_failure is not None
    passive.active_auth.error_classification = _PRIVATE_WALLET
    passive.broker_health.error_classification = "/home/investor/.bullpen"
    passive.last_failure.classification = "wallet.owner.private"

    report = passive_healthcheck.build_passive_health_report(passive)
    payload = passive_healthcheck._serialized_report(report)

    assert report.classification == "runtime_error"
    assert report.auth.error_classification == "runtime_error"
    assert report.last_failure is not None
    assert report.last_failure.classification == "runtime_error"
    assert _PRIVATE_WALLET.encode() not in payload
    assert b"/home/investor" not in payload
    assert b"wallet.owner.private" not in payload


@pytest.mark.anyio
async def test_failure_stdout_webhook_payload_and_report_never_echo_identity_or_path(
    monkeypatch,
    tmp_path,
    capsys,
):
    failure = (
        f"wallet={_PRIVATE_WALLET} "
        "credential_path=/home/investor/.bullpen/credentials.json.enc"
    )

    async def fail_collect():
        raise RuntimeError(failure)

    delivered: list[bytes] = []

    def capture_webhook(report):
        delivered.append(passive_healthcheck._serialized_report(report))
        return True

    monkeypatch.setattr(
        passive_healthcheck,
        "collect_passive_health_report",
        fail_collect,
    )
    monkeypatch.setattr(
        passive_healthcheck,
        "post_passive_health_webhook",
        capture_webhook,
    )
    monkeypatch.setenv("BULLPEN_HEALTH_STATE_DIR", str(tmp_path))

    exit_code = await passive_healthcheck.run_healthcheck()
    output = capsys.readouterr()
    report_payload = (tmp_path / "bullpen-health.json").read_bytes()

    assert exit_code == 1
    assert delivered == [report_payload]
    for visible in (
        output.out.encode(),
        output.err.encode(),
        report_payload,
        delivered[0],
    ):
        assert _PRIVATE_WALLET.encode() not in visible
        assert b"/home/investor" not in visible
        assert b"credentials.json" not in visible


def test_atomic_report_write_replaces_destination_with_private_permissions(tmp_path):
    state_dir = tmp_path / "health"
    first_path = passive_healthcheck.write_passive_health_report(
        _report(),
        state_dir=str(state_dir),
    )
    updated = _report().model_copy(
        update={"message": "Updated shared broker health."}
    )
    second_path = passive_healthcheck.write_passive_health_report(
        updated,
        state_dir=str(state_dir),
    )

    assert first_path == second_path == state_dir / "bullpen-health.json"
    assert stat.S_IMODE(second_path.stat().st_mode) == 0o600
    assert json.loads(second_path.read_text(encoding="utf-8"))["message"] == (
        "Updated shared broker health."
    )
    assert [path.name for path in state_dir.iterdir()] == ["bullpen-health.json"]


def test_state_directory_rejects_relative_and_symbolic_paths(tmp_path):
    with pytest.raises(ValueError, match="absolute"):
        passive_healthcheck._state_directory("relative/path")

    real_dir = tmp_path / "real"
    real_dir.mkdir()
    linked_dir = tmp_path / "linked"
    linked_dir.symlink_to(real_dir, target_is_directory=True)
    with pytest.raises(ValueError, match="symbolic"):
        passive_healthcheck._state_directory(str(linked_dir))


@pytest.mark.anyio
async def test_collector_only_reads_passive_broker_state(monkeypatch):
    calls: list[str] = []

    class PassiveOnlyBroker:
        async def read_passive_health(self, *, strict_read_only=False):
            calls.append(f"read_passive_health:{strict_read_only}")
            return _passive_health()

        async def ensure_auth_ready(self, **_kwargs):
            raise AssertionError("passive healthcheck must not run active doctor")

        async def execute_raw(self, *_args, **_kwargs):
            raise AssertionError("passive healthcheck must not spawn the CLI")

    async def fake_close():
        calls.append("close")

    monkeypatch.setattr(
        passive_healthcheck,
        "get_bullpen_runtime_broker",
        lambda: PassiveOnlyBroker(),
    )
    monkeypatch.setattr(
        passive_healthcheck,
        "close_bullpen_runtime_broker",
        fake_close,
    )

    report = await passive_healthcheck.collect_passive_health_report()

    assert report.ok is True
    assert calls == ["read_passive_health:True", "close"]


class _FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.deleted: list[str] = []

    async def get(self, key: str):
        return self.values.get(key)

    async def delete(self, key: str):
        self.deleted.append(key)
        return int(self.values.pop(key, None) is not None)

    async def aclose(self):
        return None


@pytest.mark.anyio
async def test_new_passive_process_uses_shared_active_auth_as_authority(monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(
        runtime_broker_module.aioredis,
        "from_url",
        lambda *_args, **_kwargs: redis,
    )
    broker = BullpenRuntimeBroker()
    broker._redis = redis

    healthy = BullpenRuntimeActiveAuthResult(
        checked_at="2026-07-27T10:00:00+00:00",
        healthy=True,
        login_required=False,
        doctor_refresh_succeeded=True,
        credentials_valid=True,
        token_valid=True,
    )
    redis.values[runtime_broker_module._ACTIVE_AUTH_RESULT_KEY] = (
        healthy.model_dump_json()
    )

    shared_healthy = await broker.read_passive_health()

    assert shared_healthy.ok is True
    assert shared_healthy.broker_health.command_category == "doctor-auth-refresh"
    assert "shared Bullpen authentication check is healthy" in (
        shared_healthy.broker_health.message
    )

    failed = healthy.model_copy(
        update={
            "checked_at": "2026-07-27T10:01:00+00:00",
            "healthy": False,
            "login_required": True,
            "doctor_refresh_succeeded": False,
            "failure_reason": "authorization=secret-value",
            "error_classification": "auth_rejected",
        }
    )
    redis.values[runtime_broker_module._ACTIVE_AUTH_RESULT_KEY] = (
        failed.model_dump_json()
    )

    shared_failed = await broker.read_passive_health()

    assert shared_failed.ok is False
    assert shared_failed.broker_health.error_classification == "auth_rejected"
    assert shared_failed.broker_health.message == "authorization=[REDACTED]"


@pytest.mark.anyio
async def test_strict_passive_health_never_deletes_invalid_cached_snapshot(monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(
        runtime_broker_module.aioredis,
        "from_url",
        lambda *_args, **_kwargs: redis,
    )
    broker = BullpenRuntimeBroker()
    broker._redis = redis
    diagnostics = BullpenCommandDiagnostics(
        command_category="positions",
        pid=123,
        effective_home="/home/investor",
    )
    mismatched_snapshot = BullpenPositionsSnapshot(
        payload={"positions": []},
        fetched_at="2026-07-27T10:00:00+00:00",
        credential_artifact=BullpenCredentialArtifact(
            path="/different/credential/store",
            inode=99,
            mtime_ns=99,
            size=99,
        ),
        diagnostics=diagnostics,
    )
    snapshot_key = "bullpen:runtime:positions:snapshot"
    redis.values[snapshot_key] = mismatched_snapshot.model_dump_json()

    passive = await broker.read_passive_health(strict_read_only=True)

    assert passive.latest_snapshot is None
    assert redis.deleted == []
    assert snapshot_key in redis.values

    await broker.read_passive_health()

    assert redis.deleted == [snapshot_key]
    assert snapshot_key not in redis.values


def test_webhook_posts_only_the_sanitized_report_with_bounded_timeout():
    captured: dict[str, object] = {}

    class Response:
        status = 204

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    def fake_urlopen(request, *, timeout):
        captured["url"] = request.full_url
        captured["data"] = request.data
        captured["timeout"] = timeout
        return Response()

    posted = passive_healthcheck.post_passive_health_webhook(
        _report(),
        webhook_url="https://monitor.invalid/hook?token=secret",
        timeout_seconds=500,
        urlopen_impl=fake_urlopen,
    )

    assert posted is True
    assert captured["url"] == "https://monitor.invalid/hook?token=secret"
    assert captured["timeout"] == 30
    assert b"monitor.invalid" not in captured["data"]
    assert b"token=secret" not in captured["data"]
    assert json.loads(captured["data"])["monitoring_mode"] == "passive-read-only"


def test_webhook_rejects_non_http_protocols():
    with pytest.raises(ValueError, match="HTTP or HTTPS"):
        passive_healthcheck.post_passive_health_webhook(
            _report(),
            webhook_url="file:///tmp/health",
        )


def test_installed_healthcheck_contract_has_no_legacy_runtime_or_mutations():
    repository_root = Path(__file__).resolve().parents[2]
    service = (
        repository_root
        / "deploy/no-docker/systemd/credx-bullpen-healthcheck.service"
    ).read_text(encoding="utf-8")
    installer = (
        repository_root / "deploy/no-docker/install-bullpen-healthcheck.sh"
    ).read_text(encoding="utf-8")
    source = Path(passive_healthcheck.__file__).read_text(encoding="utf-8")

    assert "EnvironmentFile=__BACKEND_ENV_FILE__" in service
    assert "-m app.domains.polymarket.passive_healthcheck" in service
    assert "backend/.venv/bin/python" in installer
    assert 'systemctl start "$SERVICE_NAME"' in installer
    assert "--property=ExecMainStatus" in installer
    assert 'journalctl --unit "$SERVICE_NAME"' in installer
    assert "deployment continues because this monitor is read-only" in installer
    assert "FRONTEND_ENV_FILE" not in installer
    assert "/usr/bin/node" not in installer + service
    assert "scripts/bullpen-healthcheck.ts" not in installer + service
    for forbidden in (
        "create_subprocess",
        "subprocess.",
        "ensure_auth_ready(",
        "execute_raw(",
        "autoClaim",
    ):
        assert forbidden not in source
