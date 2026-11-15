"""Actual SQLite ownership + family check + public snapshot, no Redis/network."""
import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, call
import pytest
from app.domains.jobs.models import Job
from app.domains.auth.models import AuthSessionFamily, User
from app.domains.jobs import ws_router
from app.shared import ws_relay
from app.shared.types import JobStatus
from test_jobs_ownership import database
from session_composition_fixtures import active_identity

@pytest.mark.asyncio
@pytest.mark.parametrize('database', ['0', '1'], indirect=True)
@pytest.mark.parametrize('case', ['owner','foreign','missing','inactive','revoked','expired','lookup_error','store_error'])
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
        if case=='inactive':
            user=await db.get(User,1);user.is_active=False;await db.commit()
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
    delivery = Mock()
    delivery.attach_mock(socket.accept, 'accept')
    delivery.attach_mock(socket.send_json, 'send_json')
    delivery.attach_mock(relay, 'relay')
    await ws_router.ws_job_detail(socket,999999 if case=='missing' else job_id,'synthetic-ticket')
    if case=='owner':
        socket.accept.assert_awaited_once()
        socket.close.assert_not_awaited()
        socket.send_json.assert_awaited_once();payload=socket.send_json.await_args.args[0]
        assert marker not in str(payload) and payload['response'].endswith('| FALP | 7 |')
        relay.assert_awaited_once_with(socket,f'job_updates:{job_id}',auth_identity=identity)
        assert delivery.mock_calls == [call.accept(), call.send_json(payload),
            call.relay(socket, f'job_updates:{job_id}', auth_identity=identity)]
    else:
        socket.accept.assert_not_awaited()
        socket.close.assert_awaited_once();socket.send_json.assert_not_awaited();relay.assert_not_awaited()
    async with database() as db:assert (await db.get(Job,job_id)).error_message==original


@pytest.mark.asyncio
@pytest.mark.parametrize('database', ['0', '1'], indirect=True)
async def test_owner_stream_rechecks_revocation_before_relay_delivery(database, monkeypatch):
    identity = await active_identity(database, 1)
    async with database() as db:
        job = Job(user_id=1, prompt='synthetic', provider='synthetic', model='synthetic',
                  status=JobStatus.COMPLETED, response='preserved owner state')
        db.add(job)
        await db.commit()
        job_id = job.id
    monkeypatch.setattr(ws_router, 'AsyncSessionLocal', database)
    monkeypatch.setattr(ws_relay, 'AsyncSessionLocal', database)
    monkeypatch.setattr(ws_router, 'user_id_from_ws_token', AsyncMock(return_value=identity))
    revocation_committed = asyncio.Event()

    async def messages():
        async with database() as db:
            family = await db.get(AuthSessionFamily, identity.claims['sid'])
            family.is_active = False
            await db.commit()
        revocation_committed.set()
        yield {'type': 'message', 'data': json.dumps({'response': 'must not deliver'})}

    pubsub = SimpleNamespace(subscribe=AsyncMock(), listen=messages,
                             unsubscribe=AsyncMock(), aclose=AsyncMock())
    redis = SimpleNamespace(pubsub=lambda: pubsub, aclose=AsyncMock())
    monkeypatch.setattr(ws_relay.aioredis, 'from_url', lambda *args, **kwargs: redis)

    async def wait_for_disconnect():
        await asyncio.Future()

    socket = SimpleNamespace(accept=AsyncMock(), send_json=AsyncMock(), send_text=AsyncMock(),
                             close=AsyncMock(), receive=wait_for_disconnect,
                             client_state=SimpleNamespace(name='CONNECTED'))
    await asyncio.wait_for(ws_router.ws_job_detail(socket, job_id, 'synthetic-ticket'), 5)
    assert revocation_committed.is_set()
    socket.accept.assert_awaited_once()
    socket.send_json.assert_awaited_once()
    assert socket.send_json.await_args.args[0]['response'] == 'preserved owner state'
    socket.send_text.assert_not_awaited()
    socket.close.assert_any_await(code=4001, reason='Session expired or revoked')
    pubsub.subscribe.assert_awaited_once_with(f'job_updates:{job_id}')
    pubsub.unsubscribe.assert_awaited_once_with(f'job_updates:{job_id}')
    pubsub.aclose.assert_awaited_once()
    redis.aclose.assert_awaited_once()



