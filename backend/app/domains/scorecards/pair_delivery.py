"""Deliver due persisted Pairwise work to the equity worker, including after restarts."""
import logging
import time
from threading import Event, Thread

from celery import bootsteps
from sqlalchemy import or_, select
from app.core.recovery import PAIRWISE_TASK
from app.domains.scorecards import pair_work, storage

log = logging.getLogger(__name__)


class PairwiseDelivery(bootsteps.StartStopStep):
    requires = ("celery.worker.consumer.connection:Connection",)

    def start(self, consumer):
        from app.core.config import settings
        from app.domains.recommendation_audit.outbox import relay_database
        self.engine, factory = relay_database(settings.database_url)
        self.stopped = Event()
        def relay():
            while not self.stopped.wait(30):
                try:
                    with factory() as db:
                        now = int(time.time())
                        published = storage.Stage.summary_json["published_at"].as_integer()
                        rows = list(db.scalars(select(storage.Stage).where(*pair_work.due(now),
                            or_(published.is_(None),published<=now-120)).order_by(storage.Stage.id)
                            .limit(12).with_for_update(skip_locked=True)))
                        ids = [r.id for r in rows]
                        for row in rows:
                            row.summary_json = {**row.summary_json,"published_at":now}
                        db.commit()
                    for work_id in ids:
                        if self.stopped.is_set():
                            return
                        consumer.app.send_task(PAIRWISE_TASK,args=[work_id],expires=120,retry=False)
                except Exception:
                    log.exception("Pairwise delivery deferred; persisted schedule retained")
        self.thread = Thread(target=relay,name="pairwise-delivery",daemon=True)
        self.thread.start()

    def stop(self, consumer):
        self.stopped.set()
        self.thread.join(timeout=2)
        self.engine.dispose()

    shutdown = stop


async def advance_one(work_id):
    from app.infrastructure.database.session import AsyncSessionLocal, async_engine
    try:
        async with AsyncSessionLocal() as db:
            await pair_work.advance(db,work_id)
    finally:
        await async_engine.dispose()
