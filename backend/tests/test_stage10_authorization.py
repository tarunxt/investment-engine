"""Stage10 uses actual registry and SQL compare-and-swap, synthetic provider only."""
from datetime import datetime,timedelta,timezone
import pytest
from sqlalchemy import select,update
from app.domains.connections.authorization import ConnectionAuthorization
from app.domains.connections.models import ConnectionAttempt,IntegrationConnection
from app.domains.connections.crypto import ConnectionFault
from app.domains.connections.fake_authorization import FakeKiteAuthorization
from app.domains.modules.models import UserModule,UserModulePreferences
from test_stage09_connections import bindings,active
from test_private_api_ownership import private_api

@pytest.fixture
def auth(bindings):
    a=bindings
    for model in (ConnectionAttempt,UserModulePreferences,UserModule):model.__table__.create(a.session.get_bind())
    a.provider=FakeKiteAuthorization()
    a.authorization=ConnectionAuthorization(a.store,a.provider,callback_url='http://localhost:54321/console/profile/connections',allowed_callbacks={'http://localhost:54321/console/profile/connections'})
    return a

async def setup(a,mode='user_owned',current=True):
    args={'app_key':'fake-key','app_secret':'fake-secret'} if mode=='user_owned' else {'platform_ref':'fake-platform'}
    return await a.store.provision(a.users[0].id,mode=mode,is_current=current,**args)

async def callback(a,row,token='fake-ok'):
    start=await a.authorization.start(row.owner_id,row.id,row.version,'session-a')
    result=await a.authorization.callback(row.owner_id,start['attempt_id'],'session-a',state=start['state'],request_token=token)
    return start,result

@pytest.mark.asyncio
@pytest.mark.parametrize('mode',['user_owned','platform_managed'])
async def test_both_modes_review_renew_disconnect_preserve_identity(auth,mode):
    a=auth;row=await setup(a,mode);start,result=await callback(a,row)
    assert result['review_required'] and result['account_label']=='***WNER'
    assert 'fake-secret' not in str(result) and 'access_token' not in result
    await a.authorization.confirm(row.owner_id,start['attempt_id'],'session-a',version=1)
    assert (await a.store.resolve_token(row.owner_id)).token.get_secret_value()=='synthetic-only-token'
    assert row.version==2 and row.provider_account_id=='FAKEOWNER'
    start,_=await callback(a,row)
    await a.authorization.confirm(row.owner_id,start['attempt_id'],'session-a',version=2)
    a.provider.revoke_success=False
    result=await a.authorization.disconnect(row.owner_id,row.id,3)
    assert result['local_disabled'] and not result['provider_revoked'] and result['identity_retained']
    assert row.provider_account_id=='FAKEOWNER' and row.status=='disabled'
    with pytest.raises(ConnectionFault):await a.store.resolve_token(row.owner_id)
    # Explicit reconnection after disable is supported.
    start,_=await callback(a,row)
    await a.authorization.confirm(row.owner_id,start['attempt_id'],'session-a',version=4)
    assert row.status=='active'

@pytest.mark.asyncio
@pytest.mark.parametrize('mode',['user_owned','platform_managed'])
async def test_callback_replay_session_state_expiry_foreign_version(auth,mode):
    a=auth;row=await setup(a,mode);s=await a.authorization.start(row.owner_id,row.id,1,'session-a')
    for owner,session,state,code in [(row.owner_id,'other',s['state'],'SESSION_MISMATCH'),(row.owner_id,'session-a','x'*32,'STATE_MISMATCH'),(a.users[1].id,'session-a',s['state'],'NOT_FOUND')]:
        with pytest.raises(ConnectionFault,match=code):await a.authorization.callback(owner,s['attempt_id'],session,state=state,request_token='fake-ok')
    assert a.provider.exchanges==0
    await a.authorization.callback(row.owner_id,s['attempt_id'],'session-a',state=s['state'],request_token='fake-ok')
    with pytest.raises(ConnectionFault,match='ALREADY_USED'):await a.authorization.callback(row.owner_id,s['attempt_id'],'session-a',state=s['state'],request_token='fake-ok')
    assert a.provider.exchanges==1
    s=await a.authorization.start(row.owner_id,row.id,1,'session-a')
    await a.db.execute(update(ConnectionAttempt).where(ConnectionAttempt.id==s['attempt_id']).values(expires_at=datetime.now(timezone.utc)-timedelta(seconds=1)));await a.db.commit()
    with pytest.raises(ConnectionFault,match='EXPIRED'):await a.authorization.callback(row.owner_id,s['attempt_id'],'session-a',state=s['state'],request_token='fake-ok')
    s=await a.authorization.start(row.owner_id,row.id,1,'session-a')
    await a.store.rotate(row.owner_id,row.id,1,2)
    with pytest.raises(ConnectionFault,match='VERSION_CHANGED'):await a.authorization.callback(row.owner_id,s['attempt_id'],'session-a',state=s['state'],request_token='fake-ok')

