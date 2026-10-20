"""Canonical module policy/API checks: synthetic SQL rows, no integrations."""
from contextlib import asynccontextmanager
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from pydantic import ValidationError

from test_private_api_ownership import private_api
from app.domains.modules.models import UserModule, UserModulePreferences
from app.domains.modules import registry, policy, service
from app.domains.modules.registry import ModuleId, ModuleConfigV1, REGISTRY
from app.domains.modules.schemas import ModulePatch


@pytest.fixture
def modules(private_api):
    a = private_api
    from app.domains.modules.router import router
    UserModulePreferences.__table__.create(a.session.get_bind())
    UserModule.__table__.create(a.session.get_bind())
    a.app.include_router(router)
    return a


def payload(version, *changes):
    return {'expected_version': version, 'updates': [
        {'module_id': id, 'enabled': enabled} for id, enabled in changes]}


def entries(response):
    return {m['module_id']: m for m in response.json()['modules']}


def test_exact_registry_and_dependency_graph_validation():
    assert {id.value for id in REGISTRY} == {'zerodha_rebalance','indmoney_us','bullpen_research',
        'bullpen_live','copy_trader','prediction_direct','market_scanner','ai_studio','sheets_export','sports_rankings'}
    scanner, studio = REGISTRY[ModuleId.MARKET_SCANNER], REGISTRY[ModuleId.AI_STUDIO]
    with pytest.raises(ValueError, match='Duplicate'):
        registry.validate_catalogue([scanner, scanner])
    with pytest.raises(ValueError, match='Unknown module dependency'):
        registry.validate_catalogue([replace(studio, requires=(ModuleId.MARKET_SCANNER,))])
    with pytest.raises(ValueError, match='Cyclic'):
        registry.validate_catalogue([replace(studio, requires=(scanner.id,)), replace(scanner, requires=(studio.id,))])
    assert all(not spec.requires for spec in REGISTRY.values())


@pytest.mark.parametrize('bad', [
    {'schema_version': 2}, {'trading_enabled': True}, {'api_key': 'synthetic-not-a-key'},
])
def test_config_schema_is_typed_and_cannot_confer_authority(bad):
    with pytest.raises(ValidationError): ModuleConfigV1.model_validate(bad)


@pytest.mark.parametrize('method,path,body', [
    ('GET','/me/modules',None), ('PATCH','/me/modules',payload(0,('market_scanner',True))),
    ('POST','/me/modules/disable-impact',{'expected_version':0,'module_ids':['market_scanner']}),
])
def test_module_contract_requires_current_active_owner(modules,method,path,body):
    a=modules
    assert a.client.request(method,path,json=body).status_code==401
    assert a.client.request(method,path,json=body,headers=a.headers[2]).status_code==403
    assert a.session.scalar(select(func.count()).select_from(UserModulePreferences))==0


def test_new_and_existing_accounts_default_to_no_modules_without_get_writes(modules):
    a=modules
    for headers in a.headers[:2]:
        response=a.client.get('/me/modules',headers=headers)
        assert response.status_code==200,response.text
        assert response.headers['cache-control']=='private, no-store'
        assert response.json()['version']==0
        assert len(response.json()['modules'])==10
        for module in response.json()['modules']:
            assert module['selection']=={'enabled':False,'version':0,'config':{'schema_version':1},'schedules_paused':True}
            assert module['execution']['capable'] is False
            assert module['entitlement']=={'jurisdiction':'unknown','plan':'unknown'}
            assert all(not cap['allowed'] for cap in module['capabilities'].values())
    assert a.session.scalar(select(func.count()).select_from(UserModulePreferences))==0
    assert a.session.scalar(select(func.count()).select_from(UserModule))==0


