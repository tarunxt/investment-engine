"""Real owner-bound policy/read projections with private synthetic fixtures."""
import pytest
from sqlalchemy import select
from test_stage06_modules import modules,private_api,payload
from app.domains.modules.policy import DefaultFactsResolver,ModuleFacts
from app.domains.jobs.models import Job
from app.domains.runs.models import Run
from app.shared.types import JobStatus

@pytest.fixture
def ready(modules,monkeypatch):
    monkeypatch.delenv('CREDX_UAT2',raising=False)
    monkeypatch.setattr(DefaultFactsResolver,'resolve_sync',lambda *_:ModuleFacts(jurisdiction='allowed',plan='allowed',connection='ready',execution_capability=True))
    return modules

@pytest.mark.parametrize('selected',[[],['zerodha_rebalance'],['indmoney_us'],['zerodha_rebalance','indmoney_us']])
def test_ordinary_history_sql_filters_owner_modules_counts_and_search(ready,selected):
    a=ready
    original_total=a.client.get('/jobs',headers=a.headers[0]).json()['total']
    for owner in a.users[:2]:
        for module in ['zerodha_rebalance','indmoney_us','ai_studio']:
            a.session.add(Job(user_id=owner.id,prompt=f'private owner{owner.id} '+module,provider='synthetic',model='offline',status=JobStatus.COMPLETED,module_id=module,module_version=1))
            a.session.add(Run(user_id=owner.id,prompt=f'private owner{owner.id} '+module,prompt_preview=f'private owner{owner.id} '+module,status=JobStatus.COMPLETED,module_id=module,module_version=1))
    a.session.commit()
    if selected:assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,*[(m,True) for m in selected])).status_code==200
    for path in ['/jobs','/runs']:
        response=a.client.get(path+'?selected_only=true',headers=a.headers[0]);assert response.status_code==200,response.text
        result=response.json();assert result['total']==len(selected)
        assert all(f'owner{a.users[0].id}' in row.get('prompt',row.get('prompt_preview','')) for row in result['items'])
        assert all(row.get('module_id') in selected if 'module_id' in row else any(m in row.get('prompt',row.get('prompt_preview','')) for m in selected) for row in result['items'])
    hidden=a.client.get('/jobs?selected_only=true&q=ai_studio',headers=a.headers[0]).json()
    assert hidden['total']==0 and hidden['items']==[]
    # Explicit owned core history is preserved, never deleted on disable.
    assert a.client.get('/jobs',headers=a.headers[0]).json()['total']==original_total+3
    assert a.client.get('/jobs?selected_only=true',headers=a.headers[1]).json()['total']==0


def test_manifest_canonical_default_off_unavailable_and_core_safety(ready):
    a=ready;r=a.client.get('/me/modules',headers=a.headers[0]);assert r.status_code==200
    data=r.json();assert len(data['modules'])==10 and not any(m['selection']['enabled'] for m in data['modules'])
    presentation=data['presentation'];assert presentation['schema_version']==1
    assert presentation['safety_activity_path']=='/console/profile/activity'
    assert '/console/profile' in presentation['core_paths']
    ids={m['module_id'] for m in data['modules']}
    assert all(set(s['module_ids'])<=ids for s in presentation['surfaces']+presentation['api_rules'])
    assert any(s['path']=='/console/auto-rebalance-runs/indmoneyUs' for s in presentation['surfaces'])
    for module in ['bullpen_research','bullpen_live','copy_trader','prediction_direct']:
        response=a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,(module,True)))
        assert response.status_code==409 and response.json()['detail']['code']=='MODULE_UNAVAILABLE'
    assert a.client.get('/me/modules',headers=a.headers[0]).json()['version']==0


def test_selection_does_not_grant_unknown_eligibility_or_connection(modules):
    a=modules
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('zerodha_rebalance',True))).status_code==200
    data=a.client.get('/me/modules',headers=a.headers[0]).json()
    row=next(m for m in data['modules'] if m['module_id']=='zerodha_rebalance')
    assert row['selection']['enabled'] and not any(d['allowed'] for d in row['capabilities'].values())
    assert row['selection']['schedules_paused'] and not row['execution']['action_confirmed']

@pytest.mark.asyncio
@pytest.mark.parametrize('selected',[[],['zerodha_rebalance'],['indmoney_us'],['ai_studio']])
async def test_dashboard_starts_only_permitted_loaders_and_never_singleton(monkeypatch,selected):
    from app.domains.dashboard import service as d
    from app.domains.dashboard.schemas import DashboardZerodhaSection,DashboardIndMoneySection,DashboardPortfolioHistory,DashboardFxRate
    calls=[]
    async def india(owner):calls.append('zerodha_rebalance');return DashboardZerodhaSection(connected=False)
    async def us(owner):calls.append('indmoney_us');return DashboardIndMoneySection()
    async def forbidden(*a,**kw):pytest.fail('Hidden singleton loader started')
    async def history(owner,*,module_ids):assert module_ids==selected;calls.append('history');return DashboardPortfolioHistory()
    async def fx(owner):calls.append('fx');return DashboardFxRate(stale_after_seconds=3600,status='unavailable')
    monkeypatch.setattr(d,'_load_zerodha',india);monkeypatch.setattr(d,'_load_indmoney',us);monkeypatch.setattr(d,'_load_bullpen',forbidden)
    monkeypatch.setattr(d,'_load_portfolio_history',history);monkeypatch.setattr(d,'_load_fx',fx)
    result=await d.build_dashboard_summary(1,module_ids=selected)
    assert set(calls)==set([m for m in selected if m in {'zerodha_rebalance','indmoney_us'}]+(['history'] if any(m in selected for m in ('zerodha_rebalance','indmoney_us')) else [])+(['fx'] if 'indmoney_us' in selected else []))
    assert result.bullpen is None
    if 'zerodha_rebalance' not in selected:assert result.zerodha is None
    if 'indmoney_us' not in selected:assert result.indmoney_us is None


