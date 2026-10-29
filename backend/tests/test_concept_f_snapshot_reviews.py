"""Disposable SQLite source review contracts; no hosted/PostgreSQL evidence."""
from datetime import timedelta
import pytest
from sqlalchemy import select
from test_stage18_linked_analysis_preview import linked_env
from test_synthetic_acquisition_journal import setup
from app.uat2.snapshot_reviews import SnapshotReviews, TOPIC
from app.domains.runs.analysis_workflows import synthetic_journal as journal
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
from app.infrastructure.database.outbox.models import OutboxMessage


def test_preview_exact_accept_restart_replay_and_rollback(linked_env):
    e = linked_env; _, composition = setup(e); reviews = SnapshotReviews(composition)
    first = reviews.preview(e.db, 1, 'review-first-key', now=e.now)
    e.db.commit()
    assert first['state'] == 'preview' and first['orders_authorized'] is False
    assert e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic == journal.TOPIC)) is None
    assert reviews.preview(e.db, 1, 'review-first-key', now=e.now) == first
    accepted = reviews.accept(e.db, 1, first['id'], first['review_digest'], now=e.now)
    e.db.rollback()
    assert reviews.describe(e.db, 1, first['id'], now=e.now)['state'] == 'preview'
    accepted = reviews.accept(e.db, 1, first['id'], first['review_digest'], now=e.now)
    e.db.commit(); e.db.expire_all()
    assert accepted['state'] == 'accepted' and accepted['is_current'] is True
    assert SnapshotReviews(composition).accept(e.db, 1, first['id'], first['review_digest'], now=e.now) == accepted
    rows = list(e.db.scalars(select(OutboxMessage).where(OutboxMessage.topic == journal.TOPIC)))
    assert len(rows) == 1 and rows[0].payload['source'] == first['review']['proposed']


@pytest.mark.parametrize('case', ['foreign', 'digest', 'tamper', 'new_source', 'expired', 'disabled', 'policy_version', 'reconnect'])
def test_exact_review_fails_closed(linked_env, case):
    e = linked_env; scope, composition = setup(e); reviews = SnapshotReviews(composition)
    first = reviews.preview(e.db, 1, 'review-failure-key', now=e.now); e.db.commit()
    owner, displayed, now = 1, first['review_digest'], e.now
    if case == 'foreign': owner = 2
    if case == 'digest': displayed = '0' * 64
    if case == 'tamper':
        row = e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC))
        row.payload = {**row.payload, 'review_digest': '0' * 64}; e.db.commit()
    if case == 'new_source':
        journal.acquire(e.db, 1, scope=scope, authorize=composition.authorize, key='changed-source-key', now=e.now)
        e.db.commit()
    if case == 'expired': now += timedelta(hours=49)
    if case in {'disabled', 'policy_version'}:
        from app.domains.modules.models import UserModule, UserModulePreferences
        row = e.db.scalar(select(UserModule).where(UserModule.user_id == 1, UserModule.module_id == 'zerodha_rebalance'))
        if case == 'disabled': row.enabled = False
        else:
            e.db.get(UserModulePreferences, 1).version += 1
            row.version += 1
        e.db.commit()
    if case == 'reconnect':
        from app.domains.connections.models import IntegrationConnection
        from app.uat2.synthetic_connections import connect
        prior = e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 1, IntegrationConnection.is_current.is_(True)))
        connect(e.db, 1, mode='platform_managed', key='review-new-connection', expected_id=prior.id, expected_version=prior.version)
        e.db.commit()
    with pytest.raises(WorkflowDenied): reviews.accept(e.db, owner, first['id'], displayed, now=now)


@pytest.mark.parametrize('path,method,name', [
    ('/uat2/simulation/snapshot-reviews', 'POST', 'preview_snapshot'),
    ('/uat2/simulation/snapshot-reviews/review-id', 'GET', 'read_snapshot_review'),
    ('/uat2/simulation/snapshot-reviews/review-id/accept', 'POST', 'accept_snapshot_review'),
])
def test_native_review_http_routes_keep_authentication(path, method, name, monkeypatch):
    from test_uat2_native_route_order import first
    from app.uat2.main import app
    from fastapi.testclient import TestClient
    monkeypatch.setenv('CREDX_UAT2', '1')
    assert first(path, method)[0].name == name
    # ASGI request composition only. Native lifespan requires dedicated hosted
    # PostgreSQL/Redis and is deliberately not replaced with this SQLite fixture.
    client = TestClient(app, raise_server_exceptions=False)
    try:
        assert client.request(method, path, json={'key': 'review-http-key'} if method == 'POST' else None).status_code == 401
    finally:
        client.close()
    assert app.dependency_overrides == {}


