"""Run the scorecard with the same discoveries and closed candles as its screen."""
import asyncio
from datetime import datetime

import httpx

from . import market, score_inputs
from .engine import paper_cycle, roll
from .discovery import FLAGS as FILTERS, Discovery, passed, proximity


async def finish_screen(client, cache, guard, instruments, settings, stamp, calendar, report, previous):
    rules = Discovery.model_validate(settings.get("discovery", {}))
    cutoff = stamp.isoformat()
    rows = {"NSE:" + row["symbol"]: row for row in report["rows"] if row["exchange"] == "NSE"}
    native = set(rows)
    plan = settings.get("score_inputs")
    if plan:
        for key in plan["sources"]:
            if key.startswith("NSE:"):
                rows.setdefault(key, dict(exchange="NSE", symbol=key[4:]))
    allowed = score_inputs.apply_candidates(settings, native, rows)
    state = roll({}, stamp)
    if (previous.get("day") == state["day"] and (previous.get("at") or "") <= cutoff
            and (previous.get("discovery") or Discovery().model_dump()) == rules.model_dump()):
        state["setups"] = {k: dict(v) for k, v in previous.get("setups", {}).items() if k in allowed and v.get("isin")
                           and instruments.get(k) == "NSE_EQ|" + v["isin"]}
    levels, benchmark, series = {}, None, {}
    coverage = {"universe": 0, "covered": 0}
    if rows:
        try:
            async with asyncio.timeout(65):
                levels, benchmark, coverage = await market.daily(client, cache, stamp, list(rows.values()), discovery=rules.model_dump())
        except (httpx.HTTPError, ValueError, KeyError, TimeoutError) as exc:
            report["error"] = f"Daily history unavailable ({type(exc).__name__})."

    # The configurable universe filter may be optional, but an issuer mismatch never is.
    for key in list(state["setups"]):
        if rows[key].get("identity_matches") is False:
            del state["setups"][key]

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
                row.update(close=close, proximity=proximity(dict(row, close_formula=rules.formulas["proximity"]), close))

    try:
        async with asyncio.timeout(25):
            await asyncio.gather(*(get_bars(k) for k, row in rows.items() if "low" in row or k in state["setups"]))
    except TimeoutError:
        report["error"] = "Some discovery candles were unavailable before the deadline."

    qualified = {k for k, row in rows.items() if passed(row, rules.minimum)}
    for row in report["rows"]:
        row["qualified"] = passed(row, rules.minimum)
    report["minimum"] = rules.minimum
    qualified.intersection_update(allowed)
    selected = {k: levels[k] for k in qualified if k in levels}
    # A selected listing with a viable daily pattern still needs its closed candle
    # before the final discovery filter can decide. Keep it visible without qualifying it.
    awaiting_candle = {key for key in allowed if key in levels and key not in series}
    candidates = qualified | set(state["setups"])
    facts = {}

    async def get_facts(key):
        try:
            async with gate:
                facts[key] = await market.facts(client, cache, key)
        except (httpx.HTTPError, ValueError, KeyError, IndexError):
            pass  # The scorecard records an explicit missing-evidence decision.

    effective_settings = score_inputs.scoring_settings(settings)
    if candidates and "bottom" in effective_settings["inputs"]:
        try:
            async with asyncio.timeout(35):
                await asyncio.gather(get_bars(market.BENCH), *(get_facts(k) for k in candidates if k in series))
        except TimeoutError:
            pass  # Keep individual results already received.

    coverage.update(patterns=len(selected), current_candles=sum(k in series for k in selected))
    paper_cycle(state, effective_settings, stamp, selected, series, facts, benchmark, coverage, calendar, preview=True)
    if "bottom" in effective_settings["inputs"]:
        for key in sorted((qualified | awaiting_candle) - {r["symbol"] for r in state["rows"]}):
            state["rows"].append(dict(symbol=key, sources=["bottom"], reason="Missing current closed candle" if key not in series else "Missing verified support levels"))
    score_inputs.record_inputs(state, settings, native)
    incomplete = any(row["reason"].startswith("Missing ") for row in state["rows"])
    screen_partial = (not report["complete"] or bool(report.get("error")) or
                      any(any(row.get(flag) is None for flag in FILTERS) for key,row in rows.items() if key in native))
    state.update(discovery=rules.model_dump(), market_as_of=cutoff, original_results=report, sync=dict(at=cutoff, **coverage),
                 screen_query=dict(text=settings["screen_query"], latest_results=settings.get("latest_results", False)),
                 screen_status="partial" if screen_partial else "completed",
                 score_status="partial" if incomplete else "completed", scored_at=datetime.now(market.INDIA).isoformat(),
                 status="partial" if screen_partial or incomplete else "completed")
    return state
