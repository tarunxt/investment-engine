"""Synthetic SQL/HTTP/transport contracts for both connection ownership modes."""
import asyncio,json
from datetime import datetime,timedelta,timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest,httpx
from cryptography.fernet import Fernet
from pydantic import SecretStr
from sqlalchemy import select
from app.domains.connections.models import IntegrationConnection,ConnectionCredential
from app.domains.connections.crypto import ConnectionKeyring,ConnectionFault
from app.domains.connections.material import AppMaterial,BoundToken,PlatformCredentialService
from app.domains.connections.service import ConnectionStore,SyncConnectionStore
from app.domains.connections.router import router
from app.domains.zerodha.models import ZerodhaCredential
from app.domains.zerodha.service import ZerodhaService,KiteError
from test_private_api_ownership import private_api

@pytest.fixture
def bindings(private_api,monkeypatch):
    a=private_api
    for model in (IntegrationConnection,ConnectionCredential,ZerodhaCredential):model.__table__.create(a.session.get_bind())
    a.app.include_router(router)
    a.ring=ConnectionKeyring({1:Fernet.generate_key().decode(),2:Fernet.generate_key().decode()})
    a.app_material=AppMaterial(SecretStr('fake-shared-key'),SecretStr('fake-shared-secret'),'fake-platform',1)
    a.platform=PlatformCredentialService({('fake-platform',1):a.app_material},approved=True,approval_reference='synthetic-proof-only')
    a.store=ConnectionStore(a.db,keyring=a.ring,platform=a.platform)
    monkeypatch.setattr(ConnectionKeyring,'from_settings',classmethod(lambda cls:a.ring))
    monkeypatch.setattr(PlatformCredentialService,'from_settings',classmethod(lambda cls:a.platform))
    return a

async def active(a,owner,mode='user_owned',suffix='a'):
    kw={'app_key':'fake-key-'+suffix,'app_secret':'fake-secret-'+suffix} if mode=='user_owned' else {'platform_ref':'fake-platform'}
    row=await a.store.provision(owner,mode=mode,**kw)
    _,app=await a.store.prepare_app(owner,row.id)
    await a.store.install_session(owner,row.id,1,app=app,provider_account_id='FAKE'+suffix.upper(),token='fake-token-'+suffix,expires_at=datetime.now(timezone.utc)+timedelta(hours=1))
    return row

@pytest.mark.asyncio
@pytest.mark.parametrize('mode',['user_owned','platform_managed'])
async def test_both_modes_bind_owned_app_and_token_without_mixing(bindings,mode):
    a=bindings;one=await active(a,a.users[0].id,mode,'a');two=await active(a,a.users[1].id,mode,'b')
    first=await a.store.resolve_token(a.users[0].id);second=await a.store.resolve_token(a.users[1].id)
    assert first.connection_id==one.id and second.connection_id==two.id
    assert first.token.get_secret_value()=='fake-token-a' and second.token.get_secret_value()=='fake-token-b'
    assert ZerodhaService()._auth_headers(first)['Authorization']==f'token {first.app.key.get_secret_value()}:fake-token-a'
    assert SyncConnectionStore(a.session,keyring=a.ring,platform=a.platform).resolve_token(a.users[0].id).connection_id==one.id
    with pytest.raises(ConnectionFault,match='CONNECTION_NOT_FOUND'):await a.store.get(a.users[0].id,two.id)
    for row in (one,two):
        secret,payload=await a.store.material(row)
        assert 'fake-token' not in secret.ciphertext and 'fake-secret' not in secret.ciphertext
        if mode=='platform_managed':assert 'app_key' not in payload and 'app_secret' not in payload

@pytest.mark.asyncio
async def test_platform_approval_missing_reference_and_wrong_version_fail_closed(bindings):
    a=bindings;a.platform.approved=False
    row=await a.store.provision(a.users[0].id,mode='platform_managed',platform_ref='fake-platform')
    assert row.status=='approval_required'
    with pytest.raises(ConnectionFault,match='PLATFORM_PROVIDER_APPROVAL_REQUIRED'):await a.store.prepare_app(a.users[0].id,row.id)
    a.platform.approved=True
    for ref,version in [('missing',1),('fake-platform',2)]:
        with pytest.raises(ConnectionFault,match='PLATFORM_CREDENTIAL_REFERENCE_UNAVAILABLE'):a.platform.resolve(ref,version)

