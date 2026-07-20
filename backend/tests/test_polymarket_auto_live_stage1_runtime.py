import asyncio
import os
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.polymarket_auto_live.console_profile import (
    CONSOLE_DISCOVER_TIMEOUT_SECONDS,
    CONSOLE_POSITIONS_TIMEOUT_SECONDS,
    CONSOLE_POSITIONS_TIMEOUT_ENV_VAR,
    read_console_wallet_positions,
    scan_console_profile_markets,
)
from app.domains.polymarket_auto_live.execution import refresh_balance
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveRun,
    BullpenAutoLiveState,
)
from app.domains.polymarket_auto_live.tasks import (
    AutoLiveRunCancelled,
    persist_auto_live_progress_sync,
)


@pytest.mark.anyio
async def test_console_profile_scan_uses_fast_timeout_without_login_wait(
    monkeypatch,
):
    captured: dict[str, object] = {}

    async def fake_run_first_bullpen_json(
        _command_variants,
        *,
        timeout_seconds: int,
        extra_env=None,
        wait_for_login: bool = True,
    ):
        captured["timeout_seconds"] = timeout_seconds
        captured["wait_for_login"] = wait_for_login
        return {
            "markets": [
                {
                    "id": "market-fast-scan",
                    "question": "Will the fast Stage 1 scan finish?",
                    "slug": "will-the-fast-stage-1-scan-finish",
                    "endDate": "2026-07-19T00:00:00Z",
                    "outcomes": "[\"Yes\", \"No\"]",
                    "outcomePrices": "[0.42, 0.58]",
                }
            ]
        }

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.console_profile.run_first_bullpen_json",
        fake_run_first_bullpen_json,
    )

    result = await scan_console_profile_markets(
        now=datetime(2026, 7, 18, 12, 0, tzinfo=UTC),
    )

    assert captured == {
        "timeout_seconds": CONSOLE_DISCOVER_TIMEOUT_SECONDS,
        "wait_for_login": False,
    }
    assert result.source_label == "Bullpen CLI"
    assert result.total_candidates == 1
    assert len(result.accepted) == 1


@pytest.mark.anyio
async def test_console_profile_scan_falls_back_to_empty_set_after_bounded_scan_failure(
    monkeypatch,
):
    async def fail_cli(*_args, **_kwargs):
        raise RuntimeError("Bullpen CLI unavailable")

    async def hang_gamma(*_args, **_kwargs):
        await asyncio.Event().wait()

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.console_profile.run_first_bullpen_json",
        fail_cli,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.console_profile.scan_candidate_markets",
        hang_gamma,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.console_profile.CONSOLE_GAMMA_SCAN_TIMEOUT_SECONDS",
        0.01,
    )

    result = await scan_console_profile_markets(
        now=datetime(2026, 7, 18, 12, 0, tzinfo=UTC),
    )

    assert result.accepted == []
    assert result.rejected == []
    assert result.total_candidates == 0
    assert result.warning == (
        "Bullpen CLI and Gamma scan failed; continuing with no Stage 1 candidates."
    )


@pytest.mark.anyio
async def test_console_wallet_positions_use_fast_timeout_without_login_wait(
    monkeypatch,
):
    captured: dict[str, object] = {}

    class FakeBroker:
        async def get_positions_snapshot(
            self,
            *,
            force_fresh: bool,
            caller_source: str,
            max_age_seconds: int,
            timeout_seconds: int,
        ):
            captured["force_fresh"] = force_fresh
            captured["caller_source"] = caller_source
            captured["max_age_seconds"] = max_age_seconds
            captured["timeout_seconds"] = timeout_seconds
            return SimpleNamespace(
                payload={
                    "positions": [
                        {
                            "slug": "fast-wallet-position",
                            "market": "Fast wallet position",
                            "outcome": "No",
                            "shares": 4,
                            "avg_price": 0.45,
                            "current_price": 0.4,
                            "invested_usd": 1.8,
                            "end_date": "2026-07-19T00:00:00+00:00",
                        }
                    ]
                }
            )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.console_profile.get_bullpen_runtime_broker",
        lambda: FakeBroker(),
    )

    positions = await read_console_wallet_positions()

    assert captured == {
        "force_fresh": True,
        "caller_source": "console-wallet",
        "max_age_seconds": CONSOLE_POSITIONS_TIMEOUT_SECONDS,
        "timeout_seconds": CONSOLE_POSITIONS_TIMEOUT_SECONDS,
    }
    assert len(positions) == 1
    assert positions[0].slug == "fast-wallet-position"


