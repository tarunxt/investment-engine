"""Synthetic real-SQL identities plus deterministic Redis pubsub; no external I/O."""
import asyncio
from contextlib import asynccontextmanager
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from app.core.security import JWTUtils, AuthUtils
from app.domains.auth import websocket_tickets as tickets
from app.domains.auth.models import ActivityLog
from app.shared import ws_relay as relay
from app.shared.ws_channels import job_channel, run_channel
from test_private_api_ownership import private_api  # reuse isolated SQL/identity fixture


class Store:
    def __init__(self):
        self.values, self.expirations, self.clients, self.subscribers = {}, {}, [], []
        self.now = time.monotonic()
    def client(self, *args, **kwargs):
        client = Redis(self)
        self.clients.append(client)
        return client


class Subscriber:
    def __init__(self, store):
        self.store, self.channels, self.closed = store, set(), False
        self.queue = asyncio.Queue()
        self.loop = asyncio.get_running_loop()
        store.subscribers.append(self)
    async def subscribe(self, channel): self.channels.add(channel)
    async def unsubscribe(self, channel): self.channels.discard(channel)
    async def aclose(self): self.closed = True
    async def listen(self):
        while True: yield await self.queue.get()
    def send(self, channel, payload):
        if channel in self.channels:
            self.loop.call_soon_threadsafe(self.queue.put_nowait,
                {'type': 'message', 'data': json.dumps(payload)})


class Redis:
    def __init__(self, store): self.store, self.closed = store, False
    async def set(self, key, value, *, ex):
        self.store.values[key] = value
        self.store.expirations[key] = self.store.now + ex
    async def eval(self, _script, _count, key):
        value = self.store.values.pop(key, None)
        return value if self.store.expirations.get(key, 0) > self.store.now else None
    async def aclose(self): self.closed = True
    def pubsub(self): return Subscriber(self.store)


@pytest.fixture
def live(private_api, monkeypatch):
    from app.domains.jobs.ws_router import router as jobs
    from app.domains.runs.ws_router import router as runs
    from app.domains.auth.router import router as auth
    store = Store()
    monkeypatch.setattr(tickets.aioredis, 'from_url', store.client)
    monkeypatch.setattr(relay.settings, 'frontend_url', 'http://localhost:3000')
    @asynccontextmanager
    async def database(): yield private_api.db
    monkeypatch.setattr(relay, 'AsyncSessionLocal', database)
    from app.domains.jobs import ws_router as jobs_module
    from app.domains.runs import ws_router as runs_module
    monkeypatch.setattr(jobs_module, 'AsyncSessionLocal', database)
    monkeypatch.setattr(runs_module, 'AsyncSessionLocal', database)
    for router in (jobs, runs, auth): private_api.app.include_router(router)
    def ticket():
        response = private_api.client.post('/auth/websocket-ticket', headers=private_api.headers[0])
        assert response.status_code == 200
        return response.json()['ticket']
    return SimpleNamespace(**vars(private_api), store=store, ticket=ticket,
                           origin={'Origin': 'http://localhost:3000'})


@pytest.mark.parametrize('kind', ['jobs', 'runs'])
def test_foreign_or_missing_has_no_initial_or_late_subscription(live, kind):
    foreign = live.jobs[3].id if kind == 'jobs' else live.runs[1].id
    for id in (foreign, 999999):
        with pytest.raises(WebSocketDisconnect) as error:
            with live.client.websocket_connect(f'/ws/{kind}/{id}?token={live.ticket()}', headers=live.origin):
                pass
        assert error.value.code == 4004
    assert live.store.subscribers == []


@pytest.mark.parametrize('path', ['/ws/jobs', '/ws/runs'])
def test_one_use_expiry_origin_and_raw_jwt_rejection(live, path):
    ticket = live.ticket()
    with pytest.raises(WebSocketDisconnect) as error:
        with live.client.websocket_connect(path+'?token='+ticket, headers={'Origin':'https://foreign.invalid'}): pass
    assert error.value.code == 4003
    # Wrong Origin did not consume the ticket; correct Origin may use it once.
    with live.client.websocket_connect(path+'?token='+ticket, headers=live.origin): pass
    for value in (ticket, live.headers[0]['Authorization'].removeprefix('Bearer ')):
        with pytest.raises(WebSocketDisconnect) as error:
            with live.client.websocket_connect(path+'?token='+value, headers=live.origin): pass
        assert error.value.code == 4001
    ticket = live.ticket()
    live.store.now += tickets.WEBSOCKET_TICKET_TTL_SECONDS + 1
    with pytest.raises(WebSocketDisconnect) as error:
        with live.client.websocket_connect(path+'?token='+ticket, headers=live.origin): pass
    assert error.value.code == 4001


