"""Actual SQLite ownership + family check + public snapshot, no Redis/network."""
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from app.domains.jobs.models import Job
from app.domains.auth.models import AuthSessionFamily
from app.domains.jobs import ws_router
from app.shared import ws_relay
from app.shared.types import JobStatus
from test_jobs_ownership import database
from session_composition_fixtures import active_identity

@pytest.mark.asyncio
@pytest.mark.parametrize('case', ['owner','foreign','missing','revoked','expired','lookup_error','store_error'])
async def test_composed_initial_delivery_needs_owner_and_active_family(database, monkeypatch, case):
    identity = await active_identity(database, 1)
    marker = 'synthetic-private-credential'
    original = 'Authorization: Bearer '+marker
    async with database() as db:
        job = Job(user_id=2 if case=='foreign' else 1, prompt='financial source unchanged',
            provider='synthetic', model='synthetic', status=JobStatus.COMPLETED,
            response='| Symbol | Units |\n| FALP | 7 |', error_message=original)
        db.add(job);await db.commit();job_id=job.id
        if case=='revoked':
            family=await db.get(AuthSessionFamily,identity.claims['sid']);family.is_active=False;await db.commit()
    if case=='expired': identity.claims['exp']=time.time()-1
    monkeypatch.setattr(ws_router,'AsyncSessionLocal',database)
    monkeypatch.setattr(ws_relay,'AsyncSessionLocal',database)
    monkeypatch.setattr(ws_router,'user_id_from_ws_token',AsyncMock(return_value=identity))
    relay=AsyncMock();monkeypatch.setattr(ws_router,'relay_channel',relay)
    if case=='lookup_error':
        monkeypatch.setattr(ws_router,'PostgresJobRepository',lambda db:SimpleNamespace(get_for_user=AsyncMock(side_effect=RuntimeError('synthetic lookup unavailable'))))
    if case=='store_error':
        def unavailable():raise RuntimeError('synthetic family store unavailable')
        monkeypatch.setattr(ws_relay,'AsyncSessionLocal',unavailable)
    socket=SimpleNamespace(accept=AsyncMock(),send_json=AsyncMock(),close=AsyncMock())
    await ws_router.ws_job_detail(socket,999999 if case=='missing' else job_id,'synthetic-ticket')
    if case=='owner':
        socket.send_json.assert_awaited_once();payload=socket.send_json.await_args.args[0]
        assert marker not in str(payload) and payload['response'].endswith('| FALP | 7 |')
        relay.assert_awaited_once_with(socket,f'job_updates:{job_id}',auth_identity=identity)
    else:
        socket.close.assert_awaited_once();socket.send_json.assert_not_awaited();relay.assert_not_awaited()
    async with database() as db:assert (await db.get(Job,job_id)).error_message==original
