"""Working local closure: real SQL/outbox + existing guarded fake workers only."""
import asyncio
from copy import deepcopy
from datetime import datetime,timezone,timedelta
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
import pytest
from sqlalchemy import create_engine,select
from sqlalchemy.orm import Session
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB
from cryptography.fernet import Fernet
import app.infrastructure.database.all_models
from app.infrastructure.database.base import Base
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.auth.models import User,UserRole,UserProfile,ActivityLog
from app.domains.auth.admin_roles import AdministrativeRoleGrant
from app.domains.modules.models import UserModule,UserModulePreferences
from app.domains.connections.models import IntegrationConnection
from app.domains.connections.crypto import ConnectionKeyring
from app.domains.order_intents.models import OrderIntent,OrderLeg
from app.domains.recommendation_audit.models import SpendAccount
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.ai_limits.private_effects import LocalSink
from app.domains.public_service.signup import admit,SignupLimits
from app.domains.public_service.store import control
from app.domains.public_service.residency import SyntheticResidencyProducer,reviewed_facts
from app.domains.modules.policy import ModuleFacts
from app.domains.public_service.account_data import DATASETS,SyntheticAccountDataAdapter,SyntheticRetentionReview
from app.domains.public_service.privacy import PrivacyRequests
from app.domains.public_service.support import SupportAccess
from app.domains.public_service.monitoring import OperationalMonitor
NOW=datetime(2026,10,21,8,tzinfo=timezone.utc)
@compiles(JSONB,'sqlite')
def json_sqlite(*args,**kw):return 'JSON'

@pytest.fixture
def db(tmp_path):
    engine=create_engine('sqlite:///'+str(tmp_path/'closure.sqlite'),connect_args={'timeout':15})
    models=[User,UserProfile,ActivityLog,OutboxMessage,UserModule,UserModulePreferences,IntegrationConnection,OrderIntent,OrderLeg,SpendAccount,ZerodhaPortfolioSnapshot,AdministrativeRoleGrant]
    Base.metadata.create_all(engine,tables=[m.__table__ for m in models])
    with Session(engine,expire_on_commit=False) as s:
        s.add_all([User(id=i,email=f'{i}@synthetic.invalid',username=f'synthetic{i}',password_hash='unusable-synthetic',is_active=True,is_verified=True,role=UserRole.ADMIN if i==3 else UserRole.USER) for i in (1,2,3)])
        s.commit();yield s
    engine.dispose()

def producer():return SyntheticResidencyProducer(ConnectionKeyring({1:Fernet.generate_key().decode()}))
def review(p,db,id=1):return p.record(db,id,country='IN',evidence_reference='synthetic:document',reviewer='synthetic:reviewer',now=NOW,expires=NOW+timedelta(hours=1))
def inventory(id):return {category:[{'owner_id':id,'resource_id':category+'-one','data':{'label':'synthetic-owned','api_secret':'NEVER_EXPORT','password_hash':'NEVER_EXPORT'}}] for category in DATASETS}

def test_signup_limits_are_durable_independent_of_ai_budget(db):
    admit(db,'one@synthetic.invalid',now=NOW,limits=SignupLimits(1,1));db.commit()
    with Session(db.get_bind()) as reopened:
        with pytest.raises(BoundaryDenied):admit(reopened,'two@synthetic.invalid',now=NOW,limits=SignupLimits(1,1))
        reopened.rollback();admit(reopened,'two@synthetic.invalid',now=NOW+timedelta(hours=2),limits=SignupLimits(1,1));reopened.commit()
    assert not list(db.scalars(select(SpendAccount)))

def test_signup_rollback_does_not_consume_account_creation_slot(db):
    admit(db,'one@synthetic.invalid',now=NOW,limits=SignupLimits(1,1));db.rollback()
    admit(db,'two@synthetic.invalid',now=NOW,limits=SignupLimits(1,1));db.commit()

def test_two_signup_writers_one_global_admission(db):
    engine=db.get_bind()
    def submit(n):
        with Session(engine) as s:
            try:admit(s,f'{n}@synthetic.invalid',now=NOW,limits=SignupLimits(1,1));s.commit();return True
            except BoundaryDenied:s.rollback();return False
    with ThreadPoolExecutor(2) as pool:assert sum(pool.map(submit,[1,2]))==1

def test_signup_preserves_clock_and_boundaries(db):
    admit(db,'one@synthetic.invalid',now=NOW);db.commit()
    with pytest.raises(BoundaryDenied):admit(db,'one@synthetic.invalid',now=NOW-timedelta(seconds=1))
    db.rollback()
    with pytest.raises(BoundaryDenied):SignupLimits(True,1).validate()

