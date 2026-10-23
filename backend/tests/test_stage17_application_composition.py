"""Network-free authenticated composition; full-schema SQL effects need PG CI."""
from dataclasses import replace
from datetime import datetime,timedelta,timezone
from types import SimpleNamespace
from uuid import uuid4
import pytest
import app.models
from fastapi import FastAPI
from httpx import ASGITransport,AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import UserProfile,User
from app.domains.auth.router import router as auth_router
from sqlalchemy import select,func
from app.infrastructure.database.base import Base
from app.infrastructure.database import session as sessions
from app.domains.modules.models import UserModulePreferences,UserModule
from app.domains.modules.registry import ModuleId
from app.domains.public_service.application_bindings import (DisposableApplicationBindings,
    install_disposable_bindings,STATE,SESSION,attach_request_facts,facts_for_session)
from app.domains.public_service.composition import PublicServiceServer,ServerBindings
from app.domains.public_service.safe_privacy_projection import safe_canonical_inventory,projection_manifest
from app.domains.public_service.sql_privacy_plan import RetentionSchedule
from app.domains.public_service.sql_privacy_workflow import DisposablePrivacyScope
from app.domains.public_service.router import router
from app.domains.modules.router import router as module_router
from app.domains.modules.transports import install_route_policy
from app.domains.modules.coverage import classify_route
from test_stage17_reviewed_residency import setup as residency_setup,consent,issue

@pytest.fixture
def application(residency_setup,monkeypatch):
    db,producer=residency_setup
    # HTTP composition deliberately uses the runtime wall clock. Do not issue
    # fixed-date evidence which becomes expired when this suite runs later.
    # Change only this request fixture's issuance clock; runtime checks remain
    # real and the dedicated expiry regression below must still reject.
    import test_stage17_reviewed_residency as residency_fixture
    monkeypatch.setattr(residency_fixture,'NOW',datetime.now(timezone.utc))
    UserProfile.__table__.create(db.get_bind())
    UserModulePreferences.__table__.create(db.get_bind());UserModule.__table__.create(db.get_bind())
    db.add(UserModulePreferences(user_id=1,version=1));db.flush()
    db.add(UserModule(user_id=1,module_id=ModuleId.MARKET_SCANNER.value,enabled=True,version=1));db.commit()
    reference='synthetic:configured-application'
    retention=RetentionSchedule(reference,datetime.now(timezone.utc)+timedelta(days=1),
        retain_until=tuple((name,None) for name in Base.metadata.tables))
    bindings=DisposableApplicationBindings(reference,PublicServiceServer(keyring=producer.keyring,
        bindings=ServerBindings(producer.policy,safe_canonical_inventory(Base.metadata,reference=reference),retention)),DisposablePrivacyScope(reference))
    app=FastAPI();app.include_router(router);app.include_router(module_router);app.include_router(auth_router);install_route_policy(app)
    engine=create_async_engine('sqlite+aiosqlite:///'+db.get_bind().url.database)
    factory=async_sessionmaker(engine,expire_on_commit=False)
    monkeypatch.setattr(sessions,'AsyncSessionLocal',factory)
    from app.core.config import settings
    monkeypatch.setattr(settings,'auth_disabled',False)
    yield app,bindings,db,producer,engine

@pytest.mark.asyncio
async def test_anonymous_and_unconfigured_requests_never_release_account_data(application):
    app,_,_,_,engine=application
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        assert (await client.get('/account/operations/disposable/reviewed-eligibility')).status_code==401
        app.dependency_overrides[get_current_user]=lambda:SimpleNamespace(id=1)
        response=await client.get('/account/operations/disposable/reviewed-eligibility')
        assert response.status_code==503
    await engine.dispose()

@pytest.mark.asyncio
async def test_expired_reviewed_evidence_remains_denied_at_http_and_module_boundaries(application,monkeypatch):
    app,bindings,db,producer,engine=application
    import test_stage17_reviewed_residency as residency_fixture
    monkeypatch.setattr(residency_fixture,'NOW',datetime.now(timezone.utc)-timedelta(days=2))
    issue(db,producer,consent(db,producer));db.commit();install_disposable_bindings(app,bindings)
    app.dependency_overrides[get_current_user]=lambda:SimpleNamespace(id=1)
    try:
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
            response=await client.get('/account/operations/disposable/reviewed-eligibility')
            assert response.status_code==200 and response.json()['eligible'] is False
            modules=(await client.get('/me/modules')).json()['modules']
            scanner=next(row for row in modules if row['module_id']=='market_scanner')
            assert scanner['entitlement']['jurisdiction']=='denied'
            assert not scanner['capabilities']['analyze']['allowed']
    finally:
        await engine.dispose()

