"""Actual authenticated ASGI-to-PG transactions; fake data and no listener."""
import os
from uuid import uuid4
from datetime import datetime,timedelta,timezone
import pytest
import pytest_asyncio
import app.models
from fastapi import FastAPI
from httpx import ASGITransport,AsyncClient
from sqlalchemy import select,func
from sqlalchemy.orm import Session
from sqlalchemy.ext.asyncio import async_sessionmaker
from app.core.security import JWTUtils
from app.core.config import settings
from app.domains.auth.models import User,UserRole,UserProfile,APIKey,ActivityLog
from app.infrastructure.database.base import Base
from app.infrastructure.database import session as sessions
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.modules.models import UserModulePreferences,UserModule
from app.domains.modules.router import router as module_router
from app.domains.modules.transports import install_route_policy
from app.domains.public_service.router import router
from app.domains.public_service.application_bindings import DisposableApplicationBindings,install_disposable_bindings
from app.domains.public_service.composition import PublicServiceServer,ServerBindings
from app.domains.public_service.safe_privacy_projection import safe_canonical_inventory
from app.domains.public_service.sql_privacy_plan import RetentionSchedule
from app.domains.public_service.sql_privacy_workflow import DisposablePrivacyScope,TOPIC
from app.domains.public_service.reviewed_residency import ResidencyReviewPolicy
from test_stage09_connections_postgres import database
pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',
    reason='Actual acknowledged disposable PostgreSQL required; CI must reject skips')

@pytest_asyncio.fixture
async def configured_app(database,monkeypatch):
    engine,original_factory,owner,_,ring=database;now=datetime.now(timezone.utc)
    monkeypatch.setenv('JWT_SIGNING_KEY','synthetic-stage17-http-only-'+('x'*48))
    monkeypatch.setattr(settings,'auth_disabled',False)
    with Session(engine) as db:
        foreign=User(email='composition-foreign@example.invalid',username='composition_foreign',password_hash='unusable',is_active=True,is_verified=True,profile=UserProfile())
        reviewer=User(email='composition-reviewer@example.invalid',username='composition_reviewer',password_hash='unusable',role=UserRole.ADMIN,is_active=True,is_verified=True)
        db.add_all([foreign,reviewer]);db.flush();other,actor=foreign.id,reviewer.id
        for identity in (owner,other):db.add(APIKey(user_id=identity,key='SYNTHETIC_SECRET_'+str(identity),key_hash='SYNTHETIC_HASH',name='fixture'))
        db.get(UserProfile,owner).bio='SYNTHETIC_UNVERIFIED_CONTENT'
        db.add(UserModulePreferences(user_id=owner,version=1));db.flush()
        db.add(UserModule(user_id=owner,module_id='market_scanner',enabled=True,version=1));db.flush()
        connections=Base.metadata.tables['integration_connections']
        credentials=Base.metadata.tables['connection_credentials'];history=Base.metadata.tables['connection_binding_history']
        for identity in (owner,other):
            connection=str(uuid4())
            db.execute(connections.insert().values(id=connection,owner_id=identity,app_ownership_mode='user_owned'))
            db.execute(credentials.insert().values(connection_id=connection,owner_id=identity,
                ciphertext='SYNTHETIC_CREDENTIAL_CIPHERTEXT',key_version=1))
            db.execute(history.insert().values(connection_id=connection,owner_id=identity,connection_version=1,
                app_mode='user_owned',provider_account_id='SYNTHETIC_ACCOUNT',ciphertext='SYNTHETIC_HISTORY_CIPHERTEXT',key_version=1))
        blobs=Base.metadata.tables['bullpen_run_audit_blobs']
        db.execute(blobs.insert().values(id='a'*64,content_type='application/json',payload_json={'password':'SYNTHETIC_SHARED_SECRET'},sanitized=False))
        db.commit()
    reference='synthetic:actual-pg-http'
    # Explicit fixture retention holds every category except API keys. This is
    # a partial disposal rehearsal, not a real policy or complete account wipe.
    retention=RetentionSchedule(reference,now+timedelta(days=1),
        legal_holds=frozenset(set(Base.metadata.tables)-{'api_keys'}),
        retain_until=tuple((name,None) for name in Base.metadata.tables))
    policy=ResidencyReviewPolicy(reference,frozenset({actor}),frozenset({'synthetic_review'}))
    binding=DisposableApplicationBindings(reference,PublicServiceServer(keyring=ring,bindings=ServerBindings(
        policy,safe_canonical_inventory(Base.metadata,reference=reference),retention)),DisposablePrivacyScope(reference))
    app=FastAPI();app.include_router(router);app.include_router(module_router);install_route_policy(app)
    install_disposable_bindings(app,binding)
    async_engine=original_factory.kw['bind'].execution_options(isolation_level='SERIALIZABLE')
    monkeypatch.setattr(sessions,'AsyncSessionLocal',async_sessionmaker(async_engine,expire_on_commit=False))
    def headers(identity):return {'Authorization':'Bearer '+JWTUtils.create_access_token(identity,'synthetic@example.invalid','user')}
    try:yield app,binding,engine,owner,other,actor,headers
    finally:await async_engine.dispose()

