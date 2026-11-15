"""Synthetic-only adversarial tests. No production evidence or providers."""
import asyncio
import builtins
import io
import json
import os
import socket
import subprocess
import threading
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import UserRole
from app.domains.polymarket import passive_projection, router as router_module, service as service_module
from app.domains.polymarket.bot import PolymarketPaperCopyBot
from app.domains.polymarket.config import load_polymarket_config
from app.domains.polymarket.passive_projection import PassiveProjectionUnavailable, _NoOperationalCapability
from app.domains.polymarket.runtime_broker import BullpenCommandDiagnostics, BullpenPositionsSnapshot
from app.domains.polymarket.schemas import PolymarketPaperTrade
from app.domains.polymarket.service import PolymarketBotManager, _LoopBoundBot


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _paper(index=0, *, pnl=0):
    return PolymarketPaperTrade(
        id=f"paper-{index}", source_trade_id=f"source-{index}",
        timestamp="2026-10-01T00:00:00+00:00", trader_id="synthetic",
        trader_name="Synthetic trader", market_id="synthetic-market",
        market_title="Synthetic market", outcome="Yes", side="SELL" if pnl else "BUY",
        price=0.5, copied_usd=1, shares=2, realized_pnl=pnl, status="executed",
    )


def _save_evidence(directory, *, count=2):
    directory.mkdir(parents=True)
    # Include an early realized gain which must survive display tail slicing.
    (directory / "polymarket-trades.json").write_text(json.dumps([
        _paper(index, pnl=17 if index == 0 else 0).model_dump() for index in range(count)
    ]))
    (directory / "polymarket-live-trades.json").write_text("[]")
    (directory / "polymarket-tracked-accounts.json").write_text("[]")
    (directory / "polymarket-config.json").write_text('{"auto_start":true,"paused":true}')


def _warm_bot(user_id=7):
    denied = _NoOperationalCapability()
    return PolymarketPaperCopyBot(
        user_id=user_id, config=load_polymarket_config(),
        provider=denied, fallback_provider=denied, store=denied, live_store=denied,
        tracked_account_store=denied, config_store=denied, live_executor=denied,
        balance_reader=denied, redeemed_trades_reader=denied, logger=denied,
    )