@pytest.mark.asyncio
@pytest.mark.parametrize('mode',['user_owned','platform_managed'])
async def test_rotation_stale_target_missing_and_interrupted_commit_recover(bindings,mode):
    a=bindings;row=await active(a,a.users[0].id,mode)
    secret,_=await a.store.material(row);original=secret.ciphertext
    with pytest.raises(ConnectionFault,match='ENCRYPTION_KEY_VERSION_UNAVAILABLE'):await a.store.rotate(a.users[0].id,row.id,2,99)
    a.session.expire_all();row=await a.store.get(a.users[0].id,row.id)
    assert row.version==2 and (await a.store.material(row))[0].ciphertext==original
    original_commit=a.db.commit
    a.db.commit=AsyncMock(side_effect=RuntimeError('fake failure'))
    with pytest.raises(ConnectionFault,match='CONNECTION_STORAGE_UNAVAILABLE'):await a.store.rotate(a.users[0].id,row.id,2,2)
    a.db.commit=original_commit;a.session.expire_all();row=await a.store.get(a.users[0].id,row.id)
    assert row.version==2 and (await a.store.material(row))[0].ciphertext==original
    await a.store.rotate(a.users[0].id,row.id,2,2)
    assert row.version==3 and (await a.store.material(row))[0].key_version==2
    assert (await a.store.resolve_token(a.users[0].id)).token.get_secret_value()=='fake-token-a'
    with pytest.raises(ConnectionFault,match='CONNECTION_VERSION_CHANGED'):await a.store.rotate(a.users[0].id,row.id,2,1)

@pytest.mark.asyncio
async def test_credential_swap_and_platform_version_change_never_fallback(bindings):
    a=bindings;one=await active(a,a.users[0].id);two=await active(a,a.users[1].id,suffix='b')
    s1,_=await a.store.material(one);s2,_=await a.store.material(two);s1.ciphertext=s2.ciphertext;a.session.commit()
    with pytest.raises(ConnectionFault,match='CONNECTION_BINDING_MISMATCH'):await a.store.resolve_token(a.users[0].id)
    assert (await a.store.resolve_token(a.users[1].id)).token.get_secret_value()=='fake-token-b'

@pytest.mark.asyncio
async def test_managed_reference_material_change_denied(bindings):
    a=bindings;row=await active(a,a.users[0].id,'platform_managed')
    a.platform._entries[('fake-platform',1)]=AppMaterial(SecretStr('other-key'),SecretStr('other-secret'),'fake-platform',1)
    with pytest.raises(ConnectionFault,match='CONNECTION_APP_BINDING_CHANGED'):await a.store.resolve_token(a.users[0].id)

@pytest.mark.asyncio
async def test_single_current_policy_allows_future_noncurrent_identity(bindings):
    a=bindings;row=await active(a,a.users[0].id)
    with pytest.raises(ConnectionFault,match='ONE_CURRENT_ACCOUNT_PER_PROVIDER'):await a.store.provision(a.users[0].id,mode='user_owned',app_key='fake',app_secret='fake')
    future=await a.store.provision(a.users[0].id,mode='user_owned',app_key='fake',app_secret='fake',is_current=False)
    assert future.id!=row.id
    with pytest.raises(ConnectionFault,match='CONNECTION_NOT_AUTHORIZABLE'):await a.store.prepare_app(a.users[0].id,future.id)

@pytest.mark.asyncio
async def test_local_disable_removes_resolution_and_preserves_identity(bindings):
    a=bindings;row=await active(a,a.users[0].id);await a.store.disable(a.users[0].id)
    assert row.version==3 and row.status=='disabled'
    assert (await a.store.material(row))[1]['token'] is None
    with pytest.raises(ConnectionFault,match='CONNECTION_NOT_ACTIVE'):await a.store.resolve_token(a.users[0].id)

@pytest.mark.asyncio
async def test_session_rejects_cross_app_and_account_replacement(bindings):
    a=bindings;row=await active(a,a.users[0].id);_,app=await a.store.prepare_app(a.users[0].id,row.id)
    for supplied,account,reason in [(a.app_material,'FAKEA','CONNECTION_APP_BINDING_CHANGED'),(app,'FOREIGN','CONNECTION_ACCOUNT_CHANGE_REQUIRES_REVIEW')]:
        with pytest.raises(ConnectionFault,match=reason):await a.store.install_session(a.users[0].id,row.id,2,app=supplied,provider_account_id=account,token='fake-next',expires_at=datetime.now(timezone.utc)+timedelta(hours=1))

