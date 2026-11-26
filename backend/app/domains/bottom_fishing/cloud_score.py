"""Run the scorecard with the same discoveries and closed candles as its screen."""
import asyncio
from datetime import datetime

import httpx

from . import market
from .engine import paper_cycle, roll

FILTERS = ("universe", "liquidity", "touches", "rebound", "proximity")


async def finish_screen(client, cache, guard, instruments, settings, stamp, calendar, report, previous):
    cutoff = stamp.isoformat()
    rows = {"NSE:" + row["symbol"]: row for row in report["rows"] if row["exchange"] == "NSE"}
    state = roll({}, stamp)
    if previous.get("day") == state["day"] and (previous.get("at") or "") <= cutoff:
        state["setups"] = {k: dict(v) for k, v in previous.get("setups", {}).items() if k in rows}
    levels, benchmark, series = {}, None, {}
    coverage = {"universe": 0, "covered": 0}
    if rows:
        try:
            async with asyncio.timeout(65):
                levels, benchmark, coverage = await market.daily(client, cache, stamp, list(rows.values()))
        except (httpx.HTTPError, ValueError, KeyError, TimeoutError) as exc:
            report["error"] = f"Daily history unavailable ({type(exc).__name__})."

    gate = asyncio.Semaphore(4)

    async def get_bars(key):
        try:
            async with gate:
                bars = await market.candles(client, instruments[key], stamp, guard)
        except (httpx.HTTPError, KeyError, ValueError):
            return
        if bars and bars[-1]["end"] == cutoff:
            series[key] = bars
            row = rows.get(key)
            if row and "low" in row:
                close = bars[-1]["close"]
                row.update(close=close, proximity=row["low"] <= close <= row["low"] + .15*(row["high"]-row["low"]))

    try:
        async with asyncio.timeout(25):
            await asyncio.gather(*(get_bars(k) for k, row in rows.items() if "low" in row or k in state["setups"]))
    except TimeoutError:
        report["error"] = "Some discovery candles were unavailable before the deadline."

    qualified = {k for k, row in rows.items() if all(row.get(flag) is True for flag in FILTERS)}
    selected = {k: levels[k] for k in qualified if k in levels}
    candidates = qualified | set(state["setups"])
    facts = {}

    async def get_facts(key):
        try:
            async with gate:
                facts[key] = await market.facts(client, cache, key)
        except (httpx.HTTPError, ValueError, KeyError, IndexError):
            pass  # The scorecard records an explicit missing-evidence decision.

    if candidates and "bottom" in settings["inputs"]:
        try:
            async with asyncio.timeout(35):
                await asyncio.gather(get_bars(market.BENCH), *(get_facts(k) for k in candidates if k in series))
        except TimeoutError:
            pass  # Keep individual results already received.

    coverage.update(patterns=len(selected), current_candles=sum(k in series for k in selected))
    paper_cycle(state, settings, stamp, selected, series, facts, benchmark, coverage, calendar, preview=True)
    if "bottom" in settings["inputs"]:
        for key in sorted(qualified - selected.keys() - state["setups"].keys()):
            state["rows"].append(dict(symbol=key, sources=["bottom"], reason="Missing verified support levels"))
    incomplete = any(row["reason"].startswith("Missing ") for row in state["rows"])
    screen_partial = (not report["complete"] or bool(report.get("error")) or
                      any(any(flag not in row for flag in FILTERS) for row in rows.values()))
    state.update(market_as_of=cutoff, original_results=report, sync=dict(at=cutoff, **coverage),
                 screen_query=dict(text=settings["screen_query"], latest_results=settings.get("latest_results", False)),
                 screen_status="partial" if screen_partial else "completed",
                 score_status="partial" if incomplete else "completed", scored_at=datetime.now(market.INDIA).isoformat(),
                 status="partial" if screen_partial or incomplete else "completed")
    return state
