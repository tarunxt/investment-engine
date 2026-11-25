"""Schedule a single bounded, read-only paper cycle per owner and exchange candle."""
import asyncio
import logging
from datetime import datetime, time
from uuid import uuid4

from app.domains.zerodha.upstox_quote_guard import redis_client, RELEASE
from app.infrastructure.messaging.celery_app import celery
from app.infrastructure.database.session import AsyncSessionLocal, async_engine
from .worker import INDIA, owners, run, monitor

log = logging.getLogger(__name__)
TASK = "app.domains.bottom_fishing.tasks.advance_paper"


async def advance(owner, end, exits_only):
    stamp = datetime.fromisoformat(end)
    now = datetime.now(INDIA)
    if stamp.tzinfo is None or not 0 <= (now-stamp).total_seconds()<300:
        return
    token = uuid4().hex
    key = f"bottom:worker:{owner}"
    try:
        async with redis_client() as cache:
            if not await cache.set(key,token,nx=True,ex=245):
                if exits_only:
                    return
                raise RuntimeError("Previous paper cycle is finishing")
            try:
                if exits_only:
                    await monitor(AsyncSessionLocal,owner)
                else:
                    await run(AsyncSessionLocal,owner,stamp)
            finally:
                await cache.eval(RELEASE,1,key,token)
    finally:
        await async_engine.dispose()


@celery.task(name=TASK,bind=True,max_retries=2,soft_time_limit=225,time_limit=240,acks_late=True)
def advance_paper(self, owner:int, end:str, exits_only:bool=False):
    try:
        asyncio.run(advance(owner,end,exits_only))
    except Exception as exc:
        raise self.retry(exc=exc,countdown=15)


async def serve(sessions):
    """Recovery deployments have no Beat. The API only enqueues work under a shared lease."""
    while True:
        await asyncio.sleep(5)
        now = datetime.now(INDIA)
        stamp = now.replace(minute=now.minute-now.minute%5,second=0,microsecond=0)
        if not time(9,20)<=stamp.time()<=time(15,30):
            continue
        try:
            async with redis_client() as cache:
                bucket = int(now.timestamp()) // 20
                for owner in await owners(sessions):
                    if (now-stamp).total_seconds()>20 and await cache.exists(f"bottom:monitor:{owner}"):
                        if await cache.set(f"bottom:exit-tick:{owner}:{bucket}","1",nx=True,ex=40):
                            await asyncio.to_thread(advance_paper.apply_async,args=(owner,stamp.isoformat(),True),expires=18)
                    if (now-stamp).total_seconds()>100:
                        continue
                    key = f"bottom:dispatch:{owner}:{stamp.isoformat()}"
                    if not await cache.set(key,"1",nx=True,ex=300):
                        continue
                    try:
                        await asyncio.to_thread(advance_paper.apply_async,args=(owner,stamp.isoformat()),expires=170)
                    except Exception:
                        await cache.delete(key)
                        raise
        except Exception:
            log.exception("Bottom Fishing scheduler failed")