@pytest.mark.asyncio
async def test_failure_does_not_overwrite_valid_binding_and_cannot_retry(auth):
    a=auth;row=await active(a,a.users[0].id);original=(await a.store.material(row))[0].ciphertext
    s=await a.authorization.start(row.owner_id,row.id,row.version,'session-a')
    with pytest.raises(ConnectionFault):await a.authorization.callback(row.owner_id,s['attempt_id'],'session-a',state=s['state'],request_token='fake-failure')
    a.session.expire_all();row=await a.store.get(a.users[0].id,row.id)
    assert (await a.store.material(row))[0].ciphertext==original
    with pytest.raises(ConnectionFault,match='ALREADY_USED'):await a.authorization.callback(row.owner_id,s['attempt_id'],'session-a',state=s['state'],request_token='fake-ok')

@pytest.mark.asyncio
async def test_account_mode_switch_requires_fresh_review_pauses_stale_jobs(auth):
    a=auth;old=await active(a,a.users[0].id)
    pref=UserModulePreferences(user_id=old.owner_id,version=7)
    a.session.add(pref);a.session.flush()
    module=UserModule(user_id=old.owner_id,module_id='ai_studio',version=3,enabled=True,schedules_paused=False)
    a.session.add(module);a.jobs[0].module_id='ai_studio';a.session.commit()
    new=await setup(a,'platform_managed',False);s,_=await callback(a,new,'fake-other-account')
    with pytest.raises(ConnectionFault,match='CURRENT_REVIEW'):await a.authorization.confirm(new.owner_id,s['attempt_id'],'session-a',version=1)
    a.session.expire_all()
    await a.authorization.confirm(a.users[0].id,s['attempt_id'],'session-a',version=1,previous_id=old.id,previous_version=2)
    a.session.expire_all()
    assert (await a.store.current(a.users[0].id)).id==new.id
    assert module.schedules_paused and module.version==4 and pref.version==8 and a.jobs[0].module_cancel_requested
    assert (await a.store.get(a.users[0].id,old.id)).provider_account_id=='FAKEA'
    with pytest.raises(ConnectionFault):await a.authorization.confirm(a.users[0].id,s['attempt_id'],'session-a',version=1)

@pytest.mark.asyncio
async def test_invalid_provider_identity_and_missing_approval(auth):
    a=auth;row=await setup(a)
    original=a.provider.exchange
    async def wrong(app,token):
        result=await original(app,token);result['api_key']='foreign';return result
    a.provider.exchange=wrong
    with pytest.raises(ConnectionFault,match='IDENTITY_INVALID'):await callback(a,row)
    assert row.status=='configured' and row.provider_account_id is None
    a.platform.approved=False
    row=await setup(a,'platform_managed',False)
    with pytest.raises(ConnectionFault,match='APPROVAL_REQUIRED'):await a.authorization.start(row.owner_id,row.id,1,'session-a')

@pytest.mark.asyncio
async def test_token_expiry_and_revoke_success_are_not_local_disable(auth):
    a=auth;row=await active(a,a.users[0].id)
    await a.db.execute(update(IntegrationConnection).where(IntegrationConnection.id==row.id).values(token_expires_at=datetime.now(timezone.utc)-timedelta(seconds=1)));await a.db.commit()
    with pytest.raises(ConnectionFault,match='EXPIRED'):await a.store.resolve_token(row.owner_id)
    result=await a.authorization.disconnect(row.owner_id,row.id,row.version)
    assert result['local_disabled'] and not result['provider_revoked'] and a.provider.revocations==0


def test_redirect_allowlist_rejects_open_redirect(auth):
    with pytest.raises(ConnectionFault,match='ALLOWLISTED'):
        ConnectionAuthorization(auth.store,auth.provider,callback_url='https://evil.invalid/callback',allowed_callbacks={'https://uat2.cred-x.in/console/profile/connections'})