@pytest.mark.asyncio
async def test_reviewed_onboarding_module_facts_and_revocation_are_request_scoped(application):
    app,bindings,db,producer,engine=application
    issue(db,producer,consent(db,producer));db.commit();install_disposable_bindings(app,bindings)
    app.dependency_overrides[get_current_user]=lambda:SimpleNamespace(id=1)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        response=await client.get('/account/operations/disposable/reviewed-eligibility')
        assert response.status_code==200 and response.json()['eligible'] is True
        assert response.headers['cache-control']=='private, no-store'
        modules=(await client.get('/me/modules')).json()['modules']
        scanner=next(row for row in modules if row['module_id']=='market_scanner')
        assert scanner['entitlement']['jurisdiction']=='allowed' and scanner['entitlement']['plan']=='unknown'
        assert not scanner['capabilities']['analyze']['allowed']
        producer.revoke(db,1,1);db.commit()
        response=await client.get('/account/operations/disposable/reviewed-eligibility')
        assert response.status_code==200 and response.json()['eligible'] is False
        modules=(await client.get('/me/modules')).json()['modules']
        assert next(row for row in modules if row['module_id']=='market_scanner')['entitlement']['jurisdiction']=='denied'
    await engine.dispose()

@pytest.mark.asyncio
async def test_foreign_owner_cannot_inherit_reviewed_proof_or_private_scope(application):
    app,bindings,db,producer,engine=application
    issue(db,producer,consent(db,producer));db.commit();install_disposable_bindings(app,bindings)
    app.dependency_overrides[get_current_user]=lambda:SimpleNamespace(id=3)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        result=(await client.get('/account/operations/disposable/reviewed-eligibility')).json()
        assert result['owner_id']==3 and result['eligible'] is False
        response=await client.post('/account/operations/disposable/privacy-requests/'+str(uuid4())+'/execute',json={'confirmed':True,'owner_id':1})
        assert response.status_code==422
    await engine.dispose()

@pytest.mark.asyncio
async def test_confirmation_production_switch_and_tampered_binding_deny(application,monkeypatch):
    app,bindings,_,_,engine=application;install_disposable_bindings(app,bindings)
    app.dependency_overrides[get_current_user]=lambda:SimpleNamespace(id=1)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        path='/account/operations/disposable/privacy-requests/'+str(uuid4())+'/execute'
        assert (await client.post(path,json={'confirmed':False})).status_code==409
        monkeypatch.setenv('ENVIRONMENT','production')
        assert (await client.get('/account/operations/disposable/reviewed-eligibility')).status_code==503
        with pytest.raises(BoundaryDenied):install_disposable_bindings(FastAPI(),bindings)
        monkeypatch.setenv('ENVIRONMENT','test');setattr(app.state,STATE,{'approved':True})
        assert (await client.get('/account/operations/disposable/reviewed-eligibility')).status_code==503
    await engine.dispose()


def test_exact_route_classification_does_not_exempt_adjacent_effects():
    source='app.domains.public_service.application_router'
    path='/account/operations/disposable/privacy-requests/{id}/execute'
    assert classify_route('public_service','execute_privacy',path,{'POST'},source) is None
    assert classify_route('public_service','execute_privacy',path+'/other',{'POST'},source) is not None
    assert classify_route('public_service','execute_privacy',path,{'DELETE'},source) is not None


def test_bindings_are_explicit_single_install_and_no_forged_session_facts(application):
    app,bindings,_,_,_=application;install_disposable_bindings(app,bindings)
    install_disposable_bindings(app,bindings)
    with pytest.raises(BoundaryDenied):install_disposable_bindings(app,replace(bindings))
    with pytest.raises(BoundaryDenied):install_disposable_bindings(FastAPI(),{})
    with pytest.raises(BoundaryDenied):replace(bindings,reference='real-owner-approval').validate()
    session=SimpleNamespace(info={SESSION:{'jurisdiction':'allowed'}})
    with pytest.raises(BoundaryDenied):facts_for_session(session)


def test_conservative_projection_holds_raw_content_without_silently_claiming_full_export():
    manifest=projection_manifest(Base.metadata,reference='synthetic:projection')
    assert manifest['complete_account_export'] is False
    for table,column in [('api_keys','key'),('activity_logs','details'),('prompts','body'),
                         ('runs','prompt'),('user_profiles','google_sheets_master_url')]:
        assert column in manifest['datasets'][table]['withheld_columns']
        assert column not in manifest['datasets'][table]['export_columns']
    assert manifest['datasets']['outbox']['retained_reason']
    assert 'id' in manifest['datasets']['users']['export_columns']
    for rule in safe_canonical_inventory(Base.metadata,reference='synthetic:projection').rules:
        if not rule.excluded_reason:assert rule.export_columns


