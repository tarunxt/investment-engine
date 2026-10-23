"""Native application dependencies and persisted fake execution, disposable SQL."""
from datetime import timedelta
from uuid import uuid5
import pytest
import httpx
from fastapi import FastAPI
from sqlalchemy import create_engine, select, func, update
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from test_hosted_analysis_worker import worker_env, linked_env, test_worker_relay_complete_six_stages_and_five_governed_jobs_without_global_runtime as complete
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.order_intents.models import OrderIntent, OrderLeg
from app.domains.order_intents.execution_models import ExecutionFence, ExecutionRun, ExecutionAttempt
from app.domains.order_intents.contracts import OrderDenied
from app.domains.order_intents.service import TOPIC, orders_for_runtime
from app.domains.order_intents.router import router
from app.domains.modules.models import UserModule
from app.infrastructure.database.outbox.models import OutboxMessage
from app.uat2.http_bindings import SimulationHTTPBinding
from app.uat2.order_worker import SimulationOrderWorker, PREPARE, DISPATCH, RECONCILE, RELAY
from app.uat2.synthetic_orders import NAMESPACE


@pytest.fixture
def order_env(worker_env, request, monkeypatch):
    e, analysis, factory, app, deliveries, clock, flow_id = worker_env
    complete(worker_env)
    for model in (OrderIntent, OrderLeg, ExecutionFence, ExecutionRun, ExecutionAttempt):
        model.__table__.create(e.engine, checkfirst=True)
    venue = create_engine('sqlite:///' + str(e.path.parent / 'fake-venue.sqlite'))
    OutboxMessage.__table__.create(venue)
    scenario=request.getfixturevalue('outcome') if 'outcome' in request.fixturenames else 'filled'
    monkeypatch.setenv('UAT2_SIMULATION_SCENARIO',scenario)
    worker = SimulationOrderWorker(analysis, venue)
    worker.register(app); worker.schedule(app)
    intent = worker.prepare(flow_id)['id']
    yield e, analysis, worker, factory, app, deliveries, clock, flow_id, intent
    venue.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize('outcome', ['filled', 'partial', 'after_acceptance', 'before_acceptance'])
async def test_native_approval_dispatch_and_restart_without_runtime_overrides(order_env, monkeypatch, outcome):
    import app.infrastructure.database.session as session_module
    e, analysis, worker, factory, celery, deliveries, clock, flow_id, intent = order_env
    engine = create_async_engine('sqlite+aiosqlite:///' + str(e.path))
    monkeypatch.setattr(session_module, 'AsyncSessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    app = FastAPI(); app.include_router(router)
    from app.domains.modules.transports import install_route_policy
    install_route_policy(app)
    binding = SimulationHTTPBinding(scope=analysis.scope, source_storage=analysis.analysis.source_storage).install(app)
    owner = [1]
    app.dependency_overrides[get_current_user] = lambda: e.db.get(User, owner[0])
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            record = (await client.get('/order-intents/reviews/' + intent)).json()['intents'][0]
            assert record['actions']['confirm'] and record['state'] == 'awaiting_approval'
            with factory() as db:
                assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic == TOPIC)) == 0
            owner[0] = 2
            assert (await client.get('/order-intents/reviews/' + intent)).status_code == 404
            assert (await client.post('/order-intents/' + intent + '/approve', json={
                'displayed_digest': record['review_digest'], 'action': 'confirm_exact_order_or_basket'})).status_code == 409
            owner[0] = 1
            assert (await client.post('/order-intents/' + intent + '/approve', json={
                'displayed_digest': '0'*64, 'action': 'confirm_exact_order_or_basket'})).status_code == 409
            response = await client.post('/order-intents/' + intent + '/approve', json={
                'displayed_digest': record['review_digest'], 'action': 'confirm_exact_order_or_basket'})
            assert response.status_code == 200
            assert (await client.post('/order-intents/' + intent + '/approve', json={
                'displayed_digest': record['review_digest'], 'action': 'confirm_exact_order_or_basket'})).status_code == 409
        with factory() as db: event = db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC)).id
        clock[0] += timedelta(seconds=1)
        result = worker.dispatch(event)
        assert result['state'] == {'after_acceptance': 'unknown', 'before_acceptance': 'unknown'}.get(outcome, outcome)
        restarted = SimulationOrderWorker(analysis, worker.venue_engine)
        if outcome != 'filled':
            clock[0] += timedelta(seconds=6)
            result = restarted.reconcile(intent)
            assert result['state'] == {'after_acceptance': 'filled', 'before_acceptance': 'unknown'}.get(outcome, outcome)
        with pytest.raises(OrderDenied): restarted.dispatch(event)
        with factory() as db:
            assert len(list(db.scalars(select(ExecutionAttempt)))) == 1
            assert db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC)).execution_attempts == 1
        assert set(app.dependency_overrides) == {get_current_user}
    finally: await engine.dispose()


