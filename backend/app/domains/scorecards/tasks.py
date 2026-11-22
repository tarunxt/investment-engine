"""Compatibility for Technical evidence messages already published by earlier releases."""
import asyncio
import logging
from sqlalchemy import select

from app.infrastructure.messaging.celery_app import celery


log=logging.getLogger(__name__)


async def _recover(owner, output_id):
    from app.infrastructure.database.session import AsyncSessionLocal, async_engine
    from . import storage, technical_queue
    try:
        async with AsyncSessionLocal() as db:
            source=await storage.lookup(db,owner,"india","attempt",output_id,lock=True)
            if not source or source.data.get("card")!="technical" or not source.result_json:
                return
            await technical_queue.enqueue(db,source,source.result_json,immediate=True)
            await db.commit()
    finally:
        await async_engine.dispose()


@celery.task(bind=True,max_retries=2,soft_time_limit=90,time_limit=110,acks_late=True)
def recover_technical_history(self,owner,output_id):
    try:
        return asyncio.run(_recover(owner,output_id))
    except Exception as exc:
        raise self.retry(exc=exc,countdown=90*(self.request.retries+1))


async def _pair_repair(owner,output_id):
    from app.infrastructure.database.session import AsyncSessionLocal,async_engine
    from app.domains.auth.models import User
    from . import storage, pair_evidence
    try:
        async with AsyncSessionLocal() as db:
            source=await storage.lookup(db,owner,"india","attempt",output_id)
            if not source or source.data.get("card")!="pairwise" or not source.result_json:
                return output_id,0
            username=await db.scalar(select(User.username).where(User.id==owner))
            result=await pair_evidence.repair(db,source,owner,username)
            counts=result["pair_counts"]
            return result["id"],result.get("retry_after",0) if counts["ready"]<counts["listings"] else 0
    finally:
        await async_engine.dispose()


@celery.task(bind=True,max_retries=2,soft_time_limit=90,time_limit=110,acks_late=True)
def recover_pair_history(self,owner,output_id):
    try:
        current,wait=asyncio.run(_pair_repair(owner,output_id))
    except Exception as exc:
        log.exception("Pairwise evidence recovery failed for output %s",output_id)
        raise self.retry(exc=exc,countdown=90*(self.request.retries+1))
    if wait and self.request.retries<self.max_retries:
        raise self.retry(args=(owner,current),countdown=max(30,wait))
    return {"output_id":current}


@celery.task(soft_time_limit=200,time_limit=220,acks_late=True)
def warm_rebalance_sources(owner, revision_id):
    """Start the public-data backfill at Stage 2. This task creates no model jobs."""
    async def run():
        from app.infrastructure.database.session import AsyncSessionLocal, async_engine
        from app.domains.auth.models import User
        from . import storage
        from .rebalance_readiness import prepare
        try:
            async with AsyncSessionLocal() as db:
                rev=await storage.lookup(db,owner,"india","revision",revision_id)
                if rev:
                    username=await db.scalar(select(User.username).where(User.id==owner))
                    packet=await prepare(db,rev,owner,username)
                    return packet.id
        finally:
            await async_engine.dispose()
    return asyncio.run(run())