@pytest.mark.asyncio
@pytest.mark.parametrize('database', ['0', '1'], indirect=True)
@pytest.mark.parametrize('case', ['owner', 'foreign', 'missing', 'inactive', 'revoked'])
async def test_router_recovery_middleware_handshake_policy(database, monkeypatch, case):
    from fastapi import FastAPI
    from app.core.recovery import RecoveryMiddleware, recovery_mode

    identity = await active_identity(database, 1)
    async with database() as db:
        job = Job(user_id=2 if case == 'foreign' else 1, prompt='synthetic',
                  provider='synthetic', model='synthetic', response='owner state')
        db.add(job)
        await db.commit()
        job_id = 999999 if case == 'missing' else job.id
        if case == 'inactive':
            user = await db.get(User, 1)
            user.is_active = False
        if case == 'revoked':
            family = await db.get(AuthSessionFamily, identity.claims['sid'])
            family.is_active = False
        await db.commit()
    monkeypatch.setattr(ws_router, 'AsyncSessionLocal', database)
    monkeypatch.setattr(ws_relay, 'AsyncSessionLocal', database)
    authenticate = AsyncMock(return_value=identity)
    relay = AsyncMock()
    monkeypatch.setattr(ws_router, 'user_id_from_ws_token', authenticate)
    monkeypatch.setattr(ws_router, 'relay_channel', relay)
    app = FastAPI()
    app.include_router(ws_router.router)
    app.add_middleware(RecoveryMiddleware)
    events = []

    async def receive():
        return {'type': 'websocket.connect'}

    async def send(event):
        events.append(event)

    await app({'type': 'websocket', 'asgi': {'version': '3.0'}, 'scheme': 'ws',
               'path': f'/ws/jobs/{job_id}', 'raw_path': f'/ws/jobs/{job_id}'.encode(),
               'query_string': b'token=synthetic-ticket', 'headers': [],
               'root_path': '', 'client': ('synthetic', 1), 'server': ('synthetic', 80),
               'subprotocols': []}, receive, send)
    if recovery_mode():
        # Production containment rejects every WS, even a valid owner, before
        # authentication, repository access, acceptance, data or subscription.
        assert events == [{'type': 'websocket.close', 'code': 1008}]
        authenticate.assert_not_awaited()
        relay.assert_not_awaited()
    elif case == 'owner':
        assert [event['type'] for event in events] == ['websocket.accept', 'websocket.send']
        assert json.loads(events[1]['text'])['response'] == 'owner state'
        relay.assert_awaited_once()
    else:
        reason = 'Job unavailable' if case in ('foreign', 'missing') else 'Session expired or revoked'
        assert events == [{'type': 'websocket.close', 'code': 1008, 'reason': reason}]
        relay.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('database', ['0', '1'], indirect=True)
async def test_recovery_router_preserves_owned_http_reads(database, monkeypatch):
    from fastapi import FastAPI, HTTPException
    from httpx import ASGITransport, AsyncClient
    from app.core.recovery import RecoveryMiddleware, recovery_mode
    from app.domains.jobs.router import router
    from app.domains.auth.dependencies import get_current_user
    from app.infrastructure.database.session import get_async_db

    async with database() as db:
        db.add_all([Job(id=901, user_id=1, prompt='owned evidence', provider='synthetic', model='synthetic'),
                    Job(id=902, user_id=2, prompt='foreign evidence', provider='synthetic', model='synthetic')])
        await db.commit()
    app = FastAPI()
    app.include_router(router)
    app.add_middleware(RecoveryMiddleware)

    async def session():
        async with database() as db:
            yield db

    app.dependency_overrides[get_async_db] = session
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://synthetic') as client:
        own = await client.get('/jobs/901')
        assert own.status_code == 200 and own.json()['id'] == 901
        listing = await client.get('/jobs?limit=1')
        assert listing.status_code == 200 and listing.json()['total'] == 1
        assert [job['id'] for job in listing.json()['items']] == [901]
        for job_id in (902, 999999):
            denied = await client.get(f'/jobs/{job_id}')
            assert denied.status_code == 404 and denied.json() == {'detail': 'Job not found'}
        if recovery_mode():
            canceled = await client.post('/jobs/901/cancel')
            assert canceled.status_code == 503
            assert canceled.json()['code'] == 'RECOVERY_CONTAINMENT'
            async with database() as db:
                assert (await db.get(Job, 901)).status == JobStatus.PENDING

        def anonymous():
            raise HTTPException(401, 'Unauthorized')

        app.dependency_overrides[get_current_user] = anonymous
        for path in ('/jobs', '/jobs/901', '/jobs/902', '/jobs/999999'):
            denied = await client.get(path)
            assert denied.status_code == 401 and denied.json() == {'detail': 'Unauthorized'}
