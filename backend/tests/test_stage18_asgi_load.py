"""Bounded real-PG ASGI sample; not browser/proxy/network capacity acceptance."""
import asyncio
import json
import math
import os
from pathlib import Path
import time

import pytest
from httpx import ASGITransport, AsyncClient
from test_stage09_connections_postgres import database
from test_stage17_application_composition_postgres import configured_app

pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE18_ACK')!='synthetic-disposable-only',
    reason='Stage18 acknowledged disposable PostgreSQL required; CI rejects skips')


@pytest.mark.asyncio
async def test_bounded_signed_owner_other_admin_and_anonymous_asgi_load(configured_app):
    assert Path('/.dockerenv').is_file() and os.environ.get('CI')=='true'
    app,_,_,owner,other,actor,headers=configured_app
    semaphore=asyncio.Semaphore(3)
    durations=[];counts={'owned':0,'anonymous_denied':0}
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        async def request(identity):
            async with semaphore:
                start=time.perf_counter()
                response=await client.get('/account/operations/disposable/reviewed-eligibility',
                    headers=headers(identity) if identity is not None else {})
                durations.append(time.perf_counter()-start)
                if identity is None:
                    assert response.status_code==401;counts['anonymous_denied']+=1
                else:
                    assert response.status_code==200
                    value=response.json()
                    assert value['owner_id']==identity and value['eligible'] is False
                    assert response.headers['cache-control']=='private, no-store'
                    counts['owned']+=1
        started=time.perf_counter()
        # Authentication is real JWT+database resolution from the retained
        # fixture; no mutable per-request get_current_user override is used.
        tasks=[asyncio.create_task(request(identity))
               for _ in range(6) for identity in (owner,other,actor,None)]
        try:
            await asyncio.wait_for(asyncio.gather(*tasks),timeout=30)
        finally:
            for task in tasks:
                if not task.done():task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
    assert len(durations)==24 and counts=={'owned':18,'anonymous_denied':6}
    ordered=sorted(durations)
    report={'kind':'bounded_internal_ASGI_real_PostgreSQL_sample','source_sha':os.environ['SOURCE_SHA'],
        'requests':24,'max_concurrency':3,'completed':24,'errors':0,
        'duration_seconds':time.perf_counter()-started,
        'latency_seconds':{'p50':ordered[11],'p95':ordered[math.ceil(.95*len(ordered))-1],'max':ordered[-1]},
        'anonymous_denied':6,'owner_other_admin_responses_checked':18,
        'provider_effects':False,'browser_proxy_network_load':False,
        'production_capacity_verified':False,'capacity_target':'unresolved; this bounds only24requests/3inflight'}
    Path('/tmp/stage18-asgi-load.json').write_text(json.dumps(report,sort_keys=True)+'\n')
