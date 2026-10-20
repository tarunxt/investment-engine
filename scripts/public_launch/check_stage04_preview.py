"""Real loopback API/BFF operation replay; fake offline consumer, synthetic rows.

Never retains credentials, access tokens, cookies or authentication responses.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urlsplit
from uuid import uuid4

import requests
from sqlalchemy import create_engine, MetaData, Table, select

ROOT=Path(__file__).resolve().parents[2]


def main():
    state=json.loads((ROOT/'.runtime/stage01-preview/state.json').read_text())
    assert state['synthetic'] and urlsplit(state['backend_url']).hostname=='127.0.0.1'
    api=state['backend_url'];web=f"http://localhost:{state['frontend_port']}"
    key='stage04-preview-'+uuid4().hex
    body={'prompt':'Stage04 private synthetic durable operation','provider':'synthetic','model':'offline','user_id':999999}
    sessions=[]
    for name in ('usera','userb'):
        direct,bff=requests.Session(),requests.Session()
        direct.trust_env=bff.trust_env=False
        credentials={'email':name+'@stage01.example.com','password':'SyntheticPreview123!'}
        auth=direct.post(api+'/auth/login',json=credentials,timeout=10);assert auth.status_code==200
        direct.headers['Authorization']='Bearer '+auth.json()['access_token']
        owner=direct.get(api+'/auth/me',timeout=10).json()['id']
        csrf=bff.get(web+'/api/auth/csrf',timeout=10).json()['csrfToken']
        r=bff.post(web+'/api/auth/callback/credentials',data={**credentials,'csrfToken':csrf,'callbackUrl':web+'/console/jobs'},allow_redirects=False,timeout=10)
        assert r.status_code in (200,302,303)
        sessions.append((direct,bff,owner))
    a,b=sessions
    headers={'Idempotency-Key':key}
    def create(_):
        r=a[0].post(api+'/jobs',json=body,headers=headers,timeout=15)
        assert r.status_code==200,(r.status_code,r.text[:150])
        return r.json()['id']
    with ThreadPoolExecutor(max_workers=8) as executor:ids=list(executor.map(create,range(8)))
    assert len(set(ids))==1
    aid=ids[0]
    replay=a[1].post(web+'/backend-api/jobs',json=body,headers=headers,timeout=10)
    assert replay.status_code==200 and replay.json()['id']==aid
    conflict=a[1].post(web+'/backend-api/jobs',json={**body,'prompt':body['prompt']+' changed'},headers=headers,timeout=10)
    assert conflict.status_code==409
    other=b[1].post(web+'/backend-api/jobs',json=body,headers=headers,timeout=10)
    assert other.status_code==200
    bid=other.json()['id'];assert bid!=aid
    for direct,bff,foreign in [(a[0],a[1],bid),(b[0],b[1],aid)]:
        assert direct.get(f'{api}/jobs/{foreign}',timeout=10).status_code==404
        assert bff.get(f'{web}/backend-api/jobs/{foreign}',timeout=10).status_code==404
    for direct,_,id in [(a[0],a[1],aid),(b[0],b[1],bid)]:
        deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            result=direct.get(f'{api}/jobs/{id}',timeout=5).json()
            if result['status']=='completed':break
            time.sleep(.1)
        assert result['status']=='completed' and result['response'].startswith('SYNTHETIC OFFLINE')
    engine=create_engine(f"sqlite:///{ROOT/'.runtime/stage01-preview/preview.sqlite3'}")
    metadata=MetaData();operations=Table('idempotency_operations',metadata,autoload_with=engine)
    with engine.connect() as connection:
        rows=list(connection.execute(select(operations).where(operations.c.key_digest==hashlib.sha256(key.encode()).hexdigest())).mappings())
        assert len(rows)==2 and {row['user_id'] for row in rows}=={a[2],b[2]}
        assert {row['job_id'] for row in rows}=={aid,bid}
    engine.dispose()
    report={'result':'passed','frontend_url':web,'backend_url':api,'checks':['eight real concurrent API requests one job','BFF owned replay','different payload409','same key across owners independent','known foreign direct/BFF404','actual outbox with offline fake completion','durable SQLite bindings, not Redis cache'],
            'jobs':{'usera':aid,'userb':bid},'tokens_cookies_credentials_retained':False,
            'scope':'Synthetic localhost only. Distributed PostgreSQL/Redis consumer proof is separate Docker/CI gate; no UAT2 signed-in claim.'}
    (ROOT/'.runtime/stage01-preview/stage04-replay.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()
