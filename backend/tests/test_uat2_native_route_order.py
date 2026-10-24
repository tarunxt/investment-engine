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
