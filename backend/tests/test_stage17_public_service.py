"""No listeners, real exports/deletions, credentials, providers or host access."""
import asyncio
import json
from datetime import datetime,timezone,timedelta
from types import SimpleNamespace
from uuid import uuid4
import pytest
from jose import jwt
from sqlalchemy import create_engine,select
from sqlalchemy.orm import Session
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB
from cryptography.fernet import Fernet
from app.domains.public_service.security import PublicIngress,validate_public_startup
from app.domains.public_service.operations import admission,fair_ready,diagnostics
from app.domains.public_service.privacy import PrivacyRequests,SyntheticPrivacyStore
from app.domains.public_service.drills import seal_fixture,restore_fixture,rotate_fixture
from app.domains.connections.crypto import ConnectionKeyring
from app.domains.ai_limits.contracts import BoundaryDenied
from app.core import security
from app.infrastructure.database.base import Base
import app.infrastructure.database.all_models
from app.domains.auth.models import User,ActivityLog
from app.infrastructure.database.outbox.models import OutboxMessage
NOW=datetime.now(timezone.utc)
@compiles(JSONB,'sqlite')
def sqlite_json(*args,**kwargs):return 'JSON'
@pytest.fixture
def token_env(monkeypatch):
    monkeypatch.setenv('CREDX_UAT2','0');monkeypatch.setenv('JWT_SIGNING_KEY','synthetic-'+('x'*40));monkeypatch.setattr(security.settings,'environment','test')
@pytest.mark.parametrize('field,value',[('aud','other'),('iss','https://other.invalid'),('type','id'),('exp',0),('iat',9999999999),('auth_time',True),('sub','-1'),('exp',None),('exp',float('inf')),('iat',float('nan')),('auth_time',float('inf'))])
def test_token_boundaries(token_env,field,value):
    token=security.JWTUtils.create_access_token(1,'synthetic@example.invalid','user');claims=security.JWTUtils.verify_token(token);assert claims['type']=='access';claims[field]=value
    forged=jwt.encode(claims,security.signing_key(),algorithm='HS256');assert security.JWTUtils.verify_token(forged) is None

def test_refresh_and_access_remain_distinct(token_env):
    assert security.JWTUtils.verify_token(security.JWTUtils.create_refresh_token(1,'synthetic@example.invalid'))['type']=='refresh'
    assert security.JWTUtils.verify_token(security.JWTUtils.create_access_token(1,'synthetic@example.invalid','user'))['type']=='access'
@pytest.mark.parametrize('changes',[{'auth_disabled':True},{'debug':True},{'frontend_url':'http://public.invalid'},{'environment':'unrecognized'}])
def test_public_startup_refuses_unsafe(token_env,changes):
    config={'environment':'production','auth_disabled':False,'debug':False,'frontend_url':'https://public.invalid'};config.update(changes)
    with pytest.raises(RuntimeError):validate_public_startup(SimpleNamespace(**config))
def test_public_key_never_uses_source_placeholder(token_env,monkeypatch):
    monkeypatch.setattr(security.settings,'environment','production');monkeypatch.delenv('JWT_SIGNING_KEY')
    with pytest.raises(RuntimeError):security.signing_key()
    monkeypatch.setenv('JWT_SIGNING_KEY','synthetic-'+('a'*40));assert security.signing_key()!='your-secret-key-change-in-production'

async def ingress(headers=(),bodies=(b'',),method='POST',socket=False):
    called=[];sent=[];messages=[{'type':'http.request','body':b,'more_body':i<len(bodies)-1} for i,b in enumerate(bodies)]
    async def app(scope,receive,send):called.append(True);await send({'type':'http.response.start','status':200});await send({'type':'http.response.body','body':b''})
    async def receive():return messages.pop(0)
    async def send(m):sent.append(m)
    await PublicIngress(app,frontend_url='https://local.invalid',max_body=1024)({'type':'websocket' if socket else 'http','headers':list(headers),'method':method},receive,send)
    return called,sent
