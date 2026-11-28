from datetime import datetime
from unittest.mock import AsyncMock

import pytest

from app.domains.bottom_fishing import cloud_score, market, store
from app.domains.bottom_fishing.engine import roll


@pytest.mark.asyncio
@pytest.mark.parametrize("carried", [False, True])
async def test_custom_selection_preserves_missing_candle_and_rejects_changed_issuer(monkeypatch, carried):
    stamp = datetime(2026, 11, 26, 15, 30, tzinfo=market.INDIA)
    key = "NSE:TEST"
    settings = store.Settings().model_dump()
    settings["score_inputs"] = dict(current=False, sources={key: ["custom"]},
                                    runs={"custom": [101]}, fingerprint="fixture")
    previous = roll({}, stamp)
    if carried:
        previous["setups"][key] = dict(isin="OLD", member=True, discovered=stamp.isoformat(), low=100)
    async def daily(client, cache, cutoff, rows, discovery):
        rows[0].update(universe=True, liquidity=True, touches=True, rebound=True, low=100, high=140)
        return {key: dict(isin="NEW")}, None, dict(universe=1, covered=1)
    monkeypatch.setattr(market, "daily", daily)
    monkeypatch.setattr(market, "candles", AsyncMock(return_value=[]))
    state = await cloud_score.finish_screen(None, None, None, {key: "NSE_EQ|NEW"}, settings,
                                            stamp, {}, dict(rows=[], complete=True), previous)
    assert key not in state["setups"]
    assert state["score_status"] == "partial"
    assert [(row["symbol"], row["reason"], row["sources"]) for row in state["rows"]] == [
        (key, "Missing current closed candle", ["custom"])]
    assert not state["pending"] and not state["positions"]


@pytest.mark.asyncio
async def test_discovery_retries_only_a_transient_read_inside_the_same_candle(monkeypatch):
    import httpx
    from datetime import timedelta
    from app.domains.bottom_fishing import worker

    stamp = datetime.now(market.INDIA)
    result = ({}, None, {"covered": 0})
    read = AsyncMock(side_effect=[httpx.ReadTimeout("fixture"), result])
    monkeypatch.setattr(worker, "prepared_market", read)
    assert await worker.discovery_market(None, None, stamp, {}) == result
    assert read.await_count == 2
    read.reset_mock(side_effect=True)
    read.side_effect = httpx.ReadTimeout("fixture")
    with pytest.raises(httpx.ReadTimeout):
        await worker.discovery_market(None, None, stamp-timedelta(minutes=3), {})
    assert read.await_count == 1


def test_failed_window_survives_later_ticks_and_clears_only_on_matching_scan():
    from datetime import timedelta
    from app.domains.bottom_fishing.worker import reconcile_discovery_coverage

    morning = datetime(2026, 11, 27, 9, 30, tzinfo=market.INDIA)
    afternoon = morning.replace(hour=13, minute=15)
    state = roll({}, morning)
    state["status"] = "failed"
    reconcile_discovery_coverage(state, morning, error="ReadTimeout during daily market inputs")
    assert state["status"] == "failed"

    state.update(status="completed", error=None)
    state["scans"].append({"at": afternoon.isoformat(), "covered": 495})
    reconcile_discovery_coverage(state, afternoon)
    assert state["status"] == "partial"
    assert list(state["discovery_failures"]) == [morning.isoformat()]
    assert state["positions"] == state["pending"] == {}
    assert "discovery_failures" not in roll(state, morning + timedelta(days=1))

    state.update(status="completed", error=None)
    state["scans"].append({"at": morning.isoformat(), "covered": 495})
    reconcile_discovery_coverage(state, morning)
    assert state["status"] == "completed"
    assert "discovery_failures" not in state
