"""Actual native app registration, no preview binding or dependency override."""
import json
import pytest
from fastapi.testclient import TestClient
from fastapi.dependencies.utils import request_params_to_args
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from starlette.requests import Request
from starlette.routing import Match
from app.uat2.main import app
from app.uat2.http_bindings import STATE
from test_private_api_ownership import private_api


def scope(path,method='GET'):
    return {'type':'http','path':path,'root_path':'','method':method,'headers':[],
            'query_string':b'','scheme':'http','server':('testserver',80)}


def first(path,method='GET'):
    return next((r,child) for r in app.routes for match,child in [r.matches(scope(path,method))] if match is Match.FULL)


@pytest.mark.parametrize('path,method,name',[
    ('/runs/analysis-workflows','GET','list_analysis_workflows'),
    ('/runs/analysis-workflows/config','GET','analysis_config'),
    ('/runs/analysis-workflows/setup-context','GET','setup_context'),
    ('/runs/analysis-workflows/candidate-preview','POST','preview_candidates'),
    ('/runs/analysis-workflows/7','GET','get_analysis_workflow'),
    ('/runs/analysis-workflows','POST','create_analysis_workflow'),
    ('/runs/analysis-workflows/synthetic-source','POST','acquire_synthetic_source'),
])
def test_actual_native_static_workflow_routes_precede_legacy_run_parameter(path,method,name):
    route,child=first(path,method)
    assert route.endpoint.__module__=='app.domains.runs.analysis_router'
    assert route.name==name
    assert 'run_id' not in child.get('path_params',{})
    assert getattr(app.state,STATE).scope.mode=='hosted'
    assert app.dependency_overrides=={}


def test_existing_native_run_reads_still_resolve_to_their_owned_handlers():
    route,child=first('/runs/7');assert route.name=='get_run' and child['path_params']=={'run_id':'7'}
    assert first('/runs')[0].endpoint.__module__=='app.domains.runs.router'


@pytest.mark.asyncio
async def test_shadowing_reproduces_exact_observed_validation_response_without_auth_override():
    legacy=next(r for r in app.routes if getattr(r,'path',None)=='/runs/{run_id}')
    match,child=legacy.matches(scope('/runs/analysis-workflows'));assert match is Match.FULL
    _,errors=request_params_to_args(legacy.dependant.path_params,child['path_params'])
    response=await request_validation_exception_handler(Request(scope('/runs/analysis-workflows')),RequestValidationError(errors))
    detail=json.loads(response.body)['detail'][0]
    assert response.status_code==422
    assert (detail['type'],detail['loc'],detail['input'])==('int_parsing',['path','run_id'],'analysis-workflows')


@pytest.mark.parametrize('path',['/runs/analysis-workflows','/runs/analysis-workflows/config','/runs/7'])
def test_native_routes_keep_authentication_without_disposable_bindings(path,monkeypatch):
    monkeypatch.setenv('CREDX_UAT2','1')
    client=TestClient(app,raise_server_exceptions=False)
    try: assert client.get(path).status_code==401
    finally: client.close()
    assert app.dependency_overrides=={}


@pytest.mark.parametrize('portfolio',['india','indmoney_us'])
def test_native_history_http_uses_owned_legacy_read_handlers(private_api,portfolio):
    """Actual native ASGI routing/auth; only database dependency uses synthetic SQL.

    No runtime/auth override or hosted activation. This is SQLite HTTP evidence,
    not PostgreSQL/native-startup qualification.
    """
    from app.infrastructure.database.session import get_async_db
    from app.domains.runs.models import AutoRebalanceWorkflow
    from app.domains.jobs.models import Job
    from app.infrastructure.database.outbox.models import OutboxMessage
    from sqlalchemy import select,func
    a=private_api
    for owner,sequence in [(a.users[0].id,41),(a.users[1].id,42)]:
        a.session.add(AutoRebalanceWorkflow(user_id=owner,portfolio=portfolio,sequence=sequence,label=f'Synthetic {owner}',status='queued',current_stage='sync'))
    a.session.commit()
    before=tuple(a.session.scalar(select(func.count()).select_from(model)) for model in (AutoRebalanceWorkflow,Job,OutboxMessage))
    original=dict(app.dependency_overrides)
    assert original=={}
    app.dependency_overrides[get_async_db]=a.app.dependency_overrides[get_async_db]
    try:
        client=TestClient(app,raise_server_exceptions=True)
        try:
            path='/runs/auto-rebalance-history'
            assert client.get(path,params={'portfolio':portfolio}).status_code==401
            assert client.get(path,params={'portfolio':portfolio},headers=a.headers[2]).status_code==403
            for index,own,foreign in [(0,41,42),(1,42,41)]:
                response=client.get(path,params={'portfolio':portfolio,'owner_id':a.users[1-index].id},headers=a.headers[index])
                assert response.status_code==200,response.text
                assert [item['sequence'] for item in response.json()['items']]==[own]
                detail=client.get(f'{path}/{portfolio}/{own}',headers=a.headers[index]);assert detail.status_code==200,detail.text
                assert detail.json()['sequence']==own
                assert client.get(f'{path}/{portfolio}/{foreign}',headers=a.headers[index]).status_code==404
            # A corrupted historical RunJob must not expose another owner's response.
            from app.domains.runs.models import RunJob
            a.runs[0].auto_rebalance_portfolio=portfolio;a.runs[0].auto_rebalance_sequence=41
            a.jobs[3].response='synthetic-foreign-history-content'
            a.session.add(RunJob(run_id=a.runs[0].id,job_id=a.jobs[3].id));a.session.commit()
            response=client.get(f'{path}/{portfolio}/41',headers=a.headers[0])
            assert response.status_code==200,response.text
            assert 'synthetic-foreign-history-content' not in response.text
            assert response.json()['runs']==[]
            # Corrupt stage evidence must not expose foreign job/run identifiers.
            from app.domains.runs.models import AutoRebalanceWorkflowStage
            workflow=a.session.scalar(select(AutoRebalanceWorkflow).where(AutoRebalanceWorkflow.user_id==a.users[0].id,AutoRebalanceWorkflow.portfolio==portfolio))
            for pointer in ({'job_id':a.jobs[3].id},{'run_id':a.runs[1].id}):
                stage=AutoRebalanceWorkflowStage(workflow_id=workflow.id,stage='sync',status='queued',**pointer)
                a.session.add(stage);a.session.commit()
                assert client.get(f'{path}/{portfolio}/41',headers=a.headers[0]).status_code==404
                a.session.delete(stage);a.session.commit() # Disposable fixture only.

            assert client.get(path,params={'portfolio':'unknown'},headers=a.headers[0]).status_code==422
            assert client.patch(f'{path}/{portfolio}/41/stages/sync',json={},headers=a.headers[0]).status_code==503
        finally:
            client.close()
        assert tuple(a.session.scalar(select(func.count()).select_from(model)) for model in (AutoRebalanceWorkflow,Job,OutboxMessage))==before
    finally:
        app.dependency_overrides.clear();app.dependency_overrides.update(original)
    assert first('/runs/auto-rebalance-history')[0].name=='list_auto_rebalance_history'
    assert first(f'/runs/auto-rebalance-history/{portfolio}/41')[0].name=='get_auto_rebalance_history_detail'
    assert first('/runs/7')[0].name=='get_run'
    assert getattr(app.state,STATE).scope.mode=='hosted' and app.dependency_overrides=={}