@pytest.mark.parametrize('headers,bodies,status',[
 ([(b'origin',b'https://evil.invalid')],(b'',),403),
 ([(b'cookie',b'session=synthetic')],(b'',),403),
 ([(b'content-length',b'-1')],(b'',),400),
 ([(b'content-length',b'1')],(b'abc',),400),
 ([(b'content-length',b'1'),(b'transfer-encoding',b'chunked')],(b'a',),400),
 ([(b'content-length',b'1'),(b'content-length',b'2')],(b'',),400),
 ([],(b'a'*600,b'b'*600),413),
 ([(b'content-length',b'10000')],(b'',),413),
 ([(b'origin',b'https://local.invalid'),(b'origin',b'https://local.invalid')],(b'',),403),
])
def test_ingress_rejects_before_handler(headers,bodies,status):
    called,sent=asyncio.run(ingress(headers,bodies));assert not called and sent[0]['status']==status
@pytest.mark.parametrize('headers',[[],[(b'origin',b'https://local.invalid')],[(b'origin',b'https://local.invalid'),(b'cookie',b'session=synthetic')]])
def test_ingress_preserves_admitted_request(headers):assert asyncio.run(ingress(headers))[0]
@pytest.mark.parametrize('headers',[[],[(b'origin',b'https://evil.invalid')]])
def test_websocket_origin_gate(headers):
    called,sent=asyncio.run(ingress(headers,socket=True));assert not called and sent[0]['code']==1008

@pytest.fixture
def db(tmp_path):
    engine=create_engine('sqlite:///'+str(tmp_path/'synthetic.sqlite'))
    Base.metadata.create_all(engine,tables=[m.__table__ for m in (User,ActivityLog,OutboxMessage)])
    with Session(engine,expire_on_commit=False) as s:
        s.add_all([User(id=i,email=f'{i}@example.invalid',username=f'synthetic{i}',password_hash='synthetic-not-password',is_active=True) for i in (1,2)]);s.commit();yield s
    engine.dispose()
def test_owned_privacy_request_dedup_cancel_and_no_real_effect(db):
    p=PrivacyRequests(db);r=p.request(1,'key','delete',confirmed=True,now=NOW);db.commit();assert p.request(1,'key','delete',confirmed=True).id==r.id
    for owner in [2,99]:
        with pytest.raises(BoundaryDenied):p.owned(owner,r.id)
    with pytest.raises(BoundaryDenied):p.request(1,'key','export',confirmed=True)
    with pytest.raises(BoundaryDenied):p.drill(1,r.id,store=object(),now=NOW)
    p.cancel(1,r.id);db.commit()
    with pytest.raises(BoundaryDenied):p.drill(1,r.id,store=SyntheticPrivacyStore({1:{'synthetic':True}}),now=NOW)
    assert db.get(User,1).is_active
@pytest.mark.parametrize('kind',['export','delete'])
def test_synthetic_privacy_drill_scoped_and_expired(db,kind):
    p=PrivacyRequests(db);r=p.request(1,'key',kind,confirmed=True,now=NOW);db.commit();store=SyntheticPrivacyStore({1:{'synthetic':True,'display_name':'One','access_token':'NEVER_EXPORT'},2:{'synthetic':True,'display_name':'Two'}})
    with pytest.raises(BoundaryDenied):p.drill(1,r.id,store=store,now=NOW+timedelta(days=8))
    result=p.drill(1,r.id,store=store,now=NOW);db.commit();assert 'NEVER_EXPORT' not in json.dumps(result) and store.records[2]['display_name']=='Two';assert result['owner_id']==1
    with pytest.raises(BoundaryDenied):p.drill(1,r.id,store=store,now=NOW)
def test_privacy_binding_tamper_fails(db):
    p=PrivacyRequests(db);r=p.request(1,'key','delete',confirmed=True,now=NOW);r.payload={**r.payload,'kind':'export'};db.commit()
    with pytest.raises(BoundaryDenied):p.drill(1,r.id,store=SyntheticPrivacyStore({1:{'synthetic':True}}),now=NOW)