def test_atomic_multi_update_stale_conflict_and_owner_separation(modules):
    a=modules
    response=a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('market_scanner',True),('indmoney_us',True)))
    assert response.status_code==200,response.text
    assert response.json()['owner_id']==a.users[0].id and response.json()['version']==1
    own=entries(response)
    assert own['market_scanner']['selection']['enabled'] is True
    assert own['indmoney_us']['selection']['enabled'] is True
    assert own['ai_studio']['selection']['enabled'] is False
    assert all(not cap['allowed'] for cap in own['market_scanner']['capabilities'].values())
    other=a.client.get('/me/modules',headers=a.headers[1])
    assert other.json()['owner_id']==a.users[1].id and other.json()['version']==0
    assert not any(m['selection']['enabled'] for m in other.json()['modules'])
    stale=a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('market_scanner',False)))
    assert stale.status_code==409 and stale.json()['detail']['code']=='MODULE_VERSION_CONFLICT'
    assert entries(a.client.get('/me/modules',headers=a.headers[0]))['market_scanner']['selection']['enabled'] is True
    assert a.session.scalar(select(func.count()).select_from(UserModule))==2


@pytest.mark.parametrize('extra', [{'owner_id':2},{'user_id':2},{'role':'admin'},{'execution_capability':True}])
def test_body_identity_and_authority_overrides_are_rejected(modules,extra):
    a=modules
    response=a.client.patch('/me/modules',headers=a.headers[0],json={**payload(0,('market_scanner',True)),**extra})
    assert response.status_code==422
    assert a.session.scalar(select(func.count()).select_from(UserModule))==0


@pytest.mark.parametrize('updates', [
    [{'module_id':'unknown','enabled':True}],
    [{'module_id':'market_scanner','enabled':'true'}],
    [{'module_id':'market_scanner','enabled':True,'config':{'execution_capability':True}}],
    [{'module_id':'market_scanner','enabled':True},{'module_id':'market_scanner','enabled':False}],
])
def test_unknown_invalid_duplicate_updates_never_partially_commit(modules,updates):
    a=modules
    response=a.client.patch('/me/modules',headers=a.headers[0],json={'expected_version':0,'updates':updates})
    assert response.status_code==422,response.text
    assert a.session.scalar(select(func.count()).select_from(UserModulePreferences))==0


def test_unavailable_module_rejects_entire_patch_and_uat2_stays_closed(modules,monkeypatch):
    a=modules
    response=a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('market_scanner',True),('bullpen_live',True)))
    assert response.status_code==409 and response.json()['detail']['code']=='MODULE_UNAVAILABLE'
    assert a.session.scalar(select(func.count()).select_from(UserModulePreferences))==0
    # Exercise deployment availability without weakening the separate UAT2 auth gate.
    monkeypatch.setattr(service,'uat2_mode',lambda:True)
    response=a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('market_scanner',True)))
    assert response.status_code==409
    assert all(not m['availability']['available'] for m in a.client.get('/me/modules',headers=a.headers[0]).json()['modules'])


def test_dependency_validation_and_disable_preview_are_atomic_and_read_only(modules,monkeypatch):
    a=modules
    # Synthetic future dependency verifies the generic contract. Production
    # catalogue intentionally keeps standalone UI modules independent.
    specs=dict(REGISTRY)
    specs[ModuleId.AI_STUDIO]=replace(specs[ModuleId.AI_STUDIO],requires=(ModuleId.MARKET_SCANNER,))
    monkeypatch.setattr(service,'REGISTRY',specs)
    response=a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('ai_studio',True)))
    assert response.status_code==409 and response.json()['detail']['code']=='MODULE_DEPENDENCY_REQUIRED'
    response=a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('market_scanner',True),('ai_studio',True)))
    assert response.status_code==200,response.text
    preview=a.client.post('/me/modules/disable-impact',headers=a.headers[0],json={'expected_version':1,'module_ids':['market_scanner']})
    assert preview.status_code==200 and preview.json()['dependent_modules']==['ai_studio']
    assert preview.json()['changes_applied'] is False
    assert preview.json()['data_and_connections_retained'] is True
    assert a.client.get('/me/modules',headers=a.headers[0]).json()['version']==1
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('market_scanner',False))).status_code==409
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('market_scanner',False),('ai_studio',False))).status_code==200
    stale=a.client.post('/me/modules/disable-impact',headers=a.headers[0],json={'expected_version':1,'module_ids':['ai_studio']})
    assert stale.status_code==409