def test_typed_export_includes_owned_review_without_claiming_complete_privacy(linked_env):
    from app.domains.public_service.native_outbox_export import NativeOutboxExport
    from app.domains.ai_limits.contracts import BoundaryDenied
    e = linked_env; scope, composition = setup(e); reviews = SnapshotReviews(composition)
    preview = reviews.preview(e.db, 1, 'review-export-key', now=e.now); e.db.commit()
    row = e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC))
    exporter = NativeOutboxExport(e.db, scope=scope)
    result = exporter.project(row.id, TOPIC, row.payload, 1)
    assert result['kind'] == 'synthetic_snapshot_review'
    assert result['review_digest'] == preview['review_digest']
    with pytest.raises(BoundaryDenied): exporter.project(row.id, TOPIC, row.payload, 2)
    changed = {**row.payload, 'review_digest': '0' * 64}
    with pytest.raises(BoundaryDenied): exporter.project(row.id, TOPIC, changed, 1)


@pytest.mark.asyncio
async def test_installed_review_http_exact_replay_and_foreign_owner(linked_env, monkeypatch):
    """SQLite HTTP composition; identity fixture only, no runtime/DB override."""
    import httpx
    from fastapi import FastAPI
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    import app.infrastructure.database.session as sessions
    from app.domains.auth.dependencies import get_current_user
    from app.domains.auth.models import User
    from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
    from app.uat2.workflow import install_workflow
    from app.domains.modules.transports import install_route_policy
    e = linked_env
    engine = create_async_engine('sqlite+aiosqlite:///' + str(e.path))
    monkeypatch.setattr(sessions, 'AsyncSessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    app = FastAPI(); install_workflow(app, scope=SimulationSourceScope('preview'), source_storage='journal'); install_route_policy(app)
    subject = [1]
    app.dependency_overrides[get_current_user] = lambda: e.db.get(User, subject[0])
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            root = '/uat2/simulation/snapshot-reviews'
            response = await client.post(root, json={'key': 'exact-http-review'})
            assert response.status_code == 200, response.text
            reviewed = response.json(); assert reviewed['state'] == 'preview'
            assert response.headers['cache-control'] == 'private, no-store'
            assert (await client.post(root, json={'key': 'exact-http-review', 'owner_id': 2})).status_code == 422
            target = root + '/' + reviewed['id']
            subject[0] = 2
            assert (await client.get(target)).status_code == 409
            subject[0] = 1
            assert (await client.post(target + '/accept', json={'review_digest': '0' * 64})).status_code == 409
            accepted = await client.post(target + '/accept', json={'review_digest': reviewed['review_digest']})
            assert accepted.status_code == 200, accepted.text
            assert accepted.json()['state'] == 'accepted'
            assert (await client.post(target + '/accept', json={'review_digest': reviewed['review_digest']})).json() == accepted.json()
            assert (await client.get(target)).json() == accepted.json()
            assert app.dependency_overrides.keys() == {get_current_user}
    finally:
        await engine.dispose()


def test_prior_pending_proposal_accepts_exact_old_bytes_without_backfilling_new_study(linked_env):
    from copy import deepcopy
    from app.domains.runs.analysis_workflows.contracts import digest
    e=linked_env;_,composition=setup(e);reviews=SnapshotReviews(composition)
    first=reviews.preview(e.db,1,'old-proposal-study-compat',now=e.now);e.db.commit()
    record=e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC));payload=deepcopy(record.payload)
    # Disposable historical-format fixture, not a live repair or backfill.
    prior=payload['review']['proposed'];prior.pop('price_history')
    prior['content_hash']=digest({key:value for key,value in prior.items() if key!='content_hash'})
    payload['review_digest']=digest(payload['review']);record.payload=payload;e.db.commit()
    before=deepcopy(prior)
    accepted=reviews.accept(e.db,1,first['id'],payload['review_digest'],now=e.now);e.db.commit()
    assert accepted['state']=='accepted'
    stored=e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==journal.TOPIC))
    assert stored.payload['source']==before and 'price_history' not in stored.payload['source']
