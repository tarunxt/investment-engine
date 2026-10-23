"""Stage19 resource-free admission uses actual consumer modules, not AI Studio.

Synthetic SQLite ownership rows and in-process WebSockets/Redis; no provider I/O.
"""
import time

import pytest
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from test_private_api_ownership import private_api, admitted_private_analysis
from test_live_boundaries import live
from app.domains.modules.models import UserModule


def select_only(live, module):
    row = live.session.scalar(select(UserModule).where(
        UserModule.user_id == live.users[0].id, UserModule.module_id == 'ai_studio'))
    row.enabled = False
    live.session.add(UserModule(user_id=live.users[0].id, module_id=module,
        enabled=True, config={'schema_version': 1}, version=1, schedules_paused=False))
    for resource in [*live.jobs[:3], live.runs[0]]:
        resource.module_id = module
    live.session.commit()


@pytest.mark.parametrize('module', ['zerodha_rebalance', 'indmoney_us'])
@pytest.mark.parametrize('kind', ['jobs', 'runs'])
@pytest.mark.parametrize('detail', [False, True])
def test_consumer_only_can_admit_and_receive_owned_stream(live, module, kind, detail):
    select_only(live, module)
    resource = live.jobs[0] if kind == 'jobs' else live.runs[0]
    path = f'/ws/{kind}' + (f'/{resource.id}' if detail else '')
    with live.client.websocket_connect(path + '?token=' + live.ticket(), headers=live.origin) as ws:
        if detail and kind == 'jobs':
            assert ws.receive_json()['job_id'] == resource.id
        ws.send_json({'type': 'client-ready'})
        deadline = time.monotonic() + 2
        while not live.store.subscribers:
            assert time.monotonic() < deadline
            time.sleep(.005)
        subscriber = live.store.subscribers[-1]
        channel = next(iter(subscriber.channels))
        subscriber.send(channel, {'type': kind[:-1] + '.updated',
            kind[:-1] + '_id': resource.id, 'status': 'completed'})
        assert ws.receive_json()['status'] == 'completed'


@pytest.mark.parametrize('module', ['sports_rankings', 'sheets_export', 'bullpen_research'])
def test_unrelated_or_unavailable_selection_cannot_admit(live, module):
    select_only(live, module)
    with pytest.raises(WebSocketDisconnect) as exc:
        with live.client.websocket_connect('/ws/jobs?token=' + live.ticket(), headers=live.origin):
            pass
    assert exc.value.code == 4001
    assert not live.store.subscribers


def test_eligible_consumer_does_not_grant_other_module_events(live):
    select_only(live, 'zerodha_rebalance')
    live.jobs[1].module_id = 'ai_studio'
    live.session.commit()
    with live.client.websocket_connect('/ws/jobs?token=' + live.ticket(), headers=live.origin) as ws:
        ws.send_json({'type': 'client-ready'})
        deadline = time.monotonic() + 2
        while not live.store.subscribers:
            assert time.monotonic() < deadline
            time.sleep(.005)
        subscriber = live.store.subscribers[-1]
        subscriber.send(next(iter(subscriber.channels)), {'type': 'job.updated',
            'job_id': live.jobs[1].id, 'response': 'must not leak'})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 4001


@pytest.mark.asyncio
@pytest.mark.parametrize('case', ['valid', 'module', 'cancelled', 'foreign', 'unlinked'])
async def test_mixed_event_checks_both_resource_bindings(live, case):
    from app.shared.ws_relay import stream_is_current
    from app.domains.auth.websocket_tickets import StreamAccess
    from app.core.security import JWTUtils
    job_id, run_id = live.jobs[0].id, live.runs[0].id
    if case == 'module':
        live.runs[0].module_id = 'zerodha_rebalance'
    elif case == 'cancelled':
        live.runs[0].module_cancel_requested = True
    elif case == 'foreign':
        run_id = live.runs[1].id
    elif case == 'unlinked':
        job_id = live.jobs[1].id
    live.session.commit()
    claims = JWTUtils.verify_token(live.headers[0]['Authorization'].removeprefix('Bearer '))
    access = StreamAccess(user_id=live.users[0].id, expires_at=time.time()+60,
        auth_time=claims['auth_time'], module_epoch=1)
    allowed = await stream_is_current(access, message={
        'type': 'job.updated', 'job_id': job_id, 'run_id': run_id})
    assert allowed is (case == 'valid')