@pytest.mark.asyncio
async def test_provider_revocation_preserves_identity_and_blocks_resolution(auth):
    a=auth;row=await active(a,a.users[0].id)
    await a.authorization.mark_revoked(row.owner_id,row.id,2)
    assert row.status=='revoked' and row.provider_account_id=='FAKEA' and row.version==3
    with pytest.raises(ConnectionFault,match='NOT_ACTIVE'):await a.store.resolve_token(row.owner_id)


def test_actual_http_paths_use_authenticated_session_and_fail_closed_default(auth):
    from app.domains.connections.authorization_router import router,authorization_runtime
    a=auth;a.app.include_router(router)
    assert a.client.post('/me/connection-authorization/start',json={'connection_id':'missing','version':1}).status_code==401
    assert a.client.post('/me/connection-authorization/start',headers=a.headers[0],json={'connection_id':'missing','version':1}).status_code==503
    callback_url='http://localhost:54321/console/profile/connections'
    a.app.dependency_overrides[authorization_runtime]=lambda:{'provider':a.provider,'callback_url':callback_url,'allowed_callbacks':{callback_url},'synthetic_setup':True,'synthetic_platform_ref':'fake-platform'}
    root='/me/connection-authorization'
    for mode in ['user_owned','platform_managed']:
        setup=a.client.post(root+'/synthetic-setup',headers=a.headers[0],json={'mode':mode});assert setup.status_code==200
        row=setup.json()
        start=a.client.post(root+'/start',headers=a.headers[0],json={'connection_id':row['connection_id'],'version':1});assert start.status_code==200
        attempt=start.json();body={'attempt_id':attempt['attempt_id'],'state':attempt['state'],'request_token':'fake-ok'}
        assert a.client.post(root+'/callback',headers=a.headers[1],json=body).status_code==404
        from app.core.security import JWTUtils
        replaced={'Authorization':'Bearer '+JWTUtils.create_access_token(a.users[0].id,a.users[0].email,'user')}
        assert a.client.post(root+'/callback',headers=replaced,json=body).status_code==403
        response=a.client.post(root+'/callback',headers=a.headers[0],json=body);assert response.status_code==200
        assert 'synthetic-only-token' not in response.text
        current=a.session.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id==a.users[0].id,IntegrationConnection.is_current.is_(True)))
        review={'attempt_id':attempt['attempt_id'],'version':1,'previous_id':current.id if current else None,'previous_version':current.version if current else None}
        assert a.client.post(root+'/confirm',headers=a.headers[0],json=review).status_code==200
        assert a.client.post(root+'/callback',headers=a.headers[0],json=body).status_code in {409,400}
        disconnected=a.client.post(root+'/disconnect',headers=a.headers[0],json={'connection_id':row['connection_id'],'version':2}).json()
        assert disconnected['local_disabled'] and disconnected['provider_revoked'] and disconnected['provider_revocation_status']=='simulated'

@pytest.mark.parametrize('mode',['user_owned','platform_managed'])
def test_parallel_claims_have_one_winner_with_independent_sql_connections(tmp_path,mode):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from sqlalchemy import create_engine,insert
    from app.domains.connections.authorization import claim_statement
    engine=create_engine('sqlite:///'+str(tmp_path/'claims.sqlite'),connect_args={'timeout':5})
    ConnectionAttempt.__table__.create(engine)
    clock=datetime.now(timezone.utc)
    with engine.begin() as db:
        db.execute(insert(ConnectionAttempt).values(id='attempt',owner_id=1,connection_id='connection',connection_version=1,app_mode=mode,
            app_fingerprint='f'*64,session_digest='s'*64,state_digest='x'*64,expires_at=clock+timedelta(minutes=1)))
    barrier=Barrier(2)
    def claim():
        barrier.wait(timeout=5)
        with engine.begin() as db:return db.execute(claim_statement(1,'attempt',clock)).rowcount
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:claim(),range(2)))
    assert sorted(results)==[0,1]
    engine.dispose()

