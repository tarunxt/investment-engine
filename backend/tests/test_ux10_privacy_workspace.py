"""Owned requests and partial downloads; no erasure, keys or external files."""
import json
import pytest
from sqlalchemy import select,func
from test_private_api_ownership import private_api
from test_hosted_order_composition import order_env,worker_env,linked_env
from app.domains.public_service.router import router
from app.domains.public_service.privacy import PrivacyRequests,public_receipt
from app.domains.public_service.account_download import snapshot
from app.domains.auth.models import UserProfile,User
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.ai_limits.contracts import BoundaryDenied


def test_history_replay_cancellation_and_auth_survive_without_selected_modules(private_api):
    a=private_api;a.app.include_router(router)
    assert a.client.get('/account/operations/privacy-requests').status_code==401
    body={'kind':'delete','key':'one-review-identity','confirmed':True}
    first=a.client.post('/account/operations/privacy-requests',json=body,headers=a.headers[0]);assert first.status_code==200
    repeat=a.client.post('/account/operations/privacy-requests',json=body,headers=a.headers[0]);assert repeat.json()['id']==first.json()['id']
    own=a.client.get('/account/operations/privacy-requests',headers=a.headers[0]);assert len(own.json()['items'])==1 and own.json()['real_deletion_enabled'] is False
    assert own.headers['cache-control']=='private, no-store' and own.headers['x-content-type-options']=='nosniff'
    other=a.client.get('/account/operations/privacy-requests',headers=a.headers[1]);assert other.json()['items']==[]
    id=first.json()['id'];assert a.client.post('/account/operations/privacy-requests/'+id+'/cancel',headers=a.headers[1]).status_code==404
    cancelled=a.client.post('/account/operations/privacy-requests/'+id+'/cancel',headers=a.headers[0]);assert cancelled.json()['state']=='cancelled'
    assert a.session.scalar(select(func.count()).select_from(User))==3
    assert a.client.get('/account/operations/private-account-download',headers=a.headers[0]).status_code==503


def test_malformed_request_history_fails_closed_and_never_exposes_payload(private_api):
    a=private_api;row=PrivacyRequests(a.session).request(a.users[0].id,'malformed-receipt','delete',confirmed=True)
    original=dict(row.payload)
    row.payload={**row.payload,'created_at':'unreviewed-private-content'};a.session.flush()
    with pytest.raises(BoundaryDenied):public_receipt(row)
    with pytest.raises(BoundaryDenied):PrivacyRequests(a.session).history(a.users[0].id)
    row.payload={**original,'state':'SYNTHETICPRIVATETOKEN'}
    with pytest.raises(BoundaryDenied):public_receipt(row)


@pytest.mark.parametrize('worker_env',['journal'],indirect=True)
def test_partial_snapshot_uses_real_typed_native_evidence_and_withholds_other_stores(order_env):
    e,analysis,worker,factory,celery,deliveries,clock,flow_id,intent=order_env
    with analysis.session() as db:
        UserProfile.__table__.create(db.get_bind(),checkfirst=True)
        db.add(UserProfile(user_id=1,bio='not in named projection',google_sheets_master_url='not-released',timezone='UTC'));db.commit()
        before=db.scalar(select(func.count()).select_from(OutboxMessage));result=snapshot(db,1,analysis.scope)
        assert result['owner_id']==1 and result['complete_account_export'] is False and result['complete_account_erasure'] is False and result['real_deletion_enabled'] is False
        encoded=json.dumps(result);assert 'not-released' not in encoded and 'not in named projection' not in encoded and 'password_hash' not in encoded
        assert result['native_evidence']['owner_id']==1 and result['coverage']['sql'].startswith('held:')
        assert db.scalar(select(func.count()).select_from(OutboxMessage))==before
        second=snapshot(db,2,analysis.scope);assert second['owner_id']==2
        assert not ({r['id'] for r in result['native_evidence']['items']}&{r['id'] for r in second['native_evidence']['items']})
        with pytest.raises((BoundaryDenied,PermissionError)):snapshot(db,999,analysis.scope)


@pytest.mark.asyncio
@pytest.mark.parametrize('worker_env',['journal'],indirect=True)
async def test_actual_download_http_uses_separate_owned_session_and_private_attachment(order_env,monkeypatch):
    import httpx
    from fastapi import FastAPI
    from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
    from app.domains.auth.dependencies import get_current_user
    from app.uat2.http_bindings import SimulationHTTPBinding
    import app.infrastructure.database.session as sessions
    e,analysis,worker,factory,celery,deliveries,clock,flow_id,intent=order_env
    with analysis.session() as db:UserProfile.__table__.create(db.get_bind(),checkfirst=True)
    engine=create_async_engine('sqlite+aiosqlite:///'+str(e.path));monkeypatch.setattr(sessions,'AsyncSessionLocal',async_sessionmaker(engine,expire_on_commit=False))
    app=FastAPI();app.include_router(router);SimulationHTTPBinding(scope=analysis.scope,source_storage='journal').install(app)
    owner=[1];app.dependency_overrides[get_current_user]=lambda:e.db.get(User,owner[0])
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            for subject in (1,2):
                owner[0]=subject;response=await client.get('/account/operations/private-account-download?owner_id=999')
                assert response.status_code==200 and response.json()['owner_id']==subject
                assert response.headers['cache-control']=='private, no-store' and response.headers['x-content-type-options']=='nosniff'
                assert response.headers['content-disposition'].startswith('attachment;')
                assert response.json()['complete_account_export'] is False and response.json()['real_deletion_enabled'] is False
    finally:await engine.dispose()
