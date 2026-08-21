from __future__ import annotations

import logging

import redis as sync_redis
import redis.asyncio as aioredis

from app.core.config import settings
from app.infrastructure.messaging.celery_app import celery

logger = logging.getLogger(__name__)

_TASK_REGISTRY_TTL_SECONDS = 60 * 60 * 24 * 7
_TERMINATION_SIGNAL = "SIGTERM"


def _job_task_key(job_id: int) -> str:
    return f"celery:job-task:{job_id}"


def _auto_live_run_task_key(run_id: str) -> str:
    return f"celery:auto-live-run-task:{run_id}"


async def _store_task_id_async(key: str, task_id: str) -> None:
    redis_client: aioredis.Redis | None = None
    try:
        redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
        await redis_client.set(key, task_id, ex=_TASK_REGISTRY_TTL_SECONDS)
    except Exception:
        logger.exception("Failed to store Celery task id for key %s", key)
    finally:
        if redis_client is not None:
            await redis_client.aclose()


def _store_task_id_sync(key: str, task_id: str) -> None:
    redis_client: sync_redis.Redis | None = None
    try:
        redis_client = sync_redis.from_url(settings.redis_url, decode_responses=True)
        redis_client.set(key, task_id, ex=_TASK_REGISTRY_TTL_SECONDS)
    except Exception:
        logger.exception("Failed to store Celery task id for key %s", key)
    finally:
        if redis_client is not None:
            redis_client.close()


async def _get_task_id_async(key: str) -> str | None:
    redis_client: aioredis.Redis | None = None
    try:
        redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
        task_id = await redis_client.get(key)
        return task_id.strip() if isinstance(task_id, str) and task_id.strip() else None
    except Exception:
        logger.exception("Failed to load Celery task id for key %s", key)
        return None
    finally:
        if redis_client is not None:
            await redis_client.aclose()


def _get_task_id_sync(key: str) -> str | None:
    redis_client: sync_redis.Redis | None = None
    try:
        redis_client = sync_redis.from_url(settings.redis_url, decode_responses=True)
        task_id = redis_client.get(key)
        return task_id.strip() if isinstance(task_id, str) and task_id.strip() else None
    except Exception:
        logger.exception("Failed to load Celery task id for key %s", key)
        return None
    finally:
        if redis_client is not None:
            redis_client.close()


def _revoke_task(task_id: str) -> None:
    try:
        celery.control.revoke(
            task_id,
            terminate=True,
            signal=_TERMINATION_SIGNAL,
        )
    except Exception:
        logger.exception("Failed to revoke Celery task %s", task_id)


def revoke_auto_live_run_task_sync(task_id: str) -> None:
    """Terminate a known Auto-Live task after its run has exceeded its safety limit."""
    _revoke_task(task_id)


async def register_job_task(job_id: int, task_id: str) -> None:
    await _store_task_id_async(_job_task_key(job_id), task_id)


def register_job_task_sync(job_id: int, task_id: str) -> None:
    _store_task_id_sync(_job_task_key(job_id), task_id)


async def revoke_registered_job_task(job_id: int) -> str | None:
    task_id = await _get_task_id_async(_job_task_key(job_id))
    if task_id:
        _revoke_task(task_id)
    return task_id


async def register_auto_live_run_task(run_id: str, task_id: str) -> None:
    await _store_task_id_async(_auto_live_run_task_key(run_id), task_id)


def register_auto_live_run_task_sync(run_id: str, task_id: str) -> None:
    _store_task_id_sync(_auto_live_run_task_key(run_id), task_id)


async def get_registered_auto_live_run_task_id(run_id: str) -> str | None:
    return await _get_task_id_async(_auto_live_run_task_key(run_id))


def get_registered_auto_live_run_task_id_sync(run_id: str) -> str | None:
    return _get_task_id_sync(_auto_live_run_task_key(run_id))


async def revoke_registered_auto_live_run_task(run_id: str) -> str | None:
    task_id = await _get_task_id_async(_auto_live_run_task_key(run_id))
    if task_id:
        _revoke_task(task_id)
    return task_id
