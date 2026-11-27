import json
from unittest.mock import AsyncMock

import pytest

from app.domains.bottom_fishing import display_worker as worker


@pytest.mark.asyncio
async def test_47_matches_keep_scan_values_and_reuse_sessions():
    rows = [dict(exchange="NSE", symbol=str(i), isin=str(i), columns={"Current price": 20})
            for i in range(47)]
    report = dict(rows=rows, history_day="2026-11-26", column_names=["Industry PE", "Net Profit latest quarter"])
    stamp = "2026-11-27T14:30:00+05:30"
    current = dict(status="ready", values={"Net Profit latest quarter": 0}, quarter="Sep 2026")
    previous = dict(session="2026-11-26", values={"Net Profit latest quarter": 10}, quarter="Jun 2026")
    entries = [json.dumps(current), json.dumps({"values":{"DMA 200":10}}), None,
               json.dumps({"status":"retry"}), None, json.dumps(previous)] + [None]*135
    cache = AsyncMock()
    ratios = [json.dumps({"status": "ready", "values": {"Industry PE": 22.5}}), None,
              json.dumps({"status": "retry"}), None] + [None]*90
    cache.mget.side_effect = lambda ks: entries if len(ks) == 141 else ratios
    await worker.overlay(cache, report, stamp)
    assert len(cache.mget.call_args.args[0]) == 94
    assert rows[0]["columns"]["Net Profit latest quarter"] == 0
    assert rows[0]["columns"]["Industry PE"] == 22.5
    assert "Industry PE" not in rows[0]["column_status"]
    assert rows[1]["columns"]["Net Profit latest quarter"] == 10
    assert rows[1]["issuer_quarter"] == "Jun 2026"
    assert rows[1]["column_status"]["Industry PE"] == "retry"
    assert rows[-1]["column_status"]["Industry PE"] == "loading"
    earlier = cache.mget.call_args.args[0]
    await worker.overlay(cache, report, stamp.replace("14:30", "14:35"))
    assert cache.mget.call_args.args[0] == earlier


@pytest.mark.asyncio
async def test_issuer_lock_and_retry_preserve_previous_result():
    cache = AsyncMock()
    cache.exists.return_value = False
    cache.set.return_value = False
    fetch = AsyncMock(side_effect=TimeoutError())
    await worker.resolve(cache, "A", fetch, session="today", last="last")
    fetch.assert_not_awaited()
    cache.set.return_value = True
    await worker.resolve(cache, "A", fetch, session="today", last="last")
    fetch.assert_awaited_once()
    assert cache.set.call_args.args[0] == "A"
    assert json.loads(cache.set.call_args.args[1])["status"] == "retry"
    cache.eval.assert_awaited_once()