@pytest.mark.parametrize('kind', ['jobs', 'runs'])
def test_scoped_reconnect_delivers_only_owned_events_and_releases_resources(live, kind):
    id = live.jobs[0].id if kind == 'jobs' else live.runs[0].id
    channel = job_channel(live.users[0].id, id) if kind == 'jobs' else run_channel(live.users[0].id, id)
    for _ in range(2):
        with live.client.websocket_connect(f'/ws/{kind}/{id}?token={live.ticket()}', headers=live.origin) as ws:
            if kind == 'jobs': assert ws.receive_json()['job_id'] == id
            # Sending a harmless client frame lets the relay subscribe before assertions.
            ws.send_json({'type':'client-ready'})
            deadline = time.monotonic() + 2
            while not any(channel in s.channels for s in live.store.subscribers):
                assert time.monotonic() < deadline
                time.sleep(.005)
            active = [s for s in live.store.subscribers if channel in s.channels]
            assert len(active) == 1
            active[0].send(channel, {'type':f'{kind[:-1]}.updated', f'{kind[:-1]}_id':id, 'status':'completed'})
            assert ws.receive_json()['status'] == 'completed'
        assert all(s.closed and not s.channels for s in live.store.subscribers)
    assert all(c.closed for c in live.store.clients)


@pytest.mark.parametrize('kind', ['jobs', 'runs'])
@pytest.mark.parametrize('loss', ['logout', 'suspended'])
def test_late_event_after_loss_never_reaches_list_stream(live, kind, loss):
    channel = f'user_{kind[:-1]}_updates:{live.users[0].id}'
    with live.client.websocket_connect(f'/ws/{kind}?token={live.ticket()}', headers=live.origin) as ws:
        ws.send_json({'type':'client-ready'})
        deadline = time.monotonic() + 2
        while not live.store.subscribers:
            assert time.monotonic() < deadline
            time.sleep(.005)
        if loss == 'logout':
            assert live.client.post('/auth/logout', headers=live.headers[0]).status_code == 200
        else:
            live.users[0].is_active = False
            live.session.commit()
        live.store.subscribers[-1].send(channel, {'type':f'{kind[:-1]}.updated',
            f'{kind[:-1]}_id': live.jobs[0].id if kind == 'jobs' else live.runs[0].id,
            'response':'must never be delivered'})
        with pytest.raises(WebSocketDisconnect) as error: ws.receive_json()
        assert error.value.code == 4001
    assert all(s.closed and not s.channels for s in live.store.subscribers)


def test_logout_invalidates_old_access_and_refresh_and_new_authentication_works(live):
    claims = JWTUtils.verify_token(live.headers[0]['Authorization'].removeprefix('Bearer '))
    refresh = JWTUtils.create_refresh_token(live.users[0].id, live.users[0].email, auth_time=claims['auth_time'])
    assert live.client.post('/auth/logout', headers=live.headers[0]).status_code == 200
    assert live.client.post('/auth/websocket-ticket', headers=live.headers[0]).status_code == 401
    assert live.client.post('/auth/refresh', json={'refresh_token':refresh}).status_code == 401
    # Independent fresh authentication, including same-second login, is valid.
    new = AuthUtils.create_tokens(live.users[0].id, live.users[0].email, 'user')
    assert live.client.post('/auth/websocket-ticket', headers={'Authorization':'Bearer '+new['access_token']}).status_code == 200
    assert JWTUtils.verify_token(new['access_token'])['auth_time'] == JWTUtils.verify_token(new['refresh_token'])['auth_time']


def test_refresh_racing_logout_cannot_create_a_new_authentication_epoch(live, monkeypatch):
    from app.domains.auth import router
    claims = JWTUtils.verify_token(live.headers[0]['Authorization'].removeprefix('Bearer '))
    refresh = JWTUtils.create_refresh_token(live.users[0].id, live.users[0].email, auth_time=claims['auth_time'])
    async def checked_before_logout(db, user_id, payload):
        db.add(ActivityLog(user_id=user_id, action='logout', details='Synthetic refresh race'))
        await db.commit()
        return True
    with monkeypatch.context() as patch:
        patch.setattr(router, 'session_is_current', checked_before_logout)
        response = live.client.post('/auth/refresh', json={'refresh_token':refresh})
    assert response.status_code == 200
    new = response.json()
    assert JWTUtils.verify_token(new['access_token'])['auth_time'] == claims['auth_time']
    assert live.client.get('/jobs', headers={'Authorization':'Bearer '+new['access_token']}).status_code == 401


