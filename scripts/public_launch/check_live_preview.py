"""Actual loopback HTTP/WebSocket smoke with existing synthetic identities only.

Tokens/tickets stay in memory. No UAT2/live/provider target is accepted.
"""
import asyncio
import json
from pathlib import Path
import time
from urllib.parse import urlsplit

import requests
import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

ROOT = Path(__file__).resolve().parents[2]


async def main():
    state = json.loads((ROOT/'.runtime/stage01-preview/state.json').read_text())
    api = state['backend_url']
    assert state['synthetic'] and urlsplit(api).hostname == '127.0.0.1'
    assert urlsplit(api).scheme == 'http' and urlsplit(api).port == state['backend_port']
    origin = f"http://localhost:{state['frontend_port']}"
    ws_base = api.replace('http://', 'ws://')
    sessions, claims, ids, nonces = [], [], [], []
    for user in ('usera', 'userb'):
        client = requests.Session()
        client.trust_env = False
        response = client.post(api+'/auth/login', json={'email':f'{user}@stage01.example.com',
                                'password':'SyntheticPreview123!'}, timeout=10)
        assert response.status_code == 200
        tokens = response.json()
        client.headers['Authorization'] = 'Bearer '+tokens['access_token']
        own = client.get(api+'/jobs', timeout=10).json()
        assert own['total'] == 1 and user in own['items'][0]['prompt']
        sessions.append(client)
        claims.append(tokens)
        ids.append(own['items'][0]['id'])

    def ticket(index=0):
        response = sessions[index].post(api+'/auth/websocket-ticket', timeout=10)
        assert response.status_code == 200
        nonce = response.json()['ticket']
        nonces.append(nonce)
        return nonce

    def connect(path, nonce, allowed_origin=origin):
        return websockets.connect(ws_base+path+'?token='+nonce, origin=allowed_origin,
                                  proxy=None, open_timeout=5, close_timeout=2)

    async def denied(path, nonce, allowed_origin=origin):
        try:
            async with connect(path, nonce, allowed_origin):
                raise AssertionError('Private handshake unexpectedly accepted')
        except InvalidStatus as error:
            assert error.response.status_code == 403  # rejection before accept

    used = ticket()
    async with connect('/ws/jobs', used) as ws:
        event = json.loads(await asyncio.wait_for(ws.recv(), 4))
        assert event['job_id'] == ids[0] and 'usera' in event['response']
    await denied('/ws/jobs', used)
    await denied(f'/ws/jobs/{ids[1]}', ticket())
    await denied('/ws/jobs/999999', ticket())
    await denied('/ws/jobs', claims[0]['access_token'])
    nonce = ticket()
    await denied('/ws/jobs', nonce, 'https://foreign.invalid')
    async with connect('/ws/jobs', nonce) as ws:
        assert json.loads(await asyncio.wait_for(ws.recv(), 4))['job_id'] == ids[0]

    async with connect('/ws/jobs', ticket()) as ws:
        assert json.loads(await asyncio.wait_for(ws.recv(), 4))['job_id'] == ids[0]
        assert sessions[0].post(api+'/auth/logout', timeout=10).status_code == 200
        started = time.monotonic()
        try:
            await asyncio.wait_for(ws.recv(), 5)
            raise AssertionError('Frame delivered after committed logout')
        except ConnectionClosed as error:
            assert error.rcvd and error.rcvd.code == 4001
        latency = round(time.monotonic()-started, 3)
    assert sessions[0].post(api+'/auth/websocket-ticket', timeout=10).status_code == 401
    assert sessions[0].post(api+'/auth/refresh', json={'refresh_token':claims[0]['refresh_token']}, timeout=10).status_code == 401
    async with connect('/ws/jobs', ticket(1)) as ws:
        event = json.loads(await asyncio.wait_for(ws.recv(), 4))
        assert event['job_id'] == ids[1] and 'userb' in event['response']
    log = (ROOT/'.runtime/stage01-preview/backend.log').read_text()
    assert '?token=' not in log and all(value not in log for value in nonces)
    report = {'result':'passed','frontend_url':origin,'backend_url':api,
              'checks':['real own A/B stream frames isolated','fresh-ticket reconnect',
                        'one-use and raw-JWT rejection','known/guessed foreign denial before accept',
                        'exact Origin rejection','no later frame after committed logout',
                        'old access and refresh rejected','ticket query absent from access logs'],
              'observed_logout_close_latency_seconds':latency,'close_code':4001,
              'tokens_or_tickets_retained':False,'transport':'in-process fake Redis; actual handlers',
              'scope':'localhost synthetic-only; not UAT2 deployment verification'}
    (ROOT/'.runtime/stage01-preview/stage03-live-network.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))


if __name__ == '__main__':
    try: asyncio.run(main())
    except Exception as error:
        raise SystemExit('Synthetic loopback stream verification failed: '+type(error).__name__) from None
