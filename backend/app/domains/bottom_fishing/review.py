"""One manual, read-only review per request. Results are separate from the paper ledger."""
import asyncio
import json
import logging
import os
from datetime import datetime, time, timedelta
from uuid import uuid4

import httpx
from sqlalchemy import select

from app.domains.auth.models import ActivityLog, User
from app.domains.scorecards.technical_sources import session_calendar
from app.domains.zerodha.upstox_quote_guard import QuoteGuard, redis_client
from app.domains.zerodha.upstox_quotes import configured_for
from . import market, store
from .query_evidence import apply_screen
from .engine import paper_cycle, roll, size_entries
from .worker import INDIA, collect_evidence, prepared_market

log = logging.getLogger(__name__)


class ManualReviewQuoteGuard(QuoteGuard):
    # Distribute one review across the shared 200/minute budget and leave room
    # for the dashboard and other workers. Redis still decides every admission.
    interval = 0.35

    def __init__(self, *args):
        super().__init__(*args)
        self._pacing_lock = asyncio.Lock()
        self._next_request = 0.0

    async def admit(self):
        clock = asyncio.get_running_loop().time
        async with self._pacing_lock:
            delay = self._next_request - clock()
            if delay > 0:
                await asyncio.sleep(delay)
            self._next_request = clock() + self.interval
            return await super().admit()


def candle_cutoff(now, holidays):
    calendar = session_calendar(now.replace(hour=23, minute=59), "NSE", holidays, 60)
    if not calendar:
        raise ValueError("No verified NSE session in the exchange calendar")
    day = now.date().isoformat()
    close = calendar.get(day)
    # Special trading sessions have their own hours. Use their verified closing
    # candle once published instead of assuming a regular-session opening time.
    if close and now.time() >= time(9, 20) and datetime.fromisoformat(close).time() == time(15, 30):
        closed = now.replace(minute=now.minute - now.minute % 5, second=0, microsecond=0)
        return min(closed, datetime.fromisoformat(close)), calendar
    previous = [datetime.fromisoformat(v) for v in calendar.values() if datetime.fromisoformat(v) <= now]
    if not previous:
        raise ValueError("No completed NSE candle available")
    return previous[-1], calendar


async def sync_kite_portfolio(owner):
    from app.domains.zerodha.tasks import sync_portfolio_snapshot_task

    task = await asyncio.to_thread(sync_portfolio_snapshot_task.delay, owner, "bottom_fishing")
    result = await asyncio.to_thread(task.get, timeout=300)
    if result.get("status") != "completed":
        reason = result.get("reason", "sync failed")
        if reason in {"session_expired", "not_connected", "missing_token"}:
            raise ValueError("Connect Kite on the India Portfolio page and run Bottom Fishing again.")
        raise ValueError("Kite portfolio sync failed. Check the Zerodha sync history.")
    return {key: result[key] for key in ("captured_at", "holdings_count", "holdings",
                                         "holdings_market_value", "holdings_pnl", "available_margin") if key in result}