def test_refresh_credential_cannot_authorize_a_private_read(live):
    token = JWTUtils.create_refresh_token(live.users[0].id, live.users[0].email)
    assert live.client.get('/jobs', headers={'Authorization':'Bearer '+token}).status_code == 401


def test_list_stream_reuses_corrupt_cross_owner_run_link_guard(live):
    from app.domains.runs.models import RunJob
    live.session.add(RunJob(run_id=live.runs[0].id, job_id=live.jobs[3].id))
    live.session.commit()
    with live.client.websocket_connect('/ws/runs?token='+live.ticket(), headers=live.origin) as ws:
        ws.send_json({'type':'client-ready'})
        deadline = time.monotonic()+2
        while not live.store.subscribers:
            assert time.monotonic()<deadline
            time.sleep(.005)
        channel = f'user_run_updates:{live.users[0].id}'
        live.store.subscribers[-1].send(channel, {'type':'run.updated', 'run_id':live.runs[0].id,
                                               'status':'completed'})
        with pytest.raises(WebSocketDisconnect) as error: ws.receive_json()
        assert error.value.code == 4001


@pytest.mark.parametrize('value', [None, 'null', 'http://localhost:3000.foreign.invalid', 'http://[broken',
    'http://localhost:3001', 'https://localhost:3000', 'http://name@localhost:3000', 'http://localhost:3000/path'])
def test_origin_validation_is_exact(value):
    assert relay._origin(value) != relay._origin('http://localhost:3000')


@pytest.mark.asyncio
async def test_query_is_scrubbed_before_origin_denial():
    socket = SimpleNamespace(scope={'query_string':b'token=must-not-log'},
                             headers={'origin':'https://foreign.invalid'}, close=AsyncMock())
    assert await relay.authenticate_websocket(socket, 'synthetic-ticket') is None
    assert socket.scope['query_string'] == b''
    socket.close.assert_awaited_once()


def fake_socket():
    disconnected = asyncio.Event()
    async def receive():
        await disconnected.wait()
        return {'type':'websocket.disconnect'}
    return SimpleNamespace(receive=receive, send_json=AsyncMock(), close=AsyncMock())


@pytest.mark.asyncio
async def test_idle_session_loss_closes_without_an_event_and_releases_subscriber(monkeypatch):
    store = Store()
    monkeypatch.setattr(relay.aioredis, 'from_url', store.client)
    monkeypatch.setattr(relay, 'REVOCATION_POLL_SECONDS', .01)
    socket = fake_socket()
    started = time.monotonic()
    await asyncio.wait_for(relay.relay_channel(socket, 'user_job_updates:1',
        authorize=AsyncMock(side_effect=[True, False])), timeout=.5)
    assert time.monotonic() - started < .5
    socket.close.assert_awaited_once()
    socket.send_json.assert_not_awaited()
    assert all(s.closed and not s.channels for s in store.subscribers)
    assert all(c.closed for c in store.clients)


@pytest.mark.asyncio
async def test_relay_cancellation_releases_every_task_and_redis_resource(monkeypatch):
    store = Store()
    monkeypatch.setattr(relay.aioredis, 'from_url', store.client)
    original_create = asyncio.create_task
    children = []
    def create(coroutine):
        child = original_create(coroutine)
        children.append(child)
        return child
    monkeypatch.setattr(relay.asyncio, 'create_task', create)
    task = original_create(relay.relay_channel(fake_socket(), 'user_job_updates:1', authorize=AsyncMock(return_value=True)))
    for _ in range(20):
        if len(children) == 3: break
        await asyncio.sleep(.005)
    assert len(children) == 3
    task.cancel()
    await asyncio.wait_for(task, timeout=.5)
    assert all(child.done() for child in children)
    assert all(s.closed and not s.channels for s in store.subscribers)
    assert all(c.closed for c in store.clients)


@pytest.mark.asyncio
async def test_access_check_failure_fails_closed_without_logging_exception_secrets(monkeypatch, caplog):
    socket = fake_socket()
    await relay.relay_channel(socket, 'user_job_updates:1',
        authorize=AsyncMock(side_effect=RuntimeError('token=must-not-appear')))
    socket.close.assert_awaited_once()
    socket.send_json.assert_not_awaited()
    assert 'must-not-appear' not in caplog.text