@pytest.mark.parametrize('change', ['receipt', 'analysis', 'disable'])
def test_changed_provenance_or_current_policy_cannot_confirm_or_dispatch(order_env, change):
    e, analysis, worker, factory, app, deliveries, clock, flow_id, intent = order_env
    with factory() as db:
        if change == 'receipt':
            row = db.get(OutboxMessage, uuid5(NAMESPACE, intent)); row.payload = {**row.payload, 'request_digest': '0'*64}
        elif change == 'analysis':
            from app.domains.runs.models import AutoRebalanceWorkflow
            db.execute(update(AutoRebalanceWorkflow).where(AutoRebalanceWorkflow.id == flow_id).values(execution_json={}))
        else:
            db.scalar(select(UserModule).where(UserModule.user_id == 1, UserModule.module_id == 'zerodha_rebalance')).enabled = False
        db.commit()
    with analysis.session() as db:
        with pytest.raises((OrderDenied, PermissionError)):
            orders_for_runtime(db, worker.orders).checked(1, intent, clock[0])
    with worker.venue_engine.connect() as connection:
        assert connection.scalar(select(func.count()).select_from(OutboxMessage)) == 0


def test_relay_is_bounded_and_never_creates_approval(order_env, monkeypatch):
    e, analysis, worker, factory, app, deliveries, clock, flow_id, intent = order_env
    posted = []
    for name, task in worker.tasks.items():
        monkeypatch.setattr(task, 'apply_async', lambda *, args, queue, retry, kind=name: posted.append((kind, args)))
    assert set(worker.tasks) == {PREPARE, DISPATCH, RECONCILE, RELAY}
    assert worker.relay() == {'simulation_only': True, 'prepare': 0, 'dispatch': 0, 'reconcile': 0}
    assert not posted
    with factory() as db:
        row = db.get(OrderIntent, intent)
        assert row.state == 'awaiting_approval' and row.approval_digest is None
    assert len(app.conf.beat_schedule) == 1


def test_dedicated_worker_bootstrap_registers_only_bounded_simulation_tasks():
    import json, os, subprocess, sys
    env = {key: value for key, value in os.environ.items() if key in {'PATH', 'PYTHONPATH', 'SYSTEMROOT'}}
    env.update(CREDX_UAT2='1', ENVIRONMENT='uat2', AUTH_DISABLED='false', DEBUG='false',
        GOOGLE_SIGNIN_CLIENT_ID='unit-test-independent-client',
        UAT2_JWT_SIGNING_KEY='unit-test-only-signing-material-not-a-deployed-secret',
        UAT2_ADAPTERS='simulation', UAT2_SOURCE_COMMIT='a'*40,
        DATABASE_URL='postgresql://credx_uat2@postgres:5432/credx_uat2',
        REDIS_URL='redis://redis:6379/0', FRONTEND_URL='https://uat2.example.invalid')
    source = """
import json
from app.uat2.worker import celery, venue_engine
from sqlalchemy.orm import configure_mappers
configure_mappers()
names=sorted(name for name in celery.tasks if not name.startswith('celery.'))
print(json.dumps({'tasks':names,'schedules':sorted(celery.conf.beat_schedule),'queue':celery.conf.task_default_queue}))
venue_engine.dispose()
"""
    result = subprocess.run([sys.executable, '-c', source], env=env, capture_output=True, text=True, timeout=25)
    assert result.returncode == 0, result.stderr
    value = json.loads(result.stdout.strip().splitlines()[-1])
    assert value['tasks'] == sorted(['uat2.fake_ai', 'uat2.analysis.stage.v1', 'uat2.analysis.job.v1',
        'uat2.analysis.relay.v1', 'uat2.operations.observe.v1', PREPARE, DISPATCH, RECONCILE, RELAY])
    assert value['schedules'] == ['uat2-scoped-analysis-relay', 'uat2-scoped-operational-observation', 'uat2-scoped-orders-relay']
    assert value['queue'] == 'uat2_simulation'