@pytest.mark.parametrize('kind',['execution','analysis'])
def test_uncertain_effects_never_replay(kind):
    with pytest.raises(BoundaryDenied):admission(kind,attempt=0,outcome='uncertain')
def test_reconciliation_separate_and_bounded():
    assert admission('reconciliation',attempt=1,outcome='uncertain')['queue']=='financial_reconciliation'
    with pytest.raises(BoundaryDenied):admission('reconciliation',attempt=3,outcome='uncertain')
def test_fair_queue_does_not_fill_all_slots_with_one_owner():
    rows=[{'id':i,'owner_id':owner,'created_at':NOW,'state':'queued'} for i,owner in [(1,1),(2,1),(3,2)]]
    assert fair_ready('analysis',rows,active_by_owner={},now=NOW)==[1,3]
    assert fair_ready('analysis',rows,active_by_owner={1:1},now=NOW)==[3]
@pytest.mark.parametrize('cost',['NaN','Infinity','-1','True'])
def test_diagnostics_nonfinite_rejected(cost):
    with pytest.raises(BoundaryDenied):diagnostics(correlation_id=str(uuid4()),stale_seconds=0,unknown_orders=0,cost_usd=cost,cap_usd='1')
def test_monitoring_is_bounded_redacted():
    result=diagnostics(correlation_id=str(uuid4()),stale_seconds=901,unknown_orders=1,cost_usd='2',cap_usd='1');assert result['stale_data'] and result['unknown_orders'] and result['cost_spike'] and result['action']=='pause_and_review'
def test_encrypted_rotation_preserves_binding_and_never_replays():
    one=ConnectionKeyring({1:Fernet.generate_key().decode()},1);two=ConnectionKeyring({2:Fernet.generate_key().decode()},2);source='a'*40
    sealed=seal_fixture(one,owner=1,source=source,document={'synthetic':True,'rows':[1]});rotated=rotate_fixture(one,two,sealed,owner=1,source=source)
    restored=restore_fixture(two,rotated,owner=1,source=source);assert not restored['replay_orders'] and not restored['resume_workflows'] and rotated['version']==2
    for owner in [2,True]:
        with pytest.raises(BoundaryDenied):restore_fixture(two,rotated,owner=owner,source=source)
    with pytest.raises(BoundaryDenied):restore_fixture(two,sealed,owner=1,source=source)

@pytest.mark.parametrize('mutation',[{'expires_at':(NOW+timedelta(days=99)).isoformat()},{'owner_id':2},{'key':'changed'},{'legal_approval':True}])
def test_privacy_receipt_metadata_cannot_be_relabelled(db,mutation):
    p=PrivacyRequests(db);r=p.request(1,'key','delete',confirmed=True,now=NOW);r.payload={**r.payload,**mutation};db.commit()
    with pytest.raises(BoundaryDenied):p.drill(1,r.id,store=SyntheticPrivacyStore({1:{'synthetic':True}}),now=NOW)

def test_execution_safe_failure_still_requires_explicit_review():
    with pytest.raises(BoundaryDenied):admission('execution',attempt=0,outcome='safe_failure')