@pytest.mark.asyncio
async def test_actual_pg_authenticated_export_replay_and_foreign_result_denial(configured_app):
    app,_,engine,owner,other,_,headers=configured_app
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        assert (await client.get('/account/operations/disposable/reviewed-eligibility')).status_code==401
        receipt=await client.post('/account/operations/privacy-requests',headers=headers(owner),json={'key':'actual-http-export','kind':'export','confirmed':True})
        assert receipt.status_code==200,receipt.text
        path='/account/operations/disposable/privacy-requests/'+receipt.json()['id']
        response=await client.post(path+'/execute',headers=headers(owner),json={'confirmed':True})
        assert response.status_code==200,response.text
        data=response.json();assert data['owner_id']==owner and data['synthetic'] is True
        assert [row['id'] for row in data['datasets']['users']]==[owner]
        assert len(data['datasets']['api_keys'])==1
        assert all(marker not in response.text for marker in ('SYNTHETIC_SECRET_','SYNTHETIC_UNVERIFIED_CONTENT',
            'SYNTHETIC_CREDENTIAL_CIPHERTEXT','SYNTHETIC_HISTORY_CIPHERTEXT','SYNTHETIC_SHARED_SECRET'))
        for table in ('integration_connections','connection_credentials','connection_binding_history'):
            assert len(data['datasets'][table])==1 and data['datasets'][table][0]['owner_id']==owner
        assert 'key' not in data['datasets']['api_keys'][0]
        assert 'outbox' in data['excluded_tables'] and response.headers['cache-control']=='private, no-store'
        assert (await client.post(path+'/execute',headers=headers(owner),json={'confirmed':True})).json()==data
        assert (await client.get(path+'/result',headers=headers(other))).status_code==404
        assert (await client.post(path+'/execute',headers=headers(other),json={'confirmed':True})).status_code==409
        assert (await client.get(path+'/result',headers=headers(owner))).json()==data
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==TOPIC))==1

@pytest.mark.asyncio
async def test_actual_pg_authenticated_cancellation_partial_disposal_and_foreign_preservation(configured_app):
    app,_,engine,owner,other,_,headers=configured_app
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        make=lambda key:client.post('/account/operations/privacy-requests',headers=headers(owner),json={'key':key,'kind':'delete','confirmed':True})
        canceled=await make('actual-http-cancel');assert canceled.status_code==200
        id=canceled.json()['id']
        assert (await client.post('/account/operations/privacy-requests/'+id+'/cancel',headers=headers(owner))).status_code==200
        assert (await client.post('/account/operations/disposable/privacy-requests/'+id+'/execute',headers=headers(owner),json={'confirmed':True})).status_code==409
        with Session(engine) as db:assert db.scalar(select(func.count()).select_from(APIKey))==2
        receipt=await make('actual-http-disposal');assert receipt.status_code==200
        path='/account/operations/disposable/privacy-requests/'+receipt.json()['id']+'/execute'
        response=await client.post(path,headers=headers(owner),json={'confirmed':True})
        assert response.status_code==200,response.text
        data=response.json();assert data['removed_counts']=={'api_keys':1}
        assert data['status']=='partial_retained' and data['identity_erased'] is data['backup_erased'] is data['complete_account_erasure'] is False
        assert (await client.post(path,headers=headers(owner),json={'confirmed':True})).json()==data
    with Session(engine) as db:
        assert list(db.scalars(select(APIKey.user_id)))==[other]
        assert db.get(UserProfile,owner) is not None and db.get(User,owner) is not None

@pytest.mark.asyncio
async def test_actual_pg_reviewed_residency_changes_only_jurisdiction_and_revocation_denies(configured_app):
    app,binding,engine,owner,other,actor,headers=configured_app
    now=datetime.now(timezone.utc);producer=binding.server.residency()
    with Session(engine) as db:
        consent=producer.consent(db,owner,'actual-http-reviewed','synthetic_review',confirmed=True,now=now)
        producer.ingest(db,actor,owner,consent.id,country='IN',evidence_type='synthetic_review',reference_hash='a'*64,expires=now+timedelta(hours=1),now=now);db.commit()
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        response=await client.get('/account/operations/disposable/reviewed-eligibility',headers=headers(owner))
        assert response.status_code==200 and response.json()['eligible'] is True
        assert (await client.get('/account/operations/disposable/reviewed-eligibility',headers=headers(other))).json()['eligible'] is False
        modules=(await client.get('/me/modules',headers=headers(owner))).json()['modules']
        scanner=next(row for row in modules if row['module_id']=='market_scanner')
        assert scanner['entitlement']=={'jurisdiction':'allowed','plan':'unknown'}
        assert scanner['capabilities']['analyze']['allowed'] is False
        with Session(engine) as db:producer.revoke(db,actor,owner);db.commit()
        modules=(await client.get('/me/modules',headers=headers(owner))).json()['modules']
        assert next(row for row in modules if row['module_id']=='market_scanner')['entitlement']['jurisdiction']=='denied'