def test_existing_empty_version_zero_header_can_be_updated(modules):
    a=modules
    a.session.add(UserModulePreferences(user_id=a.users[0].id,version=0));a.session.commit()
    response=a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('market_scanner',True)))
    assert response.status_code==200 and response.json()['version']==1


@pytest.mark.parametrize('damage', ['unknown_module','invalid_config','future_version'])
def test_corrupt_module_state_is_closed_without_secret_details(modules,damage):
    a=modules
    a.session.add(UserModulePreferences(user_id=a.users[0].id,version=1));a.session.flush()
    a.session.add(UserModule(user_id=a.users[0].id,module_id='unknown' if damage=='unknown_module' else 'market_scanner',
        enabled=True,config={'api_key':'SYNTHETIC_PRIVATE_VALUE'} if damage=='invalid_config' else {},
        version=2 if damage=='future_version' else 1));a.session.commit()
    response=a.client.get('/me/modules',headers=a.headers[0])
    assert response.status_code==503 and 'SYNTHETIC_PRIVATE_VALUE' not in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize('boundary', ['http','stream','worker','side_effect'])
async def test_shared_policy_is_owner_bound_current_and_never_entitles_selection(modules,boundary):
    a=modules
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('zerodha_rebalance',True))).status_code==200
    resolver=SimpleNamespace(resolve=AsyncMock(return_value=policy.ModuleFacts(jurisdiction='allowed',plan='allowed',connection='ready')))
    gate=policy.ModulePolicy(a.db,resolver)
    denied=await gate.authorize(owner_id=a.users[0].id,resource_owner_id=a.users[1].id,
        module_id='zerodha_rebalance',capability='analyze',boundary=boundary)
    assert not denied.allowed and 'OWNER_MISMATCH' in denied.reasons
    resolver.resolve.assert_not_awaited()
    decision=await gate.authorize(owner_id=a.users[0].id,resource_owner_id=a.users[0].id,
        module_id='zerodha_rebalance',capability='analyze',boundary=boundary,expected_version=1)
    assert decision.allowed is (boundary!='side_effect')
    execute=await gate.authorize(owner_id=a.users[0].id,resource_owner_id=a.users[0].id,
        module_id='zerodha_rebalance',capability='execute',boundary=boundary)
    assert not execute.allowed and 'EXECUTION_CAPABILITY_REQUIRED' in execute.reasons
    assert 'EXPLICIT_ACTION_CONFIRMATION_REQUIRED' in execute.reasons
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('zerodha_rebalance',False))).status_code==200
    resolver.resolve.reset_mock()
    revoked=await gate.authorize(owner_id=a.users[0].id,resource_owner_id=a.users[0].id,
        module_id='zerodha_rebalance',capability='analyze',boundary=boundary,expected_version=1)
    assert not revoked.allowed and 'MODULE_VERSION_CHANGED' in revoked.reasons
    resolver.resolve.assert_not_awaited()


@pytest.mark.asyncio
async def test_internal_analysis_does_not_require_standalone_ui_and_core_stays_available(modules):
    a=modules
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('zerodha_rebalance',True))).status_code==200
    gate=policy.ModulePolicy(a.db,SimpleNamespace(resolve=AsyncMock(return_value=policy.ModuleFacts(
        jurisdiction='allowed',plan='allowed',connection='ready'))))
    decision=await gate.internal_analysis(owner_id=a.users[0].id,resource_owner_id=a.users[0].id,
        consumer=ModuleId.ZERODHA_REBALANCE,service_capability='analysis.technical')
    assert decision.allowed
    current=entries(a.client.get('/me/modules',headers=a.headers[0]))
    assert not current['ai_studio']['selection']['enabled'] and not current['market_scanner']['selection']['enabled']
    for capability in registry.CORE_CAPABILITIES:
        assert (await gate.authorize(owner_id=a.users[0].id,resource_owner_id=a.users[0].id,
            module_id=None,capability=capability,boundary='http')).allowed
    for id,capability in [(None,'unknown'),('unknown','view'),('zerodha_rebalance','unknown')]:
        assert not (await gate.authorize(owner_id=a.users[0].id,resource_owner_id=a.users[0].id,
            module_id=id,capability=capability,boundary='worker')).allowed
    a.users[0].is_active=False;a.session.commit()
    assert not (await gate.authorize(owner_id=a.users[0].id,resource_owner_id=a.users[0].id,
        module_id=None,capability='profile.read',boundary='http')).allowed


