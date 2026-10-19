"""Dedicated bounded queue; does not import production tasks or schedulers."""
import os
from celery import Celery
from app.uat2.adapters import FakeAI

celery = Celery('credx-uat2', broker=os.environ['REDIS_URL'], backend=os.environ['REDIS_URL'])
celery.conf.update(task_default_queue='uat2_simulation', task_serializer='json',
                   result_serializer='json', accept_content=['json'], worker_prefetch_multiplier=1,
                   task_time_limit=15, task_soft_time_limit=10, result_expires=3600,
                   beat_schedule={}, broker_connection_retry_on_startup=True)


@celery.task(name='uat2.fake_ai', autoretry_for=(OSError,), retry_backoff=True,
             max_retries=1, acks_late=True)
def fake_ai(prompt):
    return FakeAI().generate(prompt)