@pytest.mark.anyio
async def test_console_wallet_positions_allow_timeout_env_override(monkeypatch):
    captured: dict[str, object] = {}

    class FakeBroker:
        async def get_positions_snapshot(
            self,
            *,
            force_fresh: bool,
            caller_source: str,
            max_age_seconds: int,
            timeout_seconds: int,
        ):
            captured["force_fresh"] = force_fresh
            captured["caller_source"] = caller_source
            captured["max_age_seconds"] = max_age_seconds
            captured["timeout_seconds"] = timeout_seconds
            return SimpleNamespace(
                payload={
                    "positions": [
                        {
                            "slug": "env-timeout-wallet-position",
                            "market": "Env timeout wallet position",
                            "outcome": "Yes",
                            "shares": 2,
                            "avg_price": 0.51,
                            "current_price": 0.55,
                            "invested_usd": 1.02,
                            "end_date": "2026-07-19T00:00:00+00:00",
                        }
                    ]
                }
            )

    monkeypatch.setenv(CONSOLE_POSITIONS_TIMEOUT_ENV_VAR, "27")
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.console_profile.get_bullpen_runtime_broker",
        lambda: FakeBroker(),
    )

    positions = await read_console_wallet_positions()

    assert captured == {
        "force_fresh": True,
        "caller_source": "console-wallet",
        "max_age_seconds": CONSOLE_POSITIONS_TIMEOUT_SECONDS,
        "timeout_seconds": 27,
    }
    assert len(positions) == 1
    assert positions[0].slug == "env-timeout-wallet-position"


@pytest.mark.anyio
async def test_console_wallet_positions_reuse_provided_snapshot_payload_without_refetch(
    monkeypatch,
):
    broker_called = False

    class FakeBroker:
        async def get_positions_snapshot(self, **_kwargs):
            nonlocal broker_called
            broker_called = True
            raise AssertionError("Broker should not be called when snapshot payload is supplied")

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.console_profile.get_bullpen_runtime_broker",
        lambda: FakeBroker(),
    )

    positions = await read_console_wallet_positions(
        snapshot_payload={
            "positions": [
                {
                    "slug": "snapshot-wallet-position",
                    "market": "Snapshot wallet position",
                    "outcome": "No",
                    "shares": 5,
                    "avg_price": 0.37,
                    "current_price": 0.41,
                    "invested_usd": 1.85,
                    "end_date": "2026-07-21T00:00:00+00:00",
                }
            ]
        }
    )

    assert broker_called is False
    assert len(positions) == 1
    assert positions[0].slug == "snapshot-wallet-position"


@pytest.mark.anyio
async def test_auto_live_refresh_balance_skips_interactive_login_wait(monkeypatch):
    captured: dict[str, object] = {}

    class FakeBalanceReader:
        async def refresh(self, *, wait_for_login: bool = True):
            captured["wait_for_login"] = wait_for_login
            return SimpleNamespace(status="ready")

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.execution.BullpenBalanceReader",
        lambda: FakeBalanceReader(),
    )

    balance_state = await refresh_balance()

    assert captured == {"wait_for_login": False}
    assert balance_state.status == "ready"


def test_persist_auto_live_progress_sync_rejects_user_cancelled_run():
    cancelled_run = BullpenAutoLiveRun(
        id="run-cancelled-during-stage1",
        triggered_by="manual",
        status="failed",
        dry_run=True,
        started_at="2026-07-18T17:46:00+00:00",
        completed_at="2026-07-18T17:47:00+00:00",
        summary="Auto-Live run cancelled by user.",
        error_message="Cancelled by user",
    )
    worker_run = BullpenAutoLiveRun(
        id="run-cancelled-during-stage1",
        triggered_by="manual",
        status="running",
        dry_run=True,
        started_at="2026-07-18T17:46:00+00:00",
        summary="Stage 1 started. Bullpen scan is preparing the candidate fetch.",
    )
    saved_calls: list[str] = []

    class FakeRepo:
        def get_run_for_update(self, run_id: str):
            assert run_id == worker_run.id
            return cancelled_run

        def get_run(self, run_id: str):
            raise AssertionError("worker cancellation checks must refresh and lock the run")

        def save_run(self, user_id: int, run: BullpenAutoLiveRun) -> None:
            saved_calls.append(f"save_run:{user_id}:{run.id}")

        def replace_run_decisions_from_stage3_payload(self, user_id: int, run) -> None:
            saved_calls.append(f"replace:{user_id}:{run.id}")

        def save_state(self, user_id: int, state) -> None:
            saved_calls.append(f"save_state:{user_id}:{state.last_run_id}")

    class FakeSession:
        def __init__(self) -> None:
            self.committed = False

        def commit(self) -> None:
            self.committed = True

    session = FakeSession()

    with pytest.raises(AutoLiveRunCancelled):
        persist_auto_live_progress_sync(
            user_id=7,
            repo=FakeRepo(),
            session=session,
            run=worker_run,
            state=BullpenAutoLiveState(running=True, last_run_id=worker_run.id),
        )

    assert saved_calls == []
    assert session.committed is False
