from __future__ import annotations

from collections.abc import Callable

import pytest

from app.domains.bullpen_trade_analysis import tasks
from app.domains.bullpen_trade_analysis.service import (
    BullpenTradeHistorySyncResult,
)


class _FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.closed = False

    def set(
        self,
        key: str,
        value: str,
        *,
        nx: bool = False,
        ex: int | None = None,
    ) -> bool:
        del ex
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True

    def get(self, key: str) -> str | None:
        return self.values.get(key)

    def eval(self, script: str, key_count: int, key: str, token: str) -> int:
        del script, key_count
        if self.values.get(key) != token:
            return 0
        del self.values[key]
        return 1

    def close(self) -> None:
        self.closed = True


def _patch_redis(
    monkeypatch,
    redis_factory: Callable[[], _FakeRedis],
) -> None:
    monkeypatch.setattr(
        tasks,
        "_trade_history_sync_redis_client",
        redis_factory,
    )


def test_history_sync_schedule_is_distributed_and_deduplicated(monkeypatch):
    redis_client = _FakeRedis()
    queued: list[dict[str, object]] = []
    _patch_redis(monkeypatch, lambda: redis_client)
    monkeypatch.setattr(
        tasks.refresh_bullpen_trade_analysis_history,
        "apply_async",
        lambda **kwargs: queued.append(kwargs),
    )

    assert tasks.request_bullpen_trade_analysis_history_sync(7) is True
    assert tasks.request_bullpen_trade_analysis_history_sync(7) is False
    assert len(queued) == 1
    assert queued[0]["queue"] == "ai"
    assert queued[0]["kwargs"]["user_id"] == 7


def test_history_sync_worker_executes_once_and_releases_owned_markers(monkeypatch):
    redis_client = _FakeRedis()
    pending_key = tasks._sync_key("pending", 7)
    redis_client.values[pending_key] = "request-1"
    calls: list[int] = []

    async def fake_sync(user_id: int) -> BullpenTradeHistorySyncResult:
        calls.append(user_id)
        return BullpenTradeHistorySyncResult(
            trade_history_succeeded=True,
            redeemed_history_succeeded=True,
            trade_count=1,
            redeemed_trade_count=0,
        )

    _patch_redis(monkeypatch, lambda: redis_client)
    monkeypatch.setattr(tasks, "sync_bullpen_trade_history_for_user", fake_sync)

    result = tasks.refresh_bullpen_trade_analysis_history.run(
        user_id=7,
        request_token="request-1",
    )

    assert result == "completed"
    assert calls == [7]
    assert redis_client.values == {}
    assert redis_client.closed is True


def test_duplicate_worker_does_not_execute_or_clear_active_pending_marker(monkeypatch):
    redis_client = _FakeRedis()
    pending_key = tasks._sync_key("pending", 7)
    lease_key = tasks._sync_key("lease", 7)
    redis_client.values[pending_key] = "request-1"
    redis_client.values[lease_key] = "request-1"
    calls: list[int] = []

    async def fake_sync(user_id: int) -> BullpenTradeHistorySyncResult:
        calls.append(user_id)
        return BullpenTradeHistorySyncResult(
            trade_history_succeeded=True,
            redeemed_history_succeeded=True,
            trade_count=1,
            redeemed_trade_count=0,
        )

    _patch_redis(monkeypatch, lambda: redis_client)
    monkeypatch.setattr(tasks, "sync_bullpen_trade_history_for_user", fake_sync)

    result = tasks.refresh_bullpen_trade_analysis_history.run(
        user_id=7,
        request_token="request-1",
    )

    assert result == "skipped_duplicate_worker"
    assert calls == []
    assert redis_client.values[pending_key] == "request-1"
    assert redis_client.values[lease_key] == "request-1"


def test_history_sync_worker_rejects_result_when_all_sources_are_invalid(
    monkeypatch,
):
    redis_client = _FakeRedis()
    pending_key = tasks._sync_key("pending", 7)
    redis_client.values[pending_key] = "request-1"

    async def fake_sync(_user_id: int) -> BullpenTradeHistorySyncResult:
        return BullpenTradeHistorySyncResult(
            trade_history_succeeded=False,
            redeemed_history_succeeded=False,
            trade_count=0,
            redeemed_trade_count=0,
        )

    _patch_redis(monkeypatch, lambda: redis_client)
    monkeypatch.setattr(tasks, "sync_bullpen_trade_history_for_user", fake_sync)

    with pytest.raises(RuntimeError, match="no valid source"):
        tasks.refresh_bullpen_trade_analysis_history.run(
            user_id=7,
            request_token="request-1",
        )

    assert redis_client.values == {}