def test_safety_activity_is_owned_core_and_does_not_grant_runtime_access(modules):
    import json
    from app.domains.auth.models import ActivityLog
    a=modules
    a.session.add_all([ActivityLog(user_id=user.id,action='order_pending',resource_type='synthetic_order',details=json.dumps({'status':'pending'})) for user in a.users[:2]])
    a.session.commit()
    response=a.client.get('/me/modules/safety-activity',headers=a.headers[0]);assert response.status_code==200,response.text
    data=response.json();assert data['owner_id']==a.users[0].id and data['read_only']
    assert len(data['events'])==1 and data['events'][0]['action']=='order_pending'
    assert data['sources'][0]['state']=='restricted' and not data['complete_financial_reconciliation']
    assert a.client.get('/me/modules/safety-activity').status_code==401


def test_notification_projection_filters_before_limit_retains_core_safety(ready,monkeypatch):
    import json
    from sqlalchemy.orm import sessionmaker
    from app.domains.auth.models import ActivityLog
    from app.domains.mails import service
    a=ready
    for owner in a.users[:2]:
        for action,module in [('mail.run_completion','zerodha_rebalance'),('mail.run_completion','indmoney_us'),('mail.password_reset',None),('mail.stage2_position_warning',None)]:
            a.session.add(ActivityLog(user_id=owner.id,action=action,resource_type=service.MAIL_RESOURCE_TYPE,details=json.dumps({'module_id':module,'status':'sent','category':'account' if action=='mail.password_reset' else 'runs'})))
    a.session.commit();monkeypatch.setattr(service,'SyncSessionLocal',sessionmaker(a.session.get_bind()))
    rows=service.list_mail_history_sync(a.users[0].id,selected_modules=['zerodha_rebalance'])
    assert len(rows)==3
    assert {row['trigger'] for row in rows}=={'mail.run_completion','mail.password_reset','mail.stage2_position_warning'}
    rows=service.list_mail_history_sync(a.users[0].id,selected_modules=[])
    assert len(rows)==2
    from app.domains.modules.notification_visibility import preference_visible
    assert preference_visible({'key':'password_reset','segments':['All']},[])
    assert not preference_visible({'key':'completion.indmoney.sync','segments':['IndMoney']},['zerodha_rebalance'])


def test_owned_resource_preflight_reveals_no_hidden_payload_or_foreign_existence(ready):
    a=ready
    job=Job(user_id=a.users[0].id,prompt='Never include this hidden payload',provider='synthetic',model='offline',status=JobStatus.COMPLETED,module_id='zerodha_rebalance',module_version=1)
    a.session.add(job);a.session.commit();path=f'/me/modules/resource-access/jobs/{job.id}'
    before=a.client.get(path,headers=a.headers[0]);assert before.status_code==200 and not before.json()['allowed']
    assert 'prompt' not in before.json() and 'Never include' not in before.text
    foreign=a.client.get(path,headers=a.headers[1]);missing=a.client.get('/me/modules/resource-access/jobs/9999999',headers=a.headers[1]);assert foreign.status_code==missing.status_code==404 and foreign.json()==missing.json()
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('zerodha_rebalance',True))).status_code==200
    assert a.client.get(path,headers=a.headers[0]).json()['allowed']
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('zerodha_rebalance',False))).status_code==200
    assert not a.client.get(path,headers=a.headers[0]).json()['allowed']


def test_internal_provider_metadata_uses_selected_consumer_without_ai_studio_grant(ready,monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from app.domains.ai_providers import router as providers
    from app.domains.modules.transports import install_route_policy
    a=ready;a.app.include_router(providers.router);install_route_policy(a.app)
    monkeypatch.setattr(providers.ProviderFactory,'list_providers',lambda:[])
    monkeypatch.setattr(providers,'load_persisted_usd_inr_rate',AsyncMock(return_value=SimpleNamespace(valid_value=None)))
    assert a.client.get('/providers',headers=a.headers[0]).status_code==403
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('zerodha_rebalance',True))).status_code==200
    assert a.client.get('/providers',headers=a.headers[0]).status_code==200
    # Shared metadata is not standalone AI or effect authority.
    assert a.client.post('/jobs',headers=a.headers[0],json={'prompt':'synthetic','provider':'synthetic','model':'offline'}).status_code==403
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('zerodha_rebalance',False))).status_code==200
    assert a.client.get('/providers',headers=a.headers[0]).status_code==403