@pytest.mark.asyncio
@pytest.mark.parametrize('worker_env', ['journal'], indirect=True)
async def test_installed_controls_both_modes_and_digest_accepted_us_import(order_env, monkeypatch):
    import app.infrastructure.database.session as session_module
    from fastapi.responses import JSONResponse
    from app.shared.exceptions import AppException
    from app.uat2.workflow import install_workflow
    from app.domains.modules.transports import install_route_policy
    from app.domains.runs.models import AutoRebalanceWorkflow
    from app.uat2.analysis_worker import STAGE, JOB
    e, analysis, worker, factory, celery, deliveries, clock, flow_id, intent = order_env
    engine = create_async_engine('sqlite+aiosqlite:///' + str(e.path))
    monkeypatch.setattr(session_module, 'AsyncSessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    app = FastAPI(); install_workflow(app, scope=analysis.scope, source_storage='journal'); install_route_policy(app)
    @app.exception_handler(AppException)
    async def failure(request, error): return JSONResponse(status_code=error.status_code,content={'detail':error.message})
    owner = [1]
    app.dependency_overrides[get_current_user] = lambda: e.db.get(User, owner[0])
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            # The completed source started in user-owned mode. Switching to the
            # other real supported fake mode requires a new explicit acquisition.
            with factory() as db:
                from app.domains.connections.models import IntegrationConnection
                prior = db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 1,
                    IntegrationConnection.is_current.is_(True)))
                current_id, version = prior.id, prior.version
            body = {'mode':'platform_managed','key':'http-reconnect-key','expected_id':current_id,'expected_version':version}
            assert (await client.post('/uat2/simulation/connections',json={**body,'owner_id':2})).status_code == 422
            connected = await client.post('/uat2/simulation/connections',json=body)
            assert connected.status_code == 200 and connected.json()['simulation_only'] is True
            assert connected.json()['credential_storage'] == 'none'
            assert (await client.post('/runs/analysis-workflows',json={'portfolio':'india','key':'before-acquire-key'})).status_code == 403
            source = await client.post('/runs/analysis-workflows/synthetic-source',json={'portfolio':'india','key':'http-second-source'})
            assert source.status_code == 200 and source.json()['source_receipt_id']
            started = await client.post('/runs/analysis-workflows',json={'portfolio':'india','key':'http-second-workflow'})
            assert started.status_code == 200
            india_id = started.json()['id']
            template = (await client.get('/indmoney-us/imports/template')).text
            preview = await client.post('/indmoney-us/imports/preview',json={'format':'csv','raw_text':template,'captured_at':e.now.isoformat()})
            assert preview.status_code == 200
            snapshot = preview.json(); snapshot_id = snapshot['id']
            assert (await client.post('/runs/analysis-workflows',json={'portfolio':'indmoney_us','key':'unaccepted-us-workflow'})).status_code == 403
            owner[0] = 2
            assert (await client.post(f'/indmoney-us/imports/{snapshot_id}/accept',json={'content_hash':snapshot['content_hash'],'accept':True})).status_code == 404
            owner[0] = 1
            assert (await client.post(f'/indmoney-us/imports/{snapshot_id}/accept',json={'content_hash':'0'*64,'accept':True})).status_code == 409
            accepted = await client.post(f'/indmoney-us/imports/{snapshot_id}/accept',json={'content_hash':snapshot['content_hash'],'accept':True})
            assert accepted.status_code == 200
            us = await client.post('/runs/analysis-workflows',json={'portfolio':'indmoney_us','key':'accepted-us-workflow'})
            assert us.status_code == 200
            us_id = us.json()['id']
        for _ in range(60):
            analysis.relay(); batch=list(deliveries); deliveries.clear()
            for kind,args in batch:
                if kind == STAGE: analysis.stage(*args)
                elif kind == JOB: analysis.job(*args)
            with factory() as db:
                if all(db.get(AutoRebalanceWorkflow,identifier).status == 'completed' for identifier in (india_id,us_id)): break
            clock[0] += timedelta(seconds=6)
        with factory() as db:
            assert all(db.get(AutoRebalanceWorkflow,identifier).status == 'completed' for identifier in (india_id,us_id))
            assert not list(db.scalars(select(OutboxMessage).where(OutboxMessage.topic == TOPIC)))
        assert set(app.dependency_overrides) == {get_current_user}
    finally: await engine.dispose()