def test_reviewed_residency_is_synthetic_only_owner_bound_and_revocable(db):
    p=producer();row=review(p,db);db.commit()
    assert p.resolve(db,1,now=NOW)['real_eligible']is False
    facts=reviewed_facts(db,1,ModuleFacts(plan='allowed'),producer=p,simulation=True,now=NOW)
    assert facts.jurisdiction=='allowed' and facts.execution_capability is False
    for kwargs in [{},{'producer':p},{'producer':object(),'simulation':True}]:
        with pytest.raises(BoundaryDenied):reviewed_facts(db,1,ModuleFacts(),now=NOW,**kwargs)
    with pytest.raises(BoundaryDenied):p.resolve(db,2,now=NOW)
    p.revoke(db,1,row.id);db.commit()
    with pytest.raises(BoundaryDenied):p.resolve(db,1,now=NOW)

@pytest.mark.parametrize('change',['owner','ciphertext','expiry','nonindia'])
def test_residency_adversarial_evidence(db,change):
    p=producer()
    if change=='nonindia':
        with pytest.raises(BoundaryDenied):p.record(db,1,country='US',evidence_reference='synthetic:doc',reviewer='synthetic:reviewer',now=NOW,expires=NOW+timedelta(hours=1))
        return
    row=review(p,db);db.commit()
    if change=='owner':row.payload={**row.payload,'owner_id':2}
    if change=='ciphertext':row.payload={**row.payload,'ciphertext':'unreadable'}
    db.commit()
    with pytest.raises(BoundaryDenied):p.resolve(db,1,now=NOW+timedelta(days=2) if change=='expiry' else NOW)

def test_full_synthetic_export_covers_all_declared_datasets_without_credentials(db):
    adapter=SyntheticAccountDataAdapter(db,SyntheticRetentionReview('synthetic:policy',True))
    adapter.seed(1,inventory(1));adapter.seed(2,inventory(2));db.commit()
    requests=PrivacyRequests(db);r=requests.request(1,'export-all','export',confirmed=True,now=NOW);db.commit()
    requests.drill(1,r.id,store=adapter,now=NOW);db.commit()
    result=requests.export(1,r.id,now=NOW)
    assert set(result['datasets'])==DATASETS and sum(result['row_counts'].values())==len(DATASETS)
    assert 'NEVER_EXPORT' not in str(result) and result['real_legal_approval']is False
    with pytest.raises(BoundaryDenied):requests.export(2,r.id,now=NOW)
    with Session(db.get_bind(),expire_on_commit=False) as restart:
        assert PrivacyRequests(restart).export(1,r.id,now=NOW)==result

def test_deletion_retention_hold_and_owned_counts_are_durable(db):
    review_policy=SyntheticRetentionReview('synthetic:policy',True,frozenset({'activity','zerodha_rebalance'}),{'connections':NOW+timedelta(days=1)})
    adapter=SyntheticAccountDataAdapter(db,review_policy);adapter.seed(1,inventory(1));adapter.seed(2,inventory(2));db.commit()
    requests=PrivacyRequests(db);r=requests.request(1,'erase','delete',confirmed=True,now=NOW);db.commit();result=requests.drill(1,r.id,store=adapter,now=NOW);db.commit()
    assert set(result['held_counts'])=={'activity','zerodha_rebalance','connections'}
    with Session(db.get_bind()) as restart:
        state=SyntheticAccountDataAdapter(restart).owned(1).payload['datasets']
        assert all(len(rows)==(1 if name in result['held_counts'] else 0) for name,rows in state.items())
        assert all(len(rows)==1 for rows in SyntheticAccountDataAdapter(restart).owned(2).payload['datasets'].values())
    assert db.get(User,1).is_active # no actual account deletion/activation

@pytest.mark.parametrize('bad',['missing_category','foreign_owner','unreviewed'])
def test_full_account_contract_fails_closed(db,bad):
    adapter=SyntheticAccountDataAdapter(db);data=inventory(1)
    if bad=='missing_category':data.pop('profile')
    if bad=='foreign_owner':data['profile'][0]['owner_id']=2
    if bad!='unreviewed':
        with pytest.raises(BoundaryDenied):adapter.seed(1,data)
        db.rollback();return
    adapter.seed(1,data);db.commit()
    with pytest.raises(BoundaryDenied):adapter.apply(1,'delete','request',now=NOW)

def test_support_exact_consent_role_revocation_and_audit(db):
    service=SupportAccess(db);r=service.consent(1,3,['profile_summary'],'synthetic-ticket',confirmed=True,now=NOW);db.commit()
    assert service.read(3,r.id,'profile_summary',now=NOW)=={'owner_id':1,'user_id':1,'profile_present':False}
    audit=list(db.scalars(select(ActivityLog).where(ActivityLog.action=='support_read')));assert len(audit)==1 and audit[0].resource_id==1
    with pytest.raises(BoundaryDenied):service.read(2,r.id,'profile_summary',now=NOW)
    service.revoke(1,r.id);db.commit()
    with pytest.raises(BoundaryDenied):service.read(3,r.id,'profile_summary',now=NOW)