@pytest.mark.asyncio
async def test_unknown_or_malformed_server_facts_fail_closed(modules):
    a=modules
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('market_scanner',True))).status_code==200
    for resolver in [None, SimpleNamespace(resolve=AsyncMock(side_effect=RuntimeError('SYNTHETIC_PRIVATE'))),
                     SimpleNamespace(resolve=AsyncMock(return_value={'jurisdiction':'allowed','plan':'allowed','execution_capability':'yes'}))]:
        decision=await policy.ModulePolicy(a.db,resolver).authorize(owner_id=a.users[0].id,resource_owner_id=a.users[0].id,
            module_id='market_scanner',capability='analyze',boundary='worker')
        assert not decision.allowed and 'JURISDICTION_NOT_ENTITLED' in decision.reasons


@pytest.mark.asyncio
async def test_core_account_access_survives_corrupt_optional_state(modules):
    a=modules
    a.session.add(UserModulePreferences(user_id=a.users[0].id,version=1));a.session.flush()
    a.session.add(UserModule(user_id=a.users[0].id,module_id='unknown',enabled=True,config={},version=1));a.session.commit()
    assert a.client.get('/me/modules',headers=a.headers[0]).status_code==503
    for capability in registry.CORE_CAPABILITIES:
        decision=await policy.ModulePolicy(a.db).authorize(owner_id=a.users[0].id,
            resource_owner_id=a.users[0].id,module_id=None,capability=capability,boundary='http',expected_version=999)
        assert decision.allowed and decision.selection_version is None


@pytest.mark.asyncio
async def test_response_or_audit_failure_rolls_back_complete_selection_transaction(modules,monkeypatch):
    a=modules
    monkeypatch.setattr(service,'describe',AsyncMock(side_effect=RuntimeError('synthetic response failure')))
    with pytest.raises(RuntimeError,match='synthetic response failure'):
        await service.patch_modules(a.db,a.users[0].id,ModulePatch.model_validate(payload(0,('market_scanner',True))))
    assert a.session.scalar(select(func.count()).select_from(UserModulePreferences))==0
    assert a.session.scalar(select(func.count()).select_from(UserModule))==0
    from app.domains.auth.models import ActivityLog
    assert a.session.scalar(select(func.count()).select_from(ActivityLog).where(ActivityLog.action=='module_preferences_updated'))==0


@pytest.mark.asyncio
async def test_google_first_and_repeat_login_leave_optional_modules_default_denied(modules,monkeypatch):
    from app.domains.auth import google_signin
    from app.domains.auth.models import User,UserProfile,UserRole
    a=modules
    monkeypatch.setattr(google_signin.PasswordUtils,'hash_password',lambda _value:'synthetic-unusable-hash')
    before=[(u.id,u.role,u.profile.timezone,u.profile.zerodha_buy_threshold) for u in a.users]
    user=await google_signin.resolve_google_user(a.db,'new.module.fixture@gmail.com')
    await a.db.commit()
    owner_id=user.id
    assert user.role==UserRole.USER and user.profile.user_id==owner_id
    again=await google_signin.resolve_google_user(a.db,'new.module.fixture@gmail.com')
    assert again.id==owner_id and again.profile.user_id==owner_id
    snapshot=await service.read_snapshot(a.db,owner_id)
    assert snapshot.version==0 and snapshot.rows=={}
    assert a.session.scalar(select(func.count()).select_from(UserModulePreferences))==0
    assert a.session.scalar(select(func.count()).select_from(UserModule))==0
    assert [(u.id,u.role,u.profile.timezone,u.profile.zerodha_buy_threshold) for u in a.users]==before
    assert a.session.scalar(select(func.count()).select_from(User).where(User.email=='new.module.fixture@gmail.com'))==1
    assert a.session.scalar(select(func.count()).select_from(UserProfile).where(UserProfile.user_id==owner_id))==1