@pytest.mark.asyncio
async def test_metadata_private_masked_no_secret_no_capability(bindings):
    a=bindings;one=await active(a,a.users[0].id);two=await active(a,a.users[1].id,'platform_managed','b')
    response=a.client.get('/me/connections',headers=a.headers[0]);assert response.status_code==200 and response.headers['cache-control']=='no-store'
    data=response.json();assert data['owner_id']==a.users[0].id and [r['id'] for r in data['connections']]==[one.id]
    dto=data['connections'][0];assert dto['account_label']=='***AKEA' and dto['readiness']['ready_for_adapter']
    assert not dto['readiness']['module_access_granted'] and not dto['readiness']['financial_execution_granted']
    for text in ('fake-token','fake-secret','fake-key','credential_ref','ciphertext'):assert text not in response.text
    denied=[a.client.get('/me/connections/'+id,headers=a.headers[0]) for id in (two.id,'missing')]
    assert [r.status_code for r in denied]==[404,404] and denied[0].json()==denied[1].json()
    assert a.client.get('/me/connections').status_code==401
    assert a.client.get('/me/connections',headers=a.headers[2]).status_code==403

@pytest.mark.asyncio
async def test_admin_never_gets_foreign_metadata(bindings):
    from app.domains.auth.models import UserRole
    a=bindings;a.users[0].role=UserRole.ADMIN;a.session.commit();foreign=await active(a,a.users[1].id)
    assert a.client.get('/me/connections/'+foreign.id,headers=a.headers[0]).status_code==404
    assert a.client.get('/me/connections',headers=a.headers[0]).json()['connections']==[]

@pytest.mark.asyncio
async def test_uat2_readiness_always_simulation_only(bindings,monkeypatch):
    a=bindings;await active(a,a.users[0].id)
    monkeypatch.setattr('app.domains.connections.router.uat2_mode',lambda:True)
    dto=a.client.get('/me/connections',headers=a.headers[0]).json()['connections'][0]
    assert not dto['readiness']['ready_for_adapter'] and dto['readiness']['reason']=='UAT2_SIMULATION_ONLY'

@pytest.mark.asyncio
@pytest.mark.parametrize('accepted',[True,False])
async def test_explicit_verified_legacy_adoption_preserves_ciphertext(bindings,monkeypatch,accepted):
    from app.core.config import settings
    from app.domains.zerodha.crypto import encrypt_token,decrypt_token
    a=bindings;monkeypatch.setattr(settings,'zerodha_token_encryption_key',Fernet.generate_key().decode())
    legacy=ZerodhaCredential(user_id=a.users[0].id,access_token=encrypt_token('fake-legacy-token'),login_time=datetime.now(timezone.utc),expires_at=datetime.now(timezone.utc)+timedelta(hours=1))
    a.session.add(legacy);a.session.flush();original=legacy.access_token
    row=IntegrationConnection(id='legacy-fake',owner_id=legacy.user_id,provider='zerodha',app_ownership_mode='platform_managed',credential_ref=f'legacy:zerodha:{legacy.id}',status='legacy_review',version=1,is_current=True)
    a.session.add(row);a.session.commit()
    with pytest.raises(ConnectionFault,match='LEGACY_BINDING_VERIFICATION_REQUIRED'):await a.store.resolve_token(legacy.user_id)
    verifier=AsyncMock(return_value='FAKELEGACY' if accepted else 'WRONG')
    args=dict(platform_ref='fake-platform',app_version=1,expected_account_id='FAKELEGACY',verify_account=verifier)
    if accepted:
        await a.store.adopt_legacy(legacy.user_id,row.id,1,**args)
        assert row.version==2 and (await a.store.resolve_token(legacy.user_id)).token.get_secret_value()=='fake-legacy-token'
    else:
        with pytest.raises(ConnectionFault,match='LEGACY_ACCOUNT_VERIFICATION_FAILED'):await a.store.adopt_legacy(legacy.user_id,row.id,1,**args)
        assert (await a.store.get(legacy.user_id,row.id)).status=='legacy_review'
    assert legacy.access_token==original and decrypt_token(original)=='fake-legacy-token'
    assert verifier.await_count==1

@pytest.mark.parametrize('version',[0,-1,9])
def test_key_versions_never_trial_fallback(version):
    ring=ConnectionKeyring({1:Fernet.generate_key().decode()});cipher,_=ring.seal({'fake':'value'})
    with pytest.raises(ConnectionFault,match='ENCRYPTION_KEY_VERSION_UNAVAILABLE'):ring.open(cipher,version)

