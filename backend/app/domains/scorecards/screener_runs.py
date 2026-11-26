"""Execute requested library queries through the same account-scoped market-data service as BFS."""
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import httpx
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import ActivityLog, User
from app.domains.bottom_fishing import market, store
from app.domains.bottom_fishing.cloud_screen import query_matches
from app.domains.bottom_fishing.review import candle_cutoff
from app.domains.bottom_fishing.worker import INDIA
from app.domains.zerodha.upstox_quote_guard import redis_client
from app.domains.zerodha.upstox_quotes import configured_for
from app.infrastructure.database.session import get_async_db
from .screener_library import CustomId, read_library, router

log = logging.getLogger(__name__)
PENDING, RUNNING, FINISHED = ("screeners.run." + name for name in ("pending", "running", "finished"))


async def latest_run(db, owner, key):
    return await db.scalar(select(ActivityLog).where(
        ActivityLog.user_id == owner, ActivityLog.resource_type == key,
        ActivityLog.action.in_((PENDING, RUNNING, FINISHED))).order_by(ActivityLog.id.desc()).limit(1))


def public_run(record):
    if not record:
        return None
    data = json.loads(record.details)
    return {k: data[k] for k in ("status", "market_as_of", "report", "error") if k in data}


@router.get("/{key}/result")
async def result(key: CustomId, db=Depends(get_async_db), user=Depends(get_current_user)):
    return public_run(await latest_run(db, user.id, key))


@router.post("/{key}/run", status_code=202)
async def request_run(key: CustomId, request: Request, db=Depends(get_async_db), user=Depends(get_current_user)):
    if not configured_for(user.id, user.username):
        raise HTTPException(409, "Market data is unavailable for this account.")
    await store.lock(db, user.id)
    _, library = await read_library(db, user.id)
    definition = next((item for item in library["custom"] if item["id"] == key), None)
    if not definition:
        raise HTTPException(404, "This screener is unavailable.")
    work = await latest_run(db, user.id, key)
    if not work or work.action == FINISHED:
        data = dict(status="queued", query=definition["query"], latest_results=definition["latest_results"])
        work = ActivityLog(user_id=user.id, action=PENDING, resource_type=key, details=json.dumps(data))
        db.add(work)
    response = public_run(work)
    await db.commit()
    request.app.state.screener_wake.set()
    return response


async def claim(sessions):
    now = datetime.now(timezone.utc)
    async with sessions() as db:
        rows = await db.scalars(select(ActivityLog).where(ActivityLog.action.in_((PENDING, RUNNING)))
                                .order_by(ActivityLog.id).with_for_update(skip_locked=True))
        for row in rows:
            data = json.loads(row.details)
            if row.action == RUNNING and data["lease_until"] > now.isoformat():
                continue
            data.update(status="running", token=uuid4().hex, attempts=data.get("attempts", 0) + 1,
                        lease_until=(now + timedelta(minutes=5)).isoformat())
            row.action, row.details = RUNNING, json.dumps(data)
            job = (row.id, row.user_id, data)
            await db.commit()
            return job
    return None


async def execute(sessions, record_id, owner, data):
    try:
        async with sessions() as db:
            username = await db.scalar(select(User.username).where(User.id == owner))
        if not configured_for(owner, username):
            raise ValueError("Market data is unavailable for this account.")
        if data["attempts"] > 2:
            raise ValueError("The scan was interrupted twice. Run it again.")
        async with asyncio.timeout(240), redis_client() as cache, httpx.AsyncClient(timeout=8) as client:
            now = datetime.now(INDIA)
            stamp, calendar = candle_cutoff(now, await market.calendar(client, cache, now))
            settings = dict(screen_query=data["query"], latest_results=data["latest_results"])
            report, _, _ = await query_matches(client, cache, owner, settings, stamp, calendar)
        output = dict(status="completed" if report["complete"] else "partial", market_as_of=stamp.isoformat(),
                      report={k: report[k] for k in ("rows", "total", "universe_size", "unknown")})
    except Exception as exc:
        log.exception("Library screener run %s failed", record_id)
        output = dict(status="failed", error=str(exc) if isinstance(exc, ValueError) else
                      f"Market-data scan failed ({type(exc).__name__}). Run it again.")
    async with sessions() as db:
        row = await db.get(ActivityLog, record_id, with_for_update=True)
        if row and row.action == RUNNING and json.loads(row.details)["token"] == data["token"]:
            row.action, row.details = FINISHED, json.dumps(output, allow_nan=False)
            await db.commit()


async def serve(sessions, wake):
    while True:
        try:
            job = await claim(sessions)
            if job:
                await execute(sessions, *job)
                continue
            await asyncio.wait_for(wake.wait(), timeout=30)
        except TimeoutError:
            pass
        except Exception:
            log.exception("Screener queue sweep failed")
            await asyncio.sleep(5)
        wake.clear()