def test_account_routes_keep_ownership_and_no_arbitrary_approval(db):
    import httpx
    from fastapi import FastAPI
    from app.domains.public_service.router import router
    from app.domains.auth.dependencies import get_current_user
    from app.infrastructure.database.session import get_async_db
    from app.domains.modules.coverage import classify_route
    class Bridge:
        async def run_sync(self,fn):return fn(db)
        async def commit(self):db.commit()
        async def rollback(self):db.rollback()
        async def execute(self,q):return db.execute(q)
        async def flush(self):db.flush()
        def add(self,row):db.add(row)
    bridge=Bridge();app=FastAPI();app.include_router(router);app.add_middleware(PublicIngress,frontend_url='http://synthetic.invalid')
    owner=[1];app.dependency_overrides[get_current_user]=lambda:db.get(User,owner[0]);app.dependency_overrides[get_async_db]=lambda:bridge
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://synthetic.invalid') as c:
            r=await c.post('/account/operations/privacy-requests',json={'key':'once','kind':'delete','confirmed':True});assert r.status_code==200 and r.json()['state']=='retention_review_required' and r.headers['cache-control']=='private, no-store';id=r.json()['id']
            r=await c.post('/account/operations/privacy-requests',json={'key':'once','kind':'delete','confirmed':'yes'});assert r.status_code==422
            owner[0]=2;assert (await c.get('/account/operations/privacy-requests/'+id)).status_code==404
            assert (await c.post('/account/operations/privacy-requests/'+id+'/cancel')).status_code==404
            owner[0]=1
            r=await c.post('/account/operations/eligibility',json={'country':'IN'});assert r.status_code==200 and r.json()['eligible']is False
            assert (await c.post('/account/operations/eligibility',json={'country':'US'})).status_code==409
            owner[0]=2;assert (await c.get('/account/operations/eligibility')).json()['status']=='unknown'
            assert (await c.post('/account/operations/privacy-requests/'+id+'/approve')).status_code==404
    asyncio.run(run())
    assert classify_route('public_service','privacy_request','/account/operations/privacy-requests',{'POST'})is None
    assert classify_route('public_service','approve','/account/operations/privacy-requests/{id}/approve',{'POST'})==('unknown','view')

@pytest.mark.parametrize('env,disabled,url,allowed',[
 ('production',True,'https://public.invalid',False),('development',False,'http://localhost:3000',False),
 ('development',True,'http://localhost:3000',True),('development',True,'https://public.invalid',False),
 ('test',True,'http://127.0.0.1:3000',True)])
def test_auth_bypass_requires_explicit_isolated_development(monkeypatch,env,disabled,url,allowed):
    from app.domains.auth.dependencies import is_auth_disabled
    monkeypatch.setenv('CREDX_UAT2','0');monkeypatch.setattr(security.settings,'environment',env);monkeypatch.setattr(security.settings,'auth_disabled',disabled);monkeypatch.setattr(security.settings,'frontend_url',url)
    assert is_auth_disabled()is allowed


@pytest.mark.parametrize('message',[
 'Cookie: safe=1; session=synthetic-sensitive-value', 'Set-Cookie: session=synthetic-sensitive-value; Secure',
 'access_token=synthetic-sensitive-value', 'api_key: synthetic-sensitive-value',
 'Authorization: Bearer synthetic-sensitive-value', 'redis://user:synthetic-sensitive-value@localhost:1/0',
 '{"password":"synthetic-sensitive-value"}', 'https://local.invalid/?request_token=synthetic-sensitive-value',
])
def test_log_redaction_at_format_boundary(message):
    import logging
    from app.domains.public_service.redaction import RedactingFormatter
    record=logging.LogRecord('synthetic',logging.ERROR,'synthetic.py',1,'upstream %s',(message,),None)
    assert 'synthetic-sensitive-value' not in RedactingFormatter('%(message)s').format(record)


def test_account_operations_require_authentication_without_database_lookup(monkeypatch):
    import httpx
    from fastapi import FastAPI
    from app.domains.public_service.router import router
    from app.infrastructure.database.session import get_async_db
    monkeypatch.setattr(security.settings,'auth_disabled',False)
    class NoDatabase:
        async def execute(self,*args):raise AssertionError('anonymous request reached database')
    app=FastAPI();app.include_router(router);app.dependency_overrides[get_async_db]=lambda:NoDatabase()
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://synthetic.invalid') as c:
            assert (await c.get('/account/operations/eligibility')).status_code==401
            assert (await c.post('/account/operations/privacy-requests',json={'key':'one','kind':'delete','confirmed':True})).status_code==401
    asyncio.run(run())
