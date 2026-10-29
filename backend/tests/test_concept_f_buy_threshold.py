"""Synthetic SQLite owner/CAS preference contracts, not PostgreSQL qualification."""
import pytest
from types import SimpleNamespace
from sqlalchemy import select, func
from app.domains.auth.models import UserProfile, ActivityLog
from app.domains.modules.models import UserModule
from app.infrastructure.database.outbox.models import OutboxMessage
from app.uat2.buy_threshold import project, SaveThreshold
from test_stage18_linked_analysis_preview import linked_env
from test_synthetic_acquisition_journal import setup

@pytest.mark.parametrize('portfolio,field,other',[('india','zerodha_buy_threshold','indmoney_buy_threshold'),('indmoney_us','indmoney_buy_threshold','zerodha_buy_threshold')])
def test_explicit_save_owns_market_and_atomic_revision_not_whole_profile(linked_env,portfolio,field,other):
    e=linked_env;UserProfile.__table__.create(e.db.get_bind(),checkfirst=True);ActivityLog.__table__.create(e.db.get_bind(),checkfirst=True);scope,_=setup(e);binding=SimpleNamespace(scope=scope)
    if portfolio=='indmoney_us' and not e.db.scalar(select(UserModule).where(UserModule.user_id==1,UserModule.module_id=='indmoney_us')):
        e.db.add(UserModule(user_id=1,module_id='indmoney_us',enabled=True,version=1,config={'schema_version':1},schedules_paused=True))
    row=e.db.get(UserProfile,1)
    if row is None:row=UserProfile(user_id=1);e.db.add(row)
    e.db.commit();before={k:getattr(row,k) for k in [other,'timezone','theme_preference','notification_preferences']}
    outbox=e.db.scalar(select(func.count()).select_from(OutboxMessage))
    read=project(e.db,1,portfolio,binding);assert read['preferences_writable'] and read['owner_id']==1
    saved=project(e.db,1,portfolio,binding,SaveThreshold(expected_version=read['version'],value=0));e.db.commit()
    assert saved['threshold']==0 and saved['version']!=read['version'];assert getattr(row,field)==0
    assert {k:getattr(row,k) for k in before}==before
    assert e.db.scalar(select(func.count()).select_from(OutboxMessage))==outbox
    with pytest.raises(ValueError):project(e.db,1,portfolio,binding,SaveThreshold(expected_version=read['version'],value=5))
    assert getattr(row,field)==0
    # A response lost after commit is recovered by GET; replay cannot overwrite.
    assert project(e.db,1,portfolio,binding)['version']==saved['version']
    # Even an unrelated ordinary profile update invalidates the read revision.
    row.bio='Synthetic concurrent edit';e.db.commit()
    with pytest.raises(ValueError):project(e.db,1,portfolio,binding,SaveThreshold(expected_version=saved['version'],value=5))
    assert e.db.scalar(select(func.count()).select_from(ActivityLog).where(ActivityLog.action=='update_advisory_buy_threshold'))==1

@pytest.mark.parametrize('value',[float('nan'),float('inf'),-101,101])
def test_existing_profile_range_and_finite_values(value):
    with pytest.raises(ValueError):SaveThreshold(expected_version='a'*64,value=value)

def test_foreign_disabled_and_recovery_cannot_save(linked_env,monkeypatch):
    e=linked_env;UserProfile.__table__.create(e.db.get_bind(),checkfirst=True);ActivityLog.__table__.create(e.db.get_bind(),checkfirst=True);scope,_=setup(e);binding=SimpleNamespace(scope=scope)
    if e.db.get(UserProfile,1) is None:e.db.add(UserProfile(user_id=1));e.db.commit()
    read=project(e.db,1,'india',binding);body=SaveThreshold(expected_version=read['version'],value=1)
    with pytest.raises(Exception):project(e.db,2,'india',binding,body)
    monkeypatch.setenv('CREDX_RECOVERY_MODE','1')
    assert project(e.db,1,'india',binding)['preferences_writable'] is False
    with pytest.raises(PermissionError):project(e.db,1,'india',binding,body)
    monkeypatch.setenv('CREDX_RECOVERY_MODE','0')
    row=e.db.scalar(select(UserModule).where(UserModule.user_id==1,UserModule.module_id=='zerodha_rebalance'));row.enabled=False;e.db.commit()
    with pytest.raises(Exception):project(e.db,1,'india',binding,body)


def test_native_threshold_routes_are_actual_authenticated_static_handlers(monkeypatch):
    from test_uat2_native_route_order import first
    from app.uat2.main import app
    from fastapi.testclient import TestClient
    monkeypatch.setenv('CREDX_UAT2','1')
    client=TestClient(app,raise_server_exceptions=False)
    try:
        for portfolio in ('india','indmoney_us'):
            path='/uat2/simulation/buy-threshold/'+portfolio
            for method,name in [('GET','read'),('PUT','save')]:
                assert first(path,method)[0].name==name
                assert client.request(method,path,json={'expected_version':'a'*64,'value':0} if method=='PUT' else None).status_code==401
    finally:client.close()
    assert app.dependency_overrides=={}

@pytest.mark.asyncio
async def test_installed_http_save_stale_revision_and_owner_isolation(linked_env,monkeypatch):
    import httpx
    from fastapi import FastAPI
    from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
    import app.infrastructure.database.session as sessions
    from app.domains.auth.dependencies import get_current_user
    from app.domains.auth.models import User
    from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
    from app.uat2.workflow import install_workflow
    from app.domains.modules.transports import install_route_policy
    e=linked_env
    UserProfile.__table__.create(e.db.get_bind(),checkfirst=True);ActivityLog.__table__.create(e.db.get_bind(),checkfirst=True)
    e.db.add_all([UserProfile(user_id=1),UserProfile(user_id=2)]);e.db.commit()
    engine=create_async_engine('sqlite+aiosqlite:///'+str(e.path))
    monkeypatch.setattr(sessions,'AsyncSessionLocal',async_sessionmaker(engine,expire_on_commit=False))
    app=FastAPI();install_workflow(app,scope=SimulationSourceScope('preview'),source_storage='journal');install_route_policy(app)
    subject=[1];app.dependency_overrides[get_current_user]=lambda:e.db.get(User,subject[0])
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            path='/uat2/simulation/buy-threshold/india'
            read=await client.get(path);assert read.status_code==200,read.text
            assert read.headers['cache-control']=='private, no-store'
            original=read.json();body={'expected_version':original['version'],'value':0}
            assert (await client.put(path,json={**body,'owner_id':2})).status_code==422
            assert (await client.put(path,json={**body,'value':True})).status_code==422
            saved=await client.put(path,json=body);assert saved.status_code==200,saved.text
            assert saved.json()['threshold']==0
            assert (await client.put(path,json=body)).status_code==409
            assert (await client.get(path)).json()['version']==saved.json()['version']
            subject[0]=2
            response=await client.put(path,json={'expected_version':saved.json()['version'],'value':1})
            assert response.status_code==409 and 'version' not in response.json()
            e.db.expire_all();assert e.db.get(UserProfile,1).zerodha_buy_threshold==0
            assert e.db.get(UserProfile,2).zerodha_buy_threshold==2.5
    finally:await engine.dispose()