@pytest.mark.asyncio
async def test_private_completed_analysis_export_uses_native_owner_binding_and_no_destination(order_env, monkeypatch):
    import app.infrastructure.database.session as session_module
    from app.uat2.workflow import install_workflow
    from app.domains.modules.transports import install_route_policy
    from app.domains.ai_limits.private_effects import TOPIC as EXPORT_TOPIC
    e, analysis, worker, factory, celery, deliveries, clock, flow_id, intent = order_env
    engine = create_async_engine('sqlite+aiosqlite:///' + str(e.path))
    monkeypatch.setattr(session_module, 'AsyncSessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    app=FastAPI();install_workflow(app,scope=analysis.scope,source_storage=analysis.analysis.source_storage);install_route_policy(app)
    owner=[1];app.dependency_overrides[get_current_user]=lambda:e.db.get(User,owner[0])
    path=f'/uat2/simulation/analysis/{flow_id}/private-export'
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            assert (await client.post(path,json={'key':'private-export-key','destination':'https://outside.invalid'})).status_code == 422
            first=await client.post(path,json={'key':'private-export-key'})
            assert first.status_code == 200
            receipt=first.json();assert receipt['external_delivery'] is False and receipt['complete_account_export'] is False
            assert (await client.post(path,json={'key':'private-export-key'})).json()==receipt
            content=await client.get(receipt['download_path'])
            assert content.status_code == 200 and content.json()['owner_id']==1
            assert content.json()['orders_authorized'] is False and content.json()['workflow_id']==flow_id
            assert 'prompt' not in content.json() and 'source' not in content.json()
            assert content.headers['cache-control']=='no-store' and 'attachment' in content.headers['content-disposition']
            owner[0]=2
            assert (await client.get(receipt['download_path'])).status_code==404
            owner[0]=1
            with factory() as db:
                assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==EXPORT_TOPIC))==1
                db.scalar(select(UserModule).where(UserModule.user_id==1,UserModule.module_id=='zerodha_rebalance')).enabled=False;db.commit()
            assert (await client.get(receipt['download_path'])).status_code==404
        assert set(app.dependency_overrides)=={get_current_user}
    finally:await engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize('worker_env',['journal'],indirect=True)
async def test_native_diagnostics_bind_journal_source_and_keep_external_alerts_disabled(order_env,monkeypatch):
    import app.infrastructure.database.session as session_module
    from app.domains.public_service.router import router as operations_router
    from app.domains.public_service.monitoring import TOPIC as MONITOR_TOPIC
    e,analysis,worker,factory,celery,deliveries,clock,flow_id,intent=order_env
    with factory() as db:
        db.scalar(select(UserModule).where(UserModule.user_id==1,UserModule.module_id=='indmoney_us')).enabled=False
        db.commit()
    engine=create_async_engine('sqlite+aiosqlite:///'+str(e.path))
    monkeypatch.setattr(session_module,'AsyncSessionLocal',async_sessionmaker(engine,expire_on_commit=False))
    app=FastAPI();app.include_router(operations_router)
    binding=SimulationHTTPBinding(scope=analysis.scope,source_storage='journal').install(app)
    app.dependency_overrides[get_current_user]=lambda:e.db.get(User,1)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            result=await client.get('/account/operations/diagnostics')
            assert result.status_code==200
            report=result.json()
            assert report['owner_id']==1 and report['external_delivery'] is False
            assert report['source_unavailable'] is False and report['stale_data'] is False
            assert len(report['provenance']['source_versions']['zerodha_rebalance'])==64
            assert result.headers['cache-control']=='private, no-store'
        with analysis.session() as db:
            first=binding.operations.observe(db,1)
            second=binding.operations.observe(db,1)
            assert first==second and first['external_delivery'] is False and first['state']=='recorded'
            assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==MONITOR_TOPIC))==1
            assert db.scalar(select(OutboxMessage).where(OutboxMessage.topic==MONITOR_TOPIC)).execution_attempts==1
    finally:await engine.dispose()


def test_scheduled_observation_reads_only_scope_owners_and_never_submits_or_sends(order_env):
    from app.uat2.analysis_worker import OBSERVE,CONTROL_QUEUE
    from app.domains.public_service.monitoring import TOPIC as MONITOR_TOPIC
    e,analysis,worker,factory,celery,deliveries,clock,flow_id,intent=order_env
    analysis.schedule(celery)
    assert celery.conf.beat_schedule['uat2-scoped-operational-observation']['options']=={'queue':CONTROL_QUEUE,'expires':30}
    result=analysis.tasks[OBSERVE].run()
    assert {item['owner_id'] for item in result['items']}=={1,2}
    assert all(item['external_delivery'] is False for item in result['items'])
    with factory() as db:
        assert db.get(OrderIntent,intent).state=='awaiting_approval'
        assert not list(db.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC)))
        rows=list(db.scalars(select(OutboxMessage).where(OutboxMessage.topic==MONITOR_TOPIC)))
        assert {row.payload['owner_id'] for row in rows}=={1,2}
        assert all(row.payload['synthetic_sink'] is True and row.payload['provenance']['binding']=='uat2-native-source-observation-v1' for row in rows)