async def execute_review(sessions, owner, request_id):
    token = uuid4().hex
    now = datetime.now(INDIA)
    async with sessions() as db:
        await store.lock(db, owner)
        record = await db.get(ActivityLog, request_id)
        if not record or record.user_id != owner or record.action != store.MANUAL:
            return
        job = json.loads(record.details)
        if job["status"] != "queued" and not (job["status"] == "running" and job["lease_until"] <= now.isoformat()):
            return
        username = await db.scalar(select(User.username).where(User.id == owner))
        if "settings" in job:
            version, settings = job["version"], job["settings"]
        else:
            version, settings = await store.latest(db, owner, store.CONFIG, store.Settings().model_dump())
            job.update(version=version, settings=settings)
        _, portfolio = await store.latest(db, owner, store.CYCLE, {})
        job.update(status="running", stage="sync", token=token, attempts=job.get("attempts",0)+1,
                   started_at=now.isoformat(), lease_until=(now+timedelta(minutes=12)).isoformat())
        record.details = json.dumps(job)
        await db.commit()

    state = {}
    phase = "Kite portfolio sync"
    async def checkpoint(stage=None, *, finish=False):
        async with sessions() as db:
            await store.lock(db, owner)
            record = await db.get(ActivityLog, request_id)
            current = json.loads(record.details)
            if current.get("token") != token:
                raise RuntimeError("Review claim expired")
            if finish:
                finished = datetime.now(INDIA).isoformat()
                result = dict(request_id=request_id, mode="Manual review", finished_at=finished,
                              settings=settings, version=version, state=state)
                store.append(db, owner, store.REVIEW, result)
                current.update(status=state["status"], finished_at=finished, error=state.get("error"))
                current.pop("token", None)
                current.pop("lease_until", None)
            else:
                current["stage"] = stage
                current["kite_sync"] = state["kite_sync"]
            record.details = json.dumps(current)
            await db.commit()

    try:
        if job["attempts"] > 2:
            raise ValueError("Worker interrupted twice before this review could finish")
        kite = job.get("kite_sync") or await sync_kite_portfolio(owner)
        state["kite_sync"] = kite
        await checkpoint("screen")
        phase = "market analysis"
        if not configured_for(owner,username):
            raise ValueError("Market data unavailable for this account")
        async with asyncio.timeout(525), redis_client() as cache, httpx.AsyncClient(
                timeout=12, follow_redirects=False,
                headers={"User-Agent":"Cred-X market research (https://cred-x.in)"}) as client:
            holidays = await market.calendar(client,cache,now)
            stamp, calendar = candle_cutoff(now,holidays)
            state = roll(portfolio, stamp)
            # Preserve the paper portfolio and same-session setups, but never
            # report an earlier run's rows or stage completions as this review's.
            state.update(rows=[], scans=[], at=None, sync=None, error=None, kite_sync=kite)
            state["market_as_of"] = stamp.isoformat()
            levels, benchmark, coverage = await prepared_market(client,cache,stamp)
            state["sync"] = dict(at=stamp.isoformat(), **coverage)
            guard = ManualReviewQuoteGuard(cache, os.getenv("UPSTOX_LTP_OWNER_USER_ID") or owner, "bottom-review", [])
            series, fundamentals = await collect_evidence(client,cache,guard,stamp,levels,state,coverage)
            levels = await apply_screen(client,cache,guard,settings,stamp,calendar,levels,series,state,coverage)
            await checkpoint("score")
            paper_cycle(state,settings,stamp,levels,series,fundamentals,benchmark,coverage,calendar,preview=True)
            await checkpoint("actionables")
            size_entries(state,settings,stamp,preview=True)
            if (coverage.get("query_missing",0) or coverage["covered"] < coverage["universe"] or coverage["current_candles"] < coverage["patterns"]
                    or any(row["reason"].startswith("Missing ") for row in state["rows"])):
                state["status"] = "partial"
    except Exception as exc:
        log.exception("Bottom Fishing review failed for request %s", request_id)
        if isinstance(exc, httpx.HTTPStatusError):
            reason = f"{exc.request.url.host} returned HTTP {exc.response.status_code}"
        elif isinstance(exc, ValueError):
            reason = str(exc)[:180]
        else:
            reason = type(exc).__name__
        state.update(status="failed", error=f"Review stopped during {phase}: {reason}")
    await checkpoint(finish=True)


async def drain_reviews(sessions):
    async with sessions() as db:
        jobs = [item async for item in store.ready_requests(db, datetime.now(INDIA))]
    for owner, request_id in jobs:
        await execute_review(sessions, owner, request_id)


async def serve_reviews(sessions, wake: asyncio.Event):
    """One wake signal per service lifespan, with database leases across processes."""
    while True:
        try:
            await asyncio.wait_for(wake.wait(), timeout=30)
        except TimeoutError:
            pass
        wake.clear()
        try:
            await drain_reviews(sessions)
        except Exception:
            log.exception("Bottom Fishing manual review sweep failed")