def test_adapter_rejects_unbound_token_and_cross_app_and_redacts_errors():
    app=AppMaterial(SecretStr('fake-key'),SecretStr('fake-secret'),'fake',1)
    token=BoundToken(1,'fake',2,app,SecretStr('fake-token'),datetime.now(timezone.utc)+timedelta(hours=1))
    with pytest.raises(ConnectionFault,match='CONNECTION_BOUND_TOKEN_REQUIRED'):ZerodhaService()._auth_headers('fake-token')
    with pytest.raises(ConnectionFault,match='CONNECTION_APP_BINDING_CHANGED'):ZerodhaService(AppMaterial(SecretStr('other'),SecretStr('other'),'other',1))._auth_headers(token)
    assert 'fake-key' not in repr(token)+repr(app) and 'fake-secret' not in repr(app)
    response=httpx.Response(400,json={'status':'error','message':'fake-key fake-secret fake-token','error_type':'fake-secret'},request=httpx.Request('GET','https://fake.invalid'))
    with pytest.raises(KiteError) as error:ZerodhaService()._raise_for_kite(response,['fake-key','fake-secret','fake-token'])
    assert str(error.value)=='[redacted] [redacted] [redacted]' and error.value.error_type=='GeneralException'

@pytest.mark.asyncio
@pytest.mark.parametrize('mode',['user_owned','platform_managed'])
async def test_actual_async_and_sync_transport_use_same_bound_app_and_token(bindings,monkeypatch,mode):
    a=bindings;await active(a,a.users[0].id,mode);token=await a.store.resolve_token(a.users[0].id);requests=[]
    def respond(request):requests.append(request);return httpx.Response(200,json={'status':'success','data':{'synthetic':True}})
    ac=httpx.AsyncClient;sc=httpx.Client
    monkeypatch.setattr(httpx,'AsyncClient',lambda **kw:ac(transport=httpx.MockTransport(respond),**kw))
    monkeypatch.setattr(httpx,'Client',lambda **kw:sc(transport=httpx.MockTransport(respond),**kw))
    svc=ZerodhaService();assert await svc._request_async('GET','/user/profile',access_token=token)=={'synthetic':True}
    assert svc._request_sync('GET','/user/profile',access_token=token)=={'synthetic':True}
    assert len(requests)==2 and all(r.headers['Authorization']==f'token {token.app.key.get_secret_value()}:fake-token-a' for r in requests)

@pytest.mark.asyncio
async def test_token_exchange_uses_exact_explicit_app_checksum(bindings,monkeypatch):
    import hashlib
    a=bindings;row=await a.store.provision(a.users[0].id,mode='user_owned',app_key='fake-own-key',app_secret='fake-own-secret')
    _,app=await a.store.prepare_app(a.users[0].id,row.id);requests=[]
    def respond(request):requests.append(request);return httpx.Response(200,json={'status':'success','data':{'access_token':'fake-response'}})
    cls=httpx.AsyncClient;monkeypatch.setattr(httpx,'AsyncClient',lambda **kw:cls(transport=httpx.MockTransport(respond),**kw))
    assert (await ZerodhaService(app).exchange_token('fake-request'))['access_token']=='fake-response'
    body=requests[0].content.decode();assert 'api_key=fake-own-key' in body and hashlib.sha256(b'fake-own-keyfake-requestfake-own-secret').hexdigest() in body
    assert 'fake-shared' not in body

@pytest.mark.asyncio
async def test_stale_bound_token_and_cross_owner_denied_before_fake_effect(bindings):
    from contextlib import contextmanager,asynccontextmanager
    from app.domains.modules.execution import _current
    a=bindings;row=await active(a,a.users[0].id);token=await a.store.resolve_token(a.users[0].id)
    @contextmanager
    def sync_factory():yield a.session
    @asynccontextmanager
    async def async_factory():yield a.db
    context=SimpleNamespace(identity=SimpleNamespace(owner_id=a.users[0].id),factory=sync_factory,async_factory=async_factory)
    marker=_current.set(context)
    try:
        await ZerodhaService()._current_binding_async(token)
        await a.store.rotate(a.users[0].id,row.id,2,2)
        with pytest.raises(ConnectionFault,match='CONNECTION_VERSION_CHANGED'):await ZerodhaService()._current_binding_async(token)
        with pytest.raises(ConnectionFault,match='CONNECTION_VERSION_CHANGED'):ZerodhaService()._current_binding_sync(token)
        context.identity.owner_id=a.users[1].id
        with pytest.raises(ConnectionFault,match='CONNECTION_OWNER_MISMATCH'):ZerodhaService()._auth_headers(token)
    finally:_current.reset(marker)
