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

@pytest.mark.parametrize('message,forbidden',[
 ('Authorization: Basic U1lOVEhFVElDX1NFQ1JFVA==','U1lOVEhFVElDX1NFQ1JFVA=='),
 (r'upstream {"\u0070assword":"SYNTHETIC escaped key"}', 'SYNTHETIC'),
 (r'upstream {\"password\":\"SYNTHETIC escaped quotes\"}', 'SYNTHETIC'),
 ('{"password":"SYNTHETIC first second"}','SYNTHETIC first second'),
 ("{'api_secret': 'SYNTHETIC_SECRET'}",'SYNTHETIC_SECRET'),
 ('upstream {"password": "SYNTHETIC first second"} end','first second'),
 ("upstream {'api_secret': 'SYNTHETIC_SECRET'} end",'SYNTHETIC_SECRET'),
 ('Proxy-Authorization: Digest username="SYNTHETIC user", response="SYNTHETIC digest"','SYNTHETIC'),
 ('password="SYNTHETIC first\\\" second" trace','SYNTHETIC'),
 ("password = 'SYNTHETIC first\nsecond'",'second'),
 ('Cookie: a=one; session=SYNTHETIC cookie with spaces','SYNTHETIC'),
 ('Basic U1lOVEhFVElDX1NFQ1JFVA==','U1lOVEhFVElDX1NFQ1JFVA=='),
 ('OPENAI_API_KEY=SYNTHETIC provider value','SYNTHETIC'),
 ('apiKey=SYNTHETIC value with spaces&status=ok','SYNTHETIC'),
 ('{"outer":[{"accessToken":{"nested":"SYNTHETIC"}},{"safe":"ok"}]}','SYNTHETIC'),
 ("{'outer': [{'client-secret': ['SYNTHETIC', 'tail']}], 'status': 'ok'}",'SYNTHETIC'),
])
def test_complete_credential_values_are_removed(message,forbidden):
    import logging
    from app.domains.public_service.redaction import RedactingFormatter
    record=logging.LogRecord('synthetic',logging.ERROR,'synthetic.py',1,'%s',(message,),None)
    for fmt in ['%(message)s','%(levelname)s %(message)s']:
        value=RedactingFormatter(fmt).format(record)
        assert forbidden not in value and '[redacted]' in value

@pytest.mark.parametrize('document',[
 {'password':'SYNTHETIC first second','status':'ok'},
 {'OPENAI_API_KEY':'SYNTHETIC provider','smtpPassword':'SYNTHETIC password','status':'ok'},
 {'nested':[{'api_secret':'SYNTHETIC'}, {'status':'ok'}]},
 {'Authorization':{'scheme':'Basic','value':'SYNTHETIC'},'status':'ok'},
 {'cookie':['SYNTHETIC one','SYNTHETIC two'],'status':'ok'},
 {'safe':'{"password":"SYNTHETIC nested string","status":"ok"}','status':'ok'},
])
def test_structured_redaction_preserves_noncredential_fields(document):
    from app.domains.public_service.redaction import redact
    for representation in [document,json.dumps(document),repr(document)]:
        value=redact(representation)
        assert 'SYNTHETIC' not in value and 'ok' in value
        assert isinstance(json.loads(value),dict)

def test_redaction_bounds_malformed_and_oversized_input():
    from app.domains.public_service.redaction import redact
    assert redact('x'*65537)=='[redacted]'
    value={'password':'SYNTHETIC'}
    for _ in range(20):value={'nested':value}
    assert 'SYNTHETIC' not in redact(value)
    assert 'SYNTHETIC' not in redact('prefix password = "SYNTHETIC broken\nremaining')


@pytest.mark.parametrize('argument',[
 json.dumps('{"password":"SYNTHETIC wrapped JSON"}'),
 '{"\\u0070assword":"SYNTHETIC encoded key"}',
 {"nested":[{"api_key":"SYNTHETIC structured argument"}]},
])
def test_structured_arguments_redact_before_log_prefix(argument):
    import logging
    from app.domains.public_service.redaction import RedactingFormatter
    record=logging.LogRecord('synthetic',logging.ERROR,'synthetic.py',1,'upstream %s',(argument,),None)
    original_args=record.args
    value=RedactingFormatter('%(levelname)s %(message)s').format(record)
    assert 'SYNTHETIC' not in value and record.args is original_args