@pytest.mark.asyncio
async def test_configured_signup_default_deny_and_verified_fake_admission_with_replay_fence(application):
    from app.domains.public_service.signup_perimeter import SignupPerimeter,SignupPerimeterPolicy,ChallengeVerifier,VerifiedChallenge
    app,bindings,db,_,engine=application
    class SyntheticVerifier(ChallengeVerifier):
        def verify(self,token,*,peer,now):
            if not token.startswith('synthetic:'):raise ValueError('fixture rejection')
            return VerifiedChallenge(token,'fixture.invalid','signup',now)
    policy=SignupPerimeterPolicy('synthetic:perimeter','fixture.invalid',hash_key=b'synthetic-fixture-key-'+b'x'*32)
    body={'email':'synthetic-new-person@example.com','username':'synthetic_new_user','password':'SyntheticPass123'}
    install_disposable_bindings(app,bindings)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        assert (await client.post('/auth/register',json=body)).status_code==503
        assert db.scalar(select(func.count()).select_from(User))==4
    app2=FastAPI();app2.include_router(auth_router);install_route_policy(app2)
    install_disposable_bindings(app2,replace(bindings,signup_perimeter=SignupPerimeter(policy=policy,verifier=SyntheticVerifier())))
    async with AsyncClient(transport=ASGITransport(app=app2),base_url='http://synthetic.invalid') as client:
        assert (await client.post('/auth/register',json=body,headers={'x-credx-signup-challenge':'synthetic:one','x-forwarded-for':'1.2.3.4'})).status_code==429
        response=await client.post('/auth/register',json=body,headers={'x-credx-signup-challenge':'synthetic:one'})
        assert response.status_code==201,response.text
        replay={**body,'email':'synthetic-second-person@example.com','username':'synthetic_second'}
        assert (await client.post('/auth/register',json=replay,headers={'x-credx-signup-challenge':'synthetic:one'})).status_code==429
    db.expire_all();assert db.scalar(select(func.count()).select_from(User))==5
    await engine.dispose()


def test_consumer_registration_is_app_local_and_monitor_has_no_delivery_binding(application):
    from celery import Celery
    app,bindings,_,_,_=application
    worker=Celery('synthetic_'+uuid4().hex,broker='memory://',backend='cache+memory://')
    worker.conf.beat_schedule={'existing':{'task':'existing.task','schedule':60}}
    try:
        tasks=bindings.register_consumers(worker)
        assert len(tasks)==3 and worker.conf.beat_schedule=={'existing':{'task':'existing.task','schedule':60}}
        assert all(task()['state']=='disabled' for task in tasks.values())
        with pytest.raises(BoundaryDenied,match='MONITOR_BINDING_REQUIRED'):bindings.monitor(None)._fence(1)
    finally:worker.close()


def test_reused_or_unconfigured_sessions_cannot_retain_previous_request_bindings(application):
    from app.domains.public_service.application_bindings import SIGNUP
    from app.domains.public_service.composition import IsolatedConsumerComposition
    _,bindings,_,_,_=application
    session=SimpleNamespace(info={SESSION:object(),SIGNUP:object()})
    attach_request_facts(None,session)
    assert session.info=={}
    assert facts_for_session(SimpleNamespace()) is None
    unsafe=IsolatedConsumerComposition(session_factory=lambda:None,bindings_factory=lambda db:None)
    with pytest.raises(BoundaryDenied,match='CONSUMER_FACTORY_UNAVAILABLE'):
        replace(bindings,consumers=unsafe).validate()


@pytest.mark.asyncio
async def test_serialization_conflict_rolls_back_and_signals_fresh_request_without_replay(application):
    from sqlalchemy.exc import OperationalError
    app,bindings,_,_,engine=application;install_disposable_bindings(app,bindings)
    class FakeDatabase:
        calls=0;rollbacks=0
        async def run_sync(self,operation):
            self.calls+=1
            raise OperationalError('synthetic statement',{},SimpleNamespace(pgcode='40001',message='SYNTHETIC_SECRET_ERROR'))
        async def rollback(self):self.rollbacks+=1
        async def commit(self):raise AssertionError('Aborted transaction must not commit')
    db=FakeDatabase();app.dependency_overrides[sessions.get_async_db]=lambda:db
    app.dependency_overrides[get_current_user]=lambda:SimpleNamespace(id=1)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        paths=['/account/operations/privacy-requests/'+str(uuid4())+'/cancel',
            '/account/operations/disposable/privacy-requests/'+str(uuid4())+'/execute']
        for path in paths:
            response=await client.post(path,json={'confirmed':True})
            assert response.status_code==409 and response.headers['retry-after']=='1'
            assert 'SYNTHETIC_SECRET_ERROR' not in response.text
    assert db.calls==2 and db.rollbacks==2
    await engine.dispose()


@pytest.mark.asyncio
async def test_non_disposable_database_is_rejected_before_authentication_query(application,monkeypatch):
    from sqlalchemy import event
    app,bindings,_,_,engine=application;install_disposable_bindings(app,bindings)
    bad=create_async_engine('sqlite+aiosqlite://');queries=[]
    def observed(*args):queries.append(True)
    event.listen(bad.sync_engine,'before_cursor_execute',observed)
    monkeypatch.setattr(sessions,'AsyncSessionLocal',async_sessionmaker(bad,expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        response=await client.get('/account/operations/disposable/reviewed-eligibility')
        assert response.status_code==503 and queries==[]
    await bad.dispose();await engine.dispose()