@pytest.mark.asyncio
async def test_failed_first_google_transaction_cannot_leave_optional_records(modules,monkeypatch):
    from app.domains.auth import google_signin
    from app.domains.auth.models import User
    a=modules
    monkeypatch.setattr(google_signin.PasswordUtils,'hash_password',lambda _value:'synthetic-unusable-hash')
    original=a.db.flush
    async def fail_after_user_flush():
        await original()
        raise RuntimeError('synthetic registration failure')
    monkeypatch.setattr(a.db,'flush',fail_after_user_flush)
    with pytest.raises(RuntimeError,match='synthetic registration failure'):
        await google_signin.resolve_google_user(a.db,'failed.module.fixture@gmail.com')
    await a.db.rollback()
    assert a.session.scalar(select(func.count()).select_from(User).where(User.email=='failed.module.fixture@gmail.com'))==0
    assert a.session.scalar(select(func.count()).select_from(UserModulePreferences))==0
    assert a.session.scalar(select(func.count()).select_from(UserModule))==0


@pytest.mark.asyncio
@pytest.mark.parametrize('facts,reason', [
    (policy.ModuleFacts(jurisdiction='denied',plan='allowed',connection='ready'),'JURISDICTION_NOT_ENTITLED'),
    (policy.ModuleFacts(jurisdiction='allowed',plan='denied',connection='ready'),'PLAN_NOT_ENTITLED'),
    (policy.ModuleFacts(jurisdiction='allowed',plan='allowed',connection='missing'),'CONNECTION_NOT_READY'),
])
async def test_entitlement_and_connection_axes_remain_independent(modules,facts,reason):
    a=modules
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('zerodha_rebalance',True))).status_code==200
    gate=policy.ModulePolicy(a.db,SimpleNamespace(resolve=AsyncMock(return_value=facts)))
    result=await gate.authorize(owner_id=a.users[0].id,resource_owner_id=a.users[0].id,
        module_id='zerodha_rebalance',capability='analyze',boundary='http')
    assert not result.allowed and reason in result.reasons
    if reason=='CONNECTION_NOT_READY':
        view=await gate.authorize(owner_id=a.users[0].id,resource_owner_id=a.users[0].id,
            module_id='zerodha_rebalance',capability='view',boundary='http')
        assert view.allowed # Missing connection does not erase selection/UI.


def test_disable_preview_includes_transitive_dependencies_without_changes(modules,monkeypatch):
    a=modules
    specs=dict(REGISTRY)
    specs[ModuleId.AI_STUDIO]=replace(specs[ModuleId.AI_STUDIO],requires=(ModuleId.MARKET_SCANNER,))
    specs[ModuleId.MARKET_SCANNER]=replace(specs[ModuleId.MARKET_SCANNER],requires=(ModuleId.SPORTS_RANKINGS,))
    monkeypatch.setattr(service,'REGISTRY',specs)
    response=a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,
        ('ai_studio',True),('market_scanner',True),('sports_rankings',True)))
    assert response.status_code==200,response.text
    result=a.client.post('/me/modules/disable-impact',headers=a.headers[0],json={
        'expected_version':1,'module_ids':['sports_rankings']})
    assert result.status_code==200
    assert result.json()['dependent_modules']==['market_scanner','ai_studio']
    assert result.json()['changes_applied'] is False
    assert a.client.get('/me/modules',headers=a.headers[0]).json()['version']==1


def test_unknown_catalogue_capability_cannot_be_registered():
    scanner=REGISTRY[ModuleId.MARKET_SCANNER]
    with pytest.raises(ValueError,match='Unknown module capability'):
        registry.validate_catalogue([replace(scanner,capabilities=frozenset({'grant_admin'}))])