def test_redactor_retains_ordinary_numeric_formatting():
    import logging
    from app.domains.public_service.redaction import RedactingFormatter
    record=logging.LogRecord('synthetic',logging.INFO,'synthetic.py',1,'status=%d elapsed=%.2f',(200,1.25),None)
    assert RedactingFormatter('%(message)s').format(record)=='status=200 elapsed=1.25'

@pytest.mark.parametrize('message,args',[
 ('OTP token=%(token)d',{'token':123456}),
 ('cost=%.2f password=%s',(__import__('decimal').Decimal('1.25'),'SYNTHETIC_FORMAT_SECRET')),
 ('password=%s count=%d',('SYNTHETIC_FORMAT_SECRET','not-a-number')),
 ('password=%(password)s missing=%(missing)s',{'password':'SYNTHETIC_FORMAT_SECRET'}),
 ('password=%s %s',('SYNTHETIC_FORMAT_SECRET',)),
])
def test_actual_stream_handler_never_dumps_original_args_on_format_error(message,args):
    import contextlib,io,logging
    from app.domains.public_service.redaction import RedactingFormatter
    output=io.StringIO();stderr=io.StringIO();handler=logging.StreamHandler(output)
    handler.setFormatter(RedactingFormatter('%(message)s'))
    record=logging.LogRecord('synthetic',logging.ERROR,'synthetic.py',1,message,(args,) if isinstance(args,dict) else args,None)
    original_args=record.args;previous=logging.raiseExceptions;logging.raiseExceptions=True
    try:
        with contextlib.redirect_stderr(stderr):handler.handle(record)
    finally:logging.raiseExceptions=previous
    for value in [output.getvalue(),stderr.getvalue()]:
        assert 'SYNTHETIC_FORMAT_SECRET' not in value and '123456' not in value
        assert 'Arguments:' not in value and '--- Logging error ---' not in value
    assert stderr.getvalue()=='' and '[redacted' in output.getvalue()
    assert record.args is original_args

def test_decimal_nonsecret_numeric_formats_remain_valid():
    import logging
    from decimal import Decimal
    from app.domains.public_service.redaction import RedactingFormatter
    formatter=RedactingFormatter('%(message)s')
    record=logging.LogRecord('synthetic',logging.INFO,'synthetic.py',1,'cost=%.2f status=%d',(Decimal('1.25'),200),None)
    assert formatter.format(record)=='cost=1.25 status=200'
    mapping=logging.LogRecord('synthetic',logging.INFO,'synthetic.py',1,'cost=%(cost).2f status=%(status)d',({'cost':Decimal('1.25'),'status':200},),None)
    assert formatter.format(mapping)=='cost=1.25 status=200'

def test_invalid_formatter_schema_fails_closed_without_stderr():
    import contextlib,io,logging
    from app.domains.public_service.redaction import RedactingFormatter
    output=io.StringIO();stderr=io.StringIO();handler=logging.StreamHandler(output)
    handler.setFormatter(RedactingFormatter('%(missing_record_attribute)s %(message)s'))
    record=logging.LogRecord('synthetic',logging.ERROR,'synthetic.py',1,'password=%s',('SYNTHETIC_FORMAT_SECRET',),None)
    with contextlib.redirect_stderr(stderr):handler.handle(record)
    assert stderr.getvalue()=='' and output.getvalue()=='[redacted log: formatting failed]\n'

