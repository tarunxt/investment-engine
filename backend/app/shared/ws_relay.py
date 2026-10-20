from __future__ import annotations

import asyncio
import anyio
import json
import logging
import re
import time
from typing import Awaitable, Callable
from urllib.parse import urlsplit

from fastapi import WebSocket, WebSocketDisconnect, HTTPException
import redis.asyncio as aioredis
from sqlalchemy import select

from app.core.config import settings
from app.core.uat2 import require_uat2_owner
from app.domains.auth.models import User
from app.domains.auth.session_revocation import session_is_current
from app.domains.auth.websocket_tickets import StreamAccess, consume_stream_ticket
from app.domains.jobs.models import Job
from app.domains.runs.models import RunJob
from app.domains.runs.repository import PostgresRunRepository
from app.infrastructure.database.session import AsyncSessionLocal

logger = logging.getLogger(__name__)
_PING_INTERVAL = 25
REVOCATION_POLL_SECONDS = 2
AUTHORIZATION_TIMEOUT_SECONDS = 2
Authorize = Callable[[dict | None], Awaitable[bool]]


def _origin(value: str | None):
    if not value:
        return None
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in {'http', 'https'} or not parsed.hostname
                or parsed.username or parsed.password or parsed.path not in {'', '/'}
                or parsed.query or parsed.fragment):
            return None
        return parsed.scheme, parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == 'https' else 80)
    except ValueError:
        return None


async def stream_is_current(access: StreamAccess, *, job_id=None, run_id=None, message=None) -> bool:
    """Current-access hook; Stage07 may add module checks here, not claimed now."""
    if access.expires_at <= time.time():
        return False
    async with AsyncSessionLocal() as db:
        user = (await db.execute(select(User).where(
            User.id == access.user_id, User.is_active.is_(True)))).scalar_one_or_none()
        if user is None:
            return False
        try:
            require_uat2_owner(user.email)
        except HTTPException:
            return False
        if not await session_is_current(db, access.user_id, {'auth_time': access.auth_time}):
            return False
        if message is not None:
            if message.get('type') not in {'job.updated', 'run.updated'}:
                return False
            event_job, event_run = message.get('job_id'), message.get('run_id')
            if message['type'] == 'job.updated' and type(event_job) is not int:
                return False
            if message['type'] == 'run.updated' and type(event_run) is not int:
                return False
            if job_id is not None and event_job != job_id:
                return False
            if run_id is not None and event_run != run_id:
                return False
            job_id, run_id = event_job, event_run
        if job_id is not None:
            if type(job_id) is not int or (await db.execute(select(Job.id).where(
                    Job.id == job_id, Job.user_id == access.user_id))).scalar_one_or_none() is None:
                return False
        if run_id is not None:
            if type(run_id) is not int or not await PostgresRunRepository(db).is_owned(run_id, user_id=access.user_id):
                return False
            if job_id is not None and (await db.execute(select(RunJob.id).where(
                    RunJob.run_id == run_id, RunJob.job_id == job_id))).scalar_one_or_none() is None:
                return False
    return True


async def _checked(authorize: Authorize, message=None) -> bool:
    try:
        return await asyncio.wait_for(authorize(message), timeout=AUTHORIZATION_TIMEOUT_SECONDS)
    except Exception:
        # Fail closed without logging a credential or exception containing a URL.
        logger.warning('Private stream current-access check failed')
        return False


async def authenticate_websocket(websocket: WebSocket, token: str | None) -> StreamAccess | None:
    # Query arguments were already parsed; do not retain tickets in access logs.
    websocket.scope['query_string'] = b''
    if _origin(websocket.headers.get('origin')) != _origin(settings.frontend_url) or _origin(settings.frontend_url) is None:
        await websocket.close(code=4003, reason='Origin rejected')
        return None
    access = None
    if token and re.fullmatch(r'[A-Za-z0-9_-]{32,128}', token):
        try:
            access = await consume_stream_ticket(token)
        except Exception:
            logger.warning('Private stream ticket unavailable')
    if access is None or not await _checked(lambda message: stream_is_current(access)):
        await websocket.close(code=4001, reason='Unauthorized')
        return None
    return access


async def relay_channel(websocket: WebSocket, channel: str, *, authorize: Authorize, expires_at: float | None = None) -> None:
    """Check each event; idle revocation polls every2s; always release subscribers."""
    redis = pubsub = None
    tasks = []
    try:
        if not await _checked(authorize):
            await websocket.close(code=4002 if expires_at is not None and expires_at <= time.time() else 4001, reason='Access no longer current')
            return
        redis = aioredis.from_url(settings.redis_url, decode_responses=True)
        pubsub = redis.pubsub()
        await pubsub.subscribe(channel)

        async def receive_events():
            async for message in pubsub.listen():
                if message['type'] != 'message':
                    continue
                try:
                    payload = json.loads(message['data'])
                except (ValueError, TypeError):
                    continue
                if not isinstance(payload, dict) or not await _checked(authorize, payload):
                    await websocket.close(code=4002 if expires_at is not None and expires_at <= time.time() else 4001, reason='Access no longer current')
                    return
                await websocket.send_json(payload)

        async def drain_client():
            try:
                while (await websocket.receive())['type'] != 'websocket.disconnect':
                    pass
            except WebSocketDisconnect:
                pass

        async def maintain_access():
            last_ping = time.monotonic()
            while True:
                await asyncio.sleep(REVOCATION_POLL_SECONDS)
                if not await _checked(authorize):
                    await websocket.close(code=4002 if expires_at is not None and expires_at <= time.time() else 4001, reason='Access no longer current')
                    return
                if time.monotonic() - last_ping >= _PING_INTERVAL:
                    await websocket.send_json({'type': 'ping'})
                    last_ping = time.monotonic()

        tasks = [asyncio.create_task(fn()) for fn in (receive_events, drain_client, maintain_access)]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except asyncio.CancelledError:
        # A client/server shutdown is a normal stream end; cleanup still runs.
        pass
    finally:
        with anyio.CancelScope(shield=True):
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            if pubsub is not None:
                try:
                    await pubsub.unsubscribe(channel)
                except Exception:
                    logger.warning('Private stream unsubscribe failed')
                try:
                    await pubsub.aclose()
                except Exception:
                    logger.warning('Private stream subscriber close failed')
            if redis is not None:
                await redis.aclose()
