"""In-process fake Redis transport for the opt-in localhost preview only.

The actual ticket/auth/ownership/relay handlers still run. Frames are synthetic
read-only Job/Run rows; no socket, provider, worker or real Redis is contacted.
"""
import asyncio
import json
import os
import time

if os.environ.get('STAGE01_PREVIEW') != 'synthetic-only':
    raise RuntimeError('Preview stream adapter is local synthetic-only')

from sqlalchemy import select
from app.domains.jobs.models import Job
from app.domains.runs.models import Run
from app.infrastructure.database.session import AsyncSessionLocal

_tickets = {}


class FakeSubscriber:
    def __init__(self):
        self.channel = None
        self.closed = False

    async def subscribe(self, channel): self.channel = channel
    async def unsubscribe(self, channel): self.channel = None
    async def aclose(self): self.closed = True

    async def listen(self):
        while not self.closed and self.channel:
            await asyncio.sleep(1)
            parts = self.channel.split(':')
            if len(parts) not in {2, 4} or parts[0] not in {'user_job_updates', 'user_run_updates'}:
                raise RuntimeError('Unexpected synthetic private channel')
            owner = int(parts[1])
            model = Job if parts[0] == 'user_job_updates' else Run
            query = select(model).where(model.user_id == owner)
            if len(parts) == 4: query = query.where(model.id == int(parts[3]))
            async with AsyncSessionLocal() as db:
                row = (await db.execute(query.order_by(model.id.desc()).limit(1))).scalar_one_or_none()
                if row is None: continue
                payload = {'type': 'job.updated' if model is Job else 'run.updated',
                           'job_id' if model is Job else 'run_id': row.id,
                           'status': row.status.value, 'synthetic': True}
                if model is Job: payload['response'] = row.response
                else: payload['current_stage'] = row.current_stage
            yield {'type': 'message', 'data': json.dumps(payload)}


class FakeRedis:
    async def set(self, key, value, *, ex): _tickets[key] = (time.monotonic()+ex, value)
    async def eval(self, _script, _count, key):
        deadline, value = _tickets.pop(key, (0, None))
        return value if deadline > time.monotonic() else None
    def pubsub(self): return FakeSubscriber()
    async def aclose(self): pass


def install():
    import redis.asyncio as aioredis
    aioredis.from_url = lambda *args, **kwargs: FakeRedis()