@pytest.mark.parametrize('case',['expiry','wrong_scope','lost_role','cost_reader'])
def test_support_cannot_expand_authority(db,case):
    service=SupportAccess(db);r=service.consent(1,3,['profile_summary'],'ticket',confirmed=True,now=NOW);db.commit()
    if case=='lost_role':db.get(User,3).role=UserRole.USER;db.commit()
    if case=='cost_reader':
        db.get(User,3).role=UserRole.USER;db.add(AdministrativeRoleGrant(user_id=3,role='cost_dashboard_admin',source='synthetic'));db.commit()
    with pytest.raises(BoundaryDenied):service.read(3,r.id,'diagnostics' if case=='wrong_scope' else 'profile_summary',now=NOW+timedelta(hours=1) if case=='expiry' else NOW)

def test_support_audit_failure_returns_no_data(db,monkeypatch):
    service=SupportAccess(db);r=service.consent(1,3,['profile_summary'],'ticket',confirmed=True,now=NOW);db.commit()
    def fail():raise RuntimeError('synthetic audit persistence unavailable')
    monkeypatch.setattr(db,'commit',fail)
    with pytest.raises(RuntimeError):service.read(3,r.id,'profile_summary',now=NOW)
    db.rollback();assert not list(db.scalars(select(ActivityLog).where(ActivityLog.action=='support_read')))

def test_monitor_reads_owned_actual_state_and_records_deduplicated_local_alert(db):
    db.add(ZerodhaPortfolioSnapshot(user_id=1,snapshot_date=NOW.date(),captured_at=NOW-timedelta(hours=1),source='synthetic'))
    db.add(SpendAccount(user_id=1,day=NOW.date().isoformat(),cap_usd=Decimal('1'),spent_usd=Decimal('2'),reserved_usd=0));db.commit()
    monitor=OperationalMonitor(db);sink=LocalSink();first=monitor.observe(1,correlation_id=str(uuid4()),now=NOW,sink=sink);second=monitor.observe(1,correlation_id=str(uuid4()),now=NOW,sink=sink)
    assert first['stale_data'] and first['cost_spike'] and first['action']=='pause_and_review' and len(sink.receipts)==1
    assert monitor.snapshot(2,now=NOW)['cost_spike']is False
    with pytest.raises(BoundaryDenied):monitor.observe(1,correlation_id=str(uuid4()),now=NOW,sink=object())


def test_private_routes_enforce_completed_owned_export_and_audited_support(db):
    import httpx
    from fastapi import FastAPI
    from app.domains.public_service.router import router
    from app.domains.auth.dependencies import get_current_user
    from app.infrastructure.database.session import get_async_db
    from app.domains.public_service.security import PublicIngress
    class Bridge:
        async def run_sync(self,fn):return fn(db)
        async def commit(self):db.commit()
        async def rollback(self):db.rollback()
    app=FastAPI();app.include_router(router);app.add_middleware(PublicIngress,frontend_url='http://synthetic.invalid')
    identity=[1];app.dependency_overrides[get_current_user]=lambda:db.get(User,identity[0]);app.dependency_overrides[get_async_db]=lambda:Bridge()
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://synthetic.invalid') as c:
            r=await c.post('/account/operations/privacy-requests',json={'key':'http-export','kind':'export','confirmed':True});assert r.status_code==200;key=r.json()['id']
            path='/account/operations/privacy-requests/'+key+'/export'
            assert (await c.get(path)).status_code==404
            adapter=SyntheticAccountDataAdapter(db,SyntheticRetentionReview('synthetic:review',True));adapter.seed(1,inventory(1));PrivacyRequests(db).drill(1,key,store=adapter);db.commit()
            r=await c.get(path);assert r.status_code==200 and r.headers['cache-control']=='private, no-store' and r.headers['x-credx-scope']=='synthetic-only' and 'NEVER_EXPORT' not in r.text
            identity[0]=2;assert (await c.get(path)).status_code==404
            identity[0]=1
            r=await c.post('/account/operations/support-consents',json={'actor_id':3,'scopes':['profile_summary'],'ticket':'synthetic-http-ticket','confirmed':True});assert r.status_code==200;consent=r.json()['id']
            access='/account/operations/support-consents/'+consent+'/access?scope=profile_summary'
            identity[0]=2;assert (await c.get(access)).status_code==403
            identity[0]=3;r=await c.get(access);assert r.status_code==200 and r.json()['owner_id']==1
            identity[0]=1;assert (await c.post('/account/operations/support-consents/'+consent+'/revoke')).status_code==200
            identity[0]=3;assert (await c.get(access)).status_code==403
            identity[0]=1;r=await c.get('/account/operations/diagnostics');assert r.status_code==200 and r.json()['owner_id']==1
            assert (await c.post('/account/operations/support-consents',json={'actor_id':3,'scopes':['credentials'],'ticket':'synthetic-http-ticket','confirmed':True})).status_code==409
    asyncio.run(run())
    assert len(list(db.scalars(select(ActivityLog).where(ActivityLog.action=='support_read'))))==1
