"""Schedule a single bounded, read-only paper cycle per owner and exchange candle."""
import asyncio
import logging
import os
from datetime import datetime, time
from uuid import uuid4

from app.domains.zerodha.upstox_quote_guard import redis_client, RELEASE
from app.infrastructure.messaging.celery_app import celery
from app.infrastructure.database.session import AsyncSessionLocal, async_engine
from .worker import INDIA, owners, run, monitor

log = logging.getLogger(__name__)
TASK = "app.domains.bottom_fishing.tasks.advance_paper"


class PaperWorkerBusy(RuntimeError):
    pass


async def advance(sessions, owner, end, exits_only):
    stamp = datetime.fromisoformat(end)
    now = datetime.now(INDIA)
    if stamp.tzinfo is None or not 0 <= (now-stamp).total_seconds()<300:
        return
    token = uuid4().hex
    key = f"bottom:worker:{owner}"
    async with redis_client() as cache:
        if not await cache.set(key,token,nx=True,ex=245):
            if exits_only:
                return
            raise PaperWorkerBusy("Previous paper cycle is finishing")
        try:
            if exits_only:
                await monitor(sessions,owner)
            else:
                await run(sessions,owner,stamp)
        finally:
            await cache.eval(RELEASE,1,key,token)


@celery.task(name=TASK,bind=True,max_retries=2,soft_time_limit=225,time_limit=240,acks_late=True)
def advance_paper(self, owner:int, end:str, exits_only:bool=False, review_id:int | None=None):
    # Compatibility for messages queued by a previous deployment. Only the
    # authorized API service handles new cycles and exit ticks.
    if review_id is not None:
        return

    async def finish_queued():
        try:
            await advance(AsyncSessionLocal, owner, end, exits_only)
        finally:
            await async_engine.dispose()

    try:
        asyncio.run(finish_queued())
    except Exception as exc:
        raise self.retry(exc=exc, countdown=15)


async def scheduled_owner(sessions, owner, stamp, now):
    end = stamp.isoformat()
    elapsed = (now - stamp).total_seconds()
    try:
        async with redis_client() as cache:
            dispatch = f"bottom:dispatch:{owner}:{end}"
            token = uuid4().hex
            if elapsed <= 100 and await cache.set(dispatch, token, nx=True, ex=300):
                try:
                    async with asyncio.timeout(225):
                        await advance(sessions, owner, end, False)
                except PaperWorkerBusy:
                    await cache.eval(RELEASE, 1, dispatch, token)
                return
            if elapsed > 20 and await cache.exists(f"bottom:monitor:{owner}"):
                bucket = int(now.timestamp()) // 20
                if await cache.set(f"bottom:exit-tick:{owner}:{bucket}", "1", nx=True, ex=40):
                    async with asyncio.timeout(18):
                        await advance(sessions, owner, end, True)
    except Exception:
        log.exception("Scheduled paper work failed for owner %s at %s", owner, end)


async def serve(sessions):
    """Run paper market-data work in the same authorized service as manual reviews."""
    while True:
        await asyncio.sleep(5)
        if not os.getenv("UPSTOX_ANALYTICS_TOKEN"):
            continue
        now = datetime.now(INDIA)
        stamp = now.replace(minute=now.minute-now.minute%5,second=0,microsecond=0)
        if not time(9,20)<=stamp.time()<=time(15,30):
            continue
        try:
            await asyncio.gather(*(
                scheduled_owner(sessions, owner, stamp, now)
                for owner in await owners(sessions)
            ))
        except Exception:
            log.exception("Bottom Fishing scheduler failed")