def test_installed_safe_handlers_do_not_report_records_on_io_or_rotation_failure(tmp_path,monkeypatch):
    import contextlib,io,logging
    from app.domains.public_service.redaction import RedactingFormatter,RedactingStreamHandler,RedactingRotatingFileHandler
    class BrokenStream:
        def write(self,value):raise OSError('SYNTHETIC_OUTPUT_SECRET')
        def flush(self):pass
    stream=RedactingStreamHandler(BrokenStream())
    file=RedactingRotatingFileHandler(tmp_path/'synthetic.log',maxBytes=1,backupCount=1)
    monkeypatch.setattr(file,'shouldRollover',lambda record:True)
    def failed_rotation():raise OSError('SYNTHETIC_OUTPUT_SECRET')
    monkeypatch.setattr(file,'doRollover',failed_rotation)
    record=logging.LogRecord('synthetic',logging.ERROR,'synthetic.py',1,'password=%s',('SYNTHETIC_FORMAT_SECRET',),None)
    previous=logging.raiseExceptions;logging.raiseExceptions=True
    try:
        for handler in [stream,file]:
            handler.setFormatter(RedactingFormatter('%(message)s'));stderr=io.StringIO()
            with contextlib.redirect_stderr(stderr):handler.handle(record)
            assert stderr.getvalue()=='[redacted logging output failure]\n'
            assert 'SYNTHETIC' not in stderr.getvalue() and 'Arguments:' not in stderr.getvalue()
    finally:logging.raiseExceptions=previous;file.close();stream.close()

def test_logging_configuration_installs_safe_handler_classes():
    from app.core.logging import LOGGING_CONFIG
    assert all(h['class'].startswith('app.domains.public_service.redaction.Redacting') for h in LOGGING_CONFIG['handlers'].values())


@pytest.mark.parametrize('failed_boundary',['_clean','redact'])
def test_unexpected_redactor_failure_cannot_escape_to_logging_stderr(monkeypatch,failed_boundary):
    import contextlib,io,logging
    from app.domains.public_service import redaction
    def fail(*args,**kwargs):raise RuntimeError('SYNTHETIC_INTERNAL_SECRET')
    monkeypatch.setattr(redaction,failed_boundary,fail)
    output=io.StringIO();stderr=io.StringIO();handler=logging.StreamHandler(output)
    handler.setFormatter(redaction.RedactingFormatter('%(message)s'))
    logger=logging.Logger('synthetic-fault',level=logging.DEBUG);logger.addHandler(handler);logger.propagate=False
    with contextlib.redirect_stderr(stderr):logger.error('password=%s','SYNTHETIC_FORMAT_SECRET')
    assert stderr.getvalue()=='' and output.getvalue()=='[redacted log: formatting failed]\n'


@pytest.mark.parametrize('fault,reason',[
 ('missing_key','independent signing key'),
 ('auth_bypass','Auth bypass requires'),
 ('debug','authentication and debug disabled'),
 ('http_origin','HTTPS frontend origin'),
])
def test_actual_public_lifespan_keeps_security_guards_before_any_effect(monkeypatch,fault,reason):
    from fastapi.testclient import TestClient
    import app.main as main
    monkeypatch.setenv('CREDX_UAT2','0')
    monkeypatch.setenv('CREDX_RECOVERY_MODE','1')
    monkeypatch.setenv('JWT_SIGNING_KEY','synthetic-startup-only-'+'x'*40)
    monkeypatch.setattr(main.settings,'environment','production')
    monkeypatch.setattr(main.settings,'auth_disabled',False)
    monkeypatch.setattr(main.settings,'debug',False)
    monkeypatch.setattr(main.settings,'frontend_url','https://synthetic.invalid')
    if fault=='missing_key':monkeypatch.delenv('JWT_SIGNING_KEY')
    if fault=='auth_bypass':monkeypatch.setattr(main.settings,'auth_disabled',True)
    if fault=='debug':monkeypatch.setattr(main.settings,'debug',True)
    if fault=='http_origin':monkeypatch.setattr(main.settings,'frontend_url','http://synthetic.invalid')
    def no_effect(*args,**kwargs):raise AssertionError('startup reached database/broker before rejecting unsafe configuration')
    monkeypatch.setattr(main,'AsyncSessionLocal',no_effect)
    monkeypatch.setattr(main,'get_bullpen_runtime_broker',no_effect)
    with pytest.raises(RuntimeError,match=reason):
        with TestClient(main.app):pass