@contextmanager
def _deny_side_effects(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("Passive read attempted an operational side effect")

    original_open = builtins.open
    original_io_open = io.open
    original_os_open = os.open

    def checked_open(original):
        def opened(path, mode="r", *args, **kwargs):
            assert not any(flag in mode for flag in "wax+"), f"Unexpected write: {path}"
            return original(path, mode, *args, **kwargs)
        return opened

    def os_open(path, flags, *args, **kwargs):
        assert not flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)
        return original_os_open(path, flags, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(builtins, "open", checked_open(original_open))
        patch.setattr(io, "open", checked_open(original_io_open))
        patch.setattr(os, "open", os_open)
        for operation in ("mkdir", "touch", "write_text", "write_bytes", "unlink", "rename", "replace"):
            patch.setattr(Path, operation, denied)
        patch.setattr(socket.socket, "connect", denied)
        patch.setattr(subprocess, "Popen", denied)
        patch.setattr(asyncio, "create_subprocess_exec", denied)
        patch.setattr(asyncio, "create_task", denied)
        patch.setattr(asyncio.get_running_loop(), "create_task", denied)
        patch.setattr(PolymarketPaperCopyBot, "init", denied)
        yield


@pytest.mark.anyio
async def test_cold_reads_preserve_all_history_without_initializing_or_writing(tmp_path, monkeypatch):
    monkeypatch.setenv("POLYMARKET_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("POLYMARKET_AUTO_START", "true")
    monkeypatch.setenv("LIVE_TRADING", "true")
    _save_evidence(tmp_path / "user-7", count=5000)
    manager = PolymarketBotManager()
    event_loop_thread = threading.get_ident()
    original_metrics = PolymarketPaperCopyBot._metrics

    def checked_metrics(bot):
        assert threading.get_ident() != event_loop_thread
        return original_metrics(bot)

    monkeypatch.setattr(PolymarketPaperCopyBot, "_metrics", checked_metrics)
    with _deny_side_effects(monkeypatch):
        state = await manager.read_state(7)
        history = await manager.read_history(7, 200)
    assert state.read_source == "persisted"
    assert state.metrics.total_trades == 5000
    assert state.metrics.total_pnl == 17
    assert len(state.trade_history) == 50
    assert len(history.paper_trades) == 200
    assert history.paper_trades[0].id == "paper-4999"
    assert state.config.auto_start is True and state.config.paused is True
    assert state.live.balance.account_value_usd is None
    assert state.live.balance.available_balance_usd is None
    assert state.live.balance.status == "unavailable"
    assert manager._bots == {}


@pytest.mark.anyio
async def test_brand_new_user_gets_explicit_unavailable_snapshot_without_creating_files(tmp_path, monkeypatch):
    base = tmp_path / "absent"
    monkeypatch.setenv("POLYMARKET_DATA_DIR", str(base))
    manager = PolymarketBotManager()
    with _deny_side_effects(monkeypatch):
        state = await manager.read_state(7)
        history = await manager.read_history(7, 100)
    assert state.read_source == history.read_source == "unavailable"
    assert "No saved CopyTrader snapshot" in state.read_message
    assert state.live.balance.available_balance_usd is None
    assert not base.exists()
    assert manager._bots == {}


@pytest.mark.anyio
async def test_warm_read_with_busy_lock_and_dead_poller_never_repairs_or_logs(tmp_path, monkeypatch):
    monkeypatch.setenv("POLYMARKET_DATA_DIR", str(tmp_path))
    manager = PolymarketBotManager()
    bot = _warm_bot()
    bot.running = True
    bot.trade_history = [_paper(pnl=23)]
    bot._poll_task = SimpleNamespace(done=lambda: True)
    manager._bots[7] = _LoopBoundBot(bot, asyncio.get_running_loop())
    with _deny_side_effects(monkeypatch):
        original = await manager.read_state(7)
    await bot._lock.acquire()
    try:
        with _deny_side_effects(monkeypatch):
            state = await manager.read_state(7)
            with pytest.raises(PassiveProjectionUnavailable, match="history is busy"):
                await manager.read_history(7, 100)
        assert state.running is True
        assert state.metrics.total_pnl == 23
        assert "last captured snapshot" in state.read_message
        assert state.server_now == original.server_now
        assert bot.recent_activity == []
        assert bot._lock.locked()
        assert bot._balance_task is bot._forced_redeem_claim_task is None
    finally:
        bot._lock.release()


@pytest.mark.anyio
async def test_busy_runtime_without_a_prior_coherent_snapshot_is_explicitly_unavailable(monkeypatch):
    manager = PolymarketBotManager()
    bot = _warm_bot()
    manager._bots[7] = _LoopBoundBot(bot, asyncio.get_running_loop())
    await bot._lock.acquire()
    try:
        with _deny_side_effects(monkeypatch):
            with pytest.raises(PassiveProjectionUnavailable, match="no coherent cached snapshot"):
                await manager.read_state(7)
    finally:
        bot._lock.release()


@pytest.mark.anyio
async def test_concurrent_warm_reads_coalesce_and_remain_detached_from_mutations(monkeypatch):
    manager = PolymarketBotManager()
    bot = _warm_bot()
    bot.trade_history = [_paper(pnl=17)]
    manager._bots[7] = _LoopBoundBot(bot, asyncio.get_running_loop())
    entered = threading.Event()
    release = threading.Event()
    original = bot.get_state_snapshot
    calls = 0

    def blocked_projection(**kwargs):
        nonlocal calls
        calls += 1
        entered.set()
        assert release.wait(2)
        return original(**kwargs)

    monkeypatch.setattr(bot, "get_state_snapshot", blocked_projection)
    first = asyncio.create_task(manager.read_state(7))
    assert await asyncio.to_thread(entered.wait, 1)
    second = asyncio.create_task(manager.read_state(7))
    mutated = False

    async def mutate():
        nonlocal mutated
        async with bot._lock:
            bot.trade_history[0].realized_pnl = 999
            bot.config.paused = not bot.config.paused
            mutated = True

    writer = asyncio.create_task(mutate())
    paused_before = bot.config.paused
    with _deny_side_effects(monkeypatch):
        await asyncio.sleep(0)
        assert bot._lock.locked()
        assert mutated is False
        release.set()
        one = await first
        two = await second
        await writer
    assert calls == 1
    assert one.metrics.total_pnl == two.metrics.total_pnl == 17
    assert one.trade_history[0].realized_pnl == 17
    assert one.config.paused is paused_before
    assert mutated is True
    assert bot.trade_history[0].realized_pnl == 999
    # Neither a response nor a coalesced waiter may mutate the private cache.
    one.trade_history[0].realized_pnl = -55
    one.config.paused = not paused_before
    assert two.trade_history[0].realized_pnl == 17
    assert two.config.paused is paused_before
    await bot._lock.acquire()
    try:
        cached = await manager.read_state(7)
        assert cached.trade_history[0].realized_pnl == 17
        assert cached.config.paused is paused_before
    finally:
        bot._lock.release()


@pytest.mark.anyio
async def test_cancelled_reader_holds_lock_until_projection_finishes(monkeypatch):
    manager = PolymarketBotManager()
    bot = _warm_bot()
    entry = _LoopBoundBot(bot, asyncio.get_running_loop())
    manager._bots[7] = entry
    entered = threading.Event()
    release = threading.Event()
    original = bot.get_state_snapshot

    def blocked_projection(**kwargs):
        entered.set()
        assert release.wait(2)
        return original(**kwargs)

    monkeypatch.setattr(bot, "get_state_snapshot", blocked_projection)
    reader = asyncio.create_task(manager.read_state(7))
    assert await asyncio.to_thread(entered.wait, 1)
    reader.cancel()
    with pytest.raises(asyncio.CancelledError):
        await reader
    assert bot._lock.locked()
    future = entry.display_future
    release.set()
    await future
    assert not bot._lock.locked()
    assert entry.display_snapshot is not None
    assert entry.display_future is None


@pytest.mark.anyio
async def test_cold_read_coalescing_and_capacity_bound(monkeypatch):
    manager = PolymarketBotManager()
    entered = threading.Event()
    release = threading.Event()
    calls = 0
    monkeypatch.setattr(service_module, "MAX_CONCURRENT_COLD_READS", 1)

    def project():
        nonlocal calls
        calls += 1
        entered.set()
        assert release.wait(2)
        return "synthetic evidence"

    first = asyncio.create_task(manager._read_cold((7, "state"), project))
    assert await asyncio.to_thread(entered.wait, 1)
    second = asyncio.create_task(manager._read_cold((7, "state"), project))
    with _deny_side_effects(monkeypatch):
        await asyncio.sleep(0)
        with pytest.raises(PassiveProjectionUnavailable, match="snapshots are busy"):
            await manager._read_cold((8, "state"), project)
        release.set()
        assert await first == await second == "synthetic evidence"
    assert calls == 1
    assert manager._passive_jobs == {}


@pytest.mark.anyio
async def test_cancelled_cold_reader_keeps_admission_until_projection_finishes(monkeypatch):
    manager = PolymarketBotManager()
    entered = threading.Event()
    release = threading.Event()

    def project():
        entered.set()
        assert release.wait(2)
        return "synthetic"

    first = asyncio.create_task(manager._read_cold((7, "state"), project))
    assert await asyncio.to_thread(entered.wait, 1)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    with pytest.raises(PassiveProjectionUnavailable, match="snapshots are busy"):
        await manager._read_cold((8, "state"), project)
    future = next(iter(manager._passive_jobs.values()))
    release.set()
    await future
    assert manager._passive_jobs == {}


@pytest.mark.anyio
async def test_coalesced_cold_responses_do_not_share_nested_history(monkeypatch):
    from app.domains.polymarket.schemas import PolymarketHistoryResponse

    manager = PolymarketBotManager()
    entered = threading.Event()
    release = threading.Event()
    original = PolymarketHistoryResponse(paper_trades=[_paper(pnl=17)])

    def project():
        entered.set()
        assert release.wait(2)
        return original

    first = asyncio.create_task(manager._read_cold((7, "history", 100), project))
    assert await asyncio.to_thread(entered.wait, 1)
    second = asyncio.create_task(manager._read_cold((7, "history", 100), project))
    await asyncio.sleep(0)
    release.set()
    one, two = await asyncio.gather(first, second)
    one.paper_trades[0].realized_pnl = -55
    assert two.paper_trades[0].realized_pnl == original.paper_trades[0].realized_pnl == 17


@pytest.mark.parametrize("reader", ["state", "history"])
def test_aggregate_byte_budget_rejects_before_any_json_decode(tmp_path, monkeypatch, reader):
    monkeypatch.setenv("POLYMARKET_DATA_DIR", str(tmp_path))
    directory = tmp_path / "user-7"
    _save_evidence(directory)
    (directory / "polymarket-trades.json").write_text("[]" + " " * 598)
    (directory / "polymarket-live-trades.json").write_text("[]" + " " * 598)
    monkeypatch.setattr(passive_projection, "MAX_PASSIVE_TOTAL_BYTES", 1000)
    monkeypatch.setattr(passive_projection.json, "loads", lambda *_: pytest.fail("Oversized combined evidence was decoded"))
    with pytest.raises(PassiveProjectionUnavailable, match="aggregate passive read limit"):
        if reader == "state":
            passive_projection.read_persisted_state(7)
        else:
            passive_projection.read_persisted_history(7, 100)


def test_optional_config_counts_toward_total_before_decode(tmp_path, monkeypatch):
    monkeypatch.setenv("POLYMARKET_DATA_DIR", str(tmp_path))
    directory = tmp_path / "user-7"
    _save_evidence(directory, count=0)
    (directory / "polymarket-config.json").write_text("{}" + " " * 995)
    monkeypatch.setattr(passive_projection, "MAX_PASSIVE_TOTAL_BYTES", 1000)
    monkeypatch.setattr(passive_projection.json, "loads", lambda *_: pytest.fail("Oversized combined evidence was decoded"))
    with pytest.raises(PassiveProjectionUnavailable, match="aggregate passive read limit"):
        passive_projection.read_persisted_state(7)


def test_actual_read_bytes_charge_shared_budget_when_files_grow(tmp_path, monkeypatch):
    monkeypatch.setenv("POLYMARKET_DATA_DIR", str(tmp_path))
    directory = tmp_path / "user-7"
    _save_evidence(directory, count=0)
    (directory / "polymarket-trades.json").write_text("[]" + " " * 598)
    (directory / "polymarket-live-trades.json").write_text("[]" + " " * 598)
    original_stat = Path.stat

    def earlier_size(path, *args, **kwargs):
        metadata = original_stat(path, *args, **kwargs)
        return SimpleNamespace(st_size=2, st_mode=metadata.st_mode)

    monkeypatch.setattr(Path, "stat", earlier_size)
    monkeypatch.setattr(passive_projection, "MAX_PASSIVE_TOTAL_BYTES", 1000)
    with pytest.raises(PassiveProjectionUnavailable, match="aggregate passive read limit"):
        passive_projection.read_persisted_history(7, 100)


@pytest.mark.anyio
async def test_user_and_loop_isolation_never_reuses_another_runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("POLYMARKET_DATA_DIR", str(tmp_path))
    manager = PolymarketBotManager()
    bot = _warm_bot()
    bot.trade_history = [_paper(pnl=99)]
    manager._bots[7] = _LoopBoundBot(bot, asyncio.get_running_loop())
    with _deny_side_effects(monkeypatch):
        other = await manager.read_state(8)
        assert other.read_source == "unavailable"
        assert other.trade_history == []
        manager._bots[7] = _LoopBoundBot(bot, object())
        cold = await manager.read_state(7)
    assert cold.read_source == "unavailable"
    assert cold.trade_history == []
    assert manager._bots[7].bot is bot


@pytest.mark.anyio
@pytest.mark.parametrize("damage", ["missing", "json", "shape", "record", "oversize", "nested"])
async def test_incomplete_evidence_is_503_not_fake_zero(tmp_path, monkeypatch, damage):
    monkeypatch.setenv("POLYMARKET_DATA_DIR", str(tmp_path))
    directory = tmp_path / "user-7"
    _save_evidence(directory)
    path = directory / "polymarket-trades.json"
    if damage == "missing":
        path.unlink()
    else:
        path.write_text({"json": "{broken", "shape": "{}", "record": "[{}]", "oversize": " " * 1025, "nested": "[" * 1100 + "]" * 1100}[damage])
    if damage == "oversize":
        monkeypatch.setattr(passive_projection, "MAX_PASSIVE_TOTAL_BYTES", 1024)
    app = FastAPI()
    app.include_router(router_module.router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=7)
    monkeypatch.setattr(router_module, "polymarket_bot_manager", PolymarketBotManager())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://synthetic") as client:
        with _deny_side_effects(monkeypatch):
            for route in ("state", "history"):
                response = await client.get(f"/polymarket/{route}")
                assert response.status_code == 503
                assert "metrics" not in response.json()
                assert "Saved polymarket-trades.json" in response.json()["detail"]


@pytest.mark.anyio
async def test_read_routes_never_call_operational_manager(tmp_path, monkeypatch):
    monkeypatch.setenv("POLYMARKET_DATA_DIR", str(tmp_path))
    manager = PolymarketBotManager()
    monkeypatch.setattr(manager, "get_bot", lambda *_: pytest.fail("Operational get_bot called"))
    monkeypatch.setattr(router_module, "polymarket_bot_manager", manager)
    with _deny_side_effects(monkeypatch):
        state = await router_module.get_polymarket_state(SimpleNamespace(id=7))
        history = await router_module.get_polymarket_history(limit=100, current_user=SimpleNamespace(id=7))
    assert state.read_source == history.read_source == "unavailable"


@pytest.mark.anyio
async def test_null_config_is_not_silently_replaced_with_environment_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("POLYMARKET_DATA_DIR", str(tmp_path))
    directory = tmp_path / "user-7"
    _save_evidence(directory)
    (directory / "polymarket-config.json").write_text("null")
    with _deny_side_effects(monkeypatch):
        with pytest.raises(PassiveProjectionUnavailable, match="config.json is invalid"):
            await PolymarketBotManager().read_state(7)


@pytest.mark.anyio
@pytest.mark.parametrize("age,expected_ok", [(0, True), (600, False)])
async def test_passive_display_uses_matching_cache_and_preserves_stale_evidence(monkeypatch, age, expected_ok):
    wallet = "0x" + "a" * 40
    snapshot = BullpenPositionsSnapshot(
        payload={"positions": [], "summary": {"cash_balance": 12.34}},
        fetched_at=(datetime.now(UTC) - timedelta(seconds=age)).isoformat(),
        account_identity=wallet,
        diagnostics=BullpenCommandDiagnostics(command_category="positions", pid=1, effective_home="/synthetic"),
    )

    class Broker:
        async def read_display_positions_snapshot(self, *, delete_invalid):
            assert delete_invalid is False
            return snapshot
        async def read_cached_positions_snapshot(self, *, delete_invalid):
            assert delete_invalid is False
            return None
        def __getattr__(self, name):
            raise AssertionError(f"Passive route used {name}")

    monkeypatch.setattr(router_module, "get_bullpen_runtime_broker", Broker)
    monkeypatch.setattr(router_module, "read_public_display_wallet_snapshot", lambda *_args, **_kwargs: pytest.fail("Provider refresh"))
    with _deny_side_effects(monkeypatch):
        response = await router_module.get_bullpen_runtime_display_positions(
            force_fresh=False, passive=True, caller_source="synthetic", max_age_seconds=20,
            expected_account_identity=wallet, current_user=SimpleNamespace(id=7),
        )
    assert response.ok is expected_ok
    visible = response.snapshot if expected_ok else response.stale_snapshot
    assert visible.payload["summary"]["cash_balance"] == 12.34
    assert response.error is None if expected_ok else "do not refresh" in response.error
