import asyncio
from app.core.recovery import PAIRWISE_TASK
from app.infrastructure.messaging.celery_app import celery
from .pair_delivery import advance_one


@celery.task(name=PAIRWISE_TASK, acks_late=True, soft_time_limit=140, time_limit=160)
def advance_pairwise(work_id: int):
    return asyncio.run(advance_one(work_id))