@pytest.mark.asyncio
async def test_review_session_swap_expiry_and_confirm_parallel_candidate_version(auth):
    a=auth;row=await setup(a);s,_=await callback(a,row)
    with pytest.raises(ConnectionFault,match='SESSION_MISMATCH'):await a.authorization.confirm(row.owner_id,s['attempt_id'],'other-session',version=1)
    second,_=await callback(a,row)
    await a.authorization.confirm(row.owner_id,s['attempt_id'],'session-a',version=1)
    with pytest.raises(ConnectionFault,match='VERSION_CHANGED'):await a.authorization.confirm(row.owner_id,second['attempt_id'],'session-a',version=1)
    assert row.provider_account_id=='FAKEOWNER' and row.version==2

@pytest.mark.asyncio
async def test_official_wire_protocol_uses_checksum_and_never_returns_secret(auth):
    import hashlib
    from app.domains.connections.kite_authorization import KiteAuthorizationProtocol
    from app.domains.connections.material import BoundToken
    from pydantic import SecretStr
    calls=[]
    async def transport(method,url,**kwargs):
        calls.append((method,url,kwargs))
        return {'status':'success','data':{'api_key':'fake-shared-key','broker':'ZERODHA','user_id':'FAKE1','access_token':'synthetic-token'}} if method=='POST' else {'status':'success','data':True}
    provider=KiteAuthorizationProtocol(transport,clock=lambda:datetime(2026,10,20,12,tzinfo=timezone.utc))
    app=auth.app_material
    result=await provider.exchange(app,'fake-request')
    assert calls[0][2]['data']['checksum']==hashlib.sha256(b'fake-shared-keyfake-requestfake-shared-secret').hexdigest()
    assert 'app_secret' not in result and result['expires_at']==datetime(2026,10,21,0,30,tzinfo=timezone.utc)
    assert await provider.revoke(BoundToken(1,'fake',1,app,SecretStr('synthetic-token'),result['expires_at']))
    assert calls[-1][0]=='DELETE' and calls[-1][2]['params']['api_key']=='fake-shared-key'

@pytest.mark.parametrize('hour,minute,expected_day',[(0,0,20),(0,30,21),(23,59,21)])
def test_india_six_am_expiry_boundary(hour,minute,expected_day):
    from app.domains.connections.kite_authorization import next_kite_expiry
    assert next_kite_expiry(datetime(2026,10,20,hour,minute,tzinfo=timezone.utc))==datetime(2026,10,expected_day,0,30,tzinfo=timezone.utc)

@pytest.mark.asyncio
async def test_redirect_roundtrip_contains_only_supported_params(auth):
    from urllib.parse import urlsplit,parse_qs
    row=await setup(auth)
    attempt=await auth.authorization.start(row.owner_id,row.id,1,'session-a')
    parsed=urlsplit(attempt['login_url']);params=parse_qs(parsed.query)
    assert parsed.scheme=='https' and parsed.hostname=='kite.zerodha.com'
    assert set(params)=={'v','api_key','redirect_params'}
    roundtrip=parse_qs(params['redirect_params'][0])
    assert roundtrip=={'state':[attempt['state']],'attempt_id':[attempt['attempt_id']]}
    assert 'fake-secret' not in attempt['login_url']

@pytest.mark.asyncio
async def test_review_expiry_leaves_active_connection_and_history_intact(auth):
    a=auth;row=await active(a,a.users[0].id);original=(await a.store.material(row))[0].ciphertext
    s,_=await callback(a,row)
    await a.db.execute(update(ConnectionAttempt).where(ConnectionAttempt.id==s['attempt_id']).values(expires_at=datetime.now(timezone.utc)-timedelta(seconds=1)));await a.db.commit()
    with pytest.raises(ConnectionFault,match='EXPIRED'):await a.authorization.confirm(row.owner_id,s['attempt_id'],'session-a',version=row.version)
    assert (await a.store.material(row))[0].ciphertext==original

@pytest.mark.asyncio
async def test_superseded_binding_remains_reconnectable_with_fresh_review(auth):
    a=auth;old=await active(a,a.users[0].id)
    new=await setup(a,'platform_managed',False);s,_=await callback(a,new)
    await a.authorization.confirm(new.owner_id,s['attempt_id'],'session-a',version=1,previous_id=old.id,previous_version=2)
    s,_=await callback(a,old)
    await a.authorization.confirm(old.owner_id,s['attempt_id'],'session-a',version=3,previous_id=new.id,previous_version=2)
    assert (await a.store.current(old.owner_id)).id==old.id and old.version==4
