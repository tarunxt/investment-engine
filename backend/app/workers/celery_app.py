from celery import Celery
from kombu import Queue
from os import getenv

REDIS_URL = getenv("REDIS_URL")

celery = Celery(
    "worker",
    broker=REDIS_URL,
    backend=REDIS_URL
)

celery.conf.task_routes = {
    "app.workers.tasks.*": {"queue": "default"}
}

# Define queues to listen to
celery.conf.task_queues = (
    Queue("default", routing_key="default"),
    Queue("celery", routing_key="celery"),
)

# Auto-discover tasks
celery.autodiscover_tasks(["app.workers"])