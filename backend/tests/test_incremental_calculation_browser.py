"""Opt-in loopback UI qualification of installed composition; SQLite/fake delivery.

No auth/runtime dependency overrides. Native hosted startup remains unchanged.
No preview routes are mounted. This fixture is not hosted/native-main acceptance.
"""
import os,time,threading,subprocess,json,asyncio
from collections import deque
from pathlib import Path
from datetime import datetime,timezone
import pytest
from fastapi import FastAPI,APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from test_hosted_order_composition import order_env,worker_env,linked_env

pytestmark=pytest.mark.skipif(os.getenv('CREDX_LOCAL_NATIVE_BROWSER')!='disposable-loopback-only',reason='Explicit disposable local browser runtime required')


@pytest.mark.parametrize('worker_env',['journal'],indirect=True)
def test_incremental_calculation_with_actual_owned_history_and_login(order_env,monkeypatch,tmp_path):
    import uvicorn
    import app.infrastructure.database.session as sessions
    from app.domains.auth.router import router as auth
    from app.domains.modules.router import router as modules
    from app.domains.connections.router import router as connections
    from app.domains.auth.models import User,UserProfile,ActivityLog,UserSession,APIKey
    from app.core.security import PasswordUtils
    from app.domains.modules.transports import install_route_policy
    from app.shared.exceptions import AppException
    from app.uat2.workflow import install_workflow
    e,analysis,worker,factory,celery,deliveries,clock,flow,intent=order_env
    root=Path(__file__).resolve().parents[2]
    monkeypatch.setenv('CREDX_UAT2','0')
    monkeypatch.setenv('JWT_SIGNING_KEY','local-native-browser-synthetic-'+('x'*40))
    from app.infrastructure.database.base import Base
    Base.metadata.create_all(e.engine)
    for subject in (1,2):e.db.get(User,subject).password_hash=PasswordUtils.hash_password('SyntheticPreview123!')
    e.db.commit()
    # Persisted synthetic source records only; no analysis, provider or order submission.
    from app.domains.runs.models import Run,RunJob,AutoRebalanceWorkflow
    from app.domains.jobs.models import Job
    from app.shared.types import JobStatus
    for subject in (1,2):
        for portfolio,module,market,exchange in (('india','zerodha_rebalance','India','NSE'),('indmoney_us','indmoney_us','IndMoney US','NASDAQ')):
            e.db.add(AutoRebalanceWorkflow(user_id=subject,module_id=module,module_version=1,portfolio=portfolio,sequence=97,label=f'{market} saved synthetic sequence',status='completed',current_stage='rebalance'))
            prompt=f'Synthetic {market} rebalance scan, persisted fixture only'
            run=Run(user_id=subject,module_id=module,module_version=1,prompt=prompt,prompt_preview=prompt,status=JobStatus.COMPLETED,auto_export_enabled=False,auto_rebalance_portfolio=portfolio,auto_rebalance_sequence=97,auto_rebalance_label=f'{market} Run #97 (Rebalance Scan)')
            e.db.add(run);e.db.flush()
            for index in range(2):
                job=Job(user_id=subject,module_id=module,module_version=1,provider='fake',model=f'saved-offline-{index}',status=JobStatus.COMPLETED,prompt=prompt,auto_rebalance_portfolio=portfolio,auto_rebalance_sequence=97,response=json.dumps({'stocks':[{'Exchange Symbol':exchange,'Stock Symbol':'ALPHA' if subject==1 else 'FOREIGN_ONLY','Current Units':0,'Final Units':0,'Action (Buy/Add/Sell All/Trim/Hold/Buy New)':'Hold','Rationale Cruxx':'Synthetic saved fixture','Score Rationale Cruxx':0,'Confidence Score (0-100)':0}]}))
                e.db.add(job);e.db.flush();e.db.add(RunJob(run_id=run.id,job_id=job.id,stage=1))
    e.db.commit()
    engine=create_async_engine('sqlite+aiosqlite:///'+str(e.path))
    monkeypatch.setattr(sessions,'AsyncSessionLocal',async_sessionmaker(engine,expire_on_commit=False))
    app=FastAPI();
    from app.domains.public_service.router import router as public_service
    for router in (auth,modules,connections,public_service):app.include_router(router)
    install_workflow(app,scope=analysis.scope,source_storage=analysis.analysis.source_storage)
    # Same read-only route subset and static-before-dynamic order as installed UAT2.
    from app.domains.runs.router import router as native_runs
    for route in native_runs.routes:
        if route.methods=={'GET'} and route.path in {'/runs/auto-rebalance-history','/runs/auto-rebalance-history/{portfolio}/{sequence}','/runs/{run_id}'}:
            app.include_router(APIRouter(routes=[route]))
    install_route_policy(app)
    @app.exception_handler(AppException)
    async def failure(request,error):return JSONResponse(status_code=error.status_code,content={'detail':error.message})
    assert app.dependency_overrides=={}
    assert not any(getattr(route.endpoint,'__module__','').startswith('scripts.public_launch') for route in app.routes)
    # Delivery is an explicit in-memory test transport; durable workers are actual.
    for kind,task in worker.tasks.items():
        monkeypatch.setattr(task,'apply_async',lambda *,args,queue,retry,_kind=kind:deliveries.append((_kind,args)))
    stop=threading.Event();errors=deque(maxlen=50)
    def tick():
        while not stop.wait(.25):
            clock[0]=datetime.now(timezone.utc)
            try:
                analysis.relay();worker.relay()
                batch=list(deliveries);deliveries.clear()
                for kind,args in batch:
                    try:
                        task=(analysis.tasks|worker.tasks)[kind];task.run(*args)
                    except Exception as error:
                        errors.append(type(error).__name__)
            except Exception as error:
                errors.append(type(error).__name__)
    backend_port=int(os.environ['LOCAL_NATIVE_BACKEND_PORT']);frontend_port=int(os.environ['LOCAL_NATIVE_FRONTEND_PORT'])
    server=uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=backend_port,log_level='warning'))
    server_thread=threading.Thread(target=server.run,daemon=True);server_thread.start()
    runner=threading.Thread(target=tick,daemon=True);runner.start()
    node=os.environ['LOCAL_NATIVE_NODE'];frame_only=True
    sha=json.loads((root/'source.json').read_text())['sha'] if frame_only else subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
    if frame_only:
        from scripts.public_launch.concept_f_build_receipt import verified_build
        before_binding=verified_build(root/'frontend'/os.environ['LOCAL_NATIVE_NEXT_DIR'],root/'backend/app')
        assert before_binding['source_sha']==sha
    evidence=os.getenv('LOCAL_NATIVE_BROWSER_EVIDENCE','/tmp/credx-incremental-f52-native-browser')
    log=open('/tmp/credx-incremental-f52-frontend.log' if frame_only else '/tmp/credx-local-native-frontend.log','w')
    frontend=None
    try:
        deadline=time.monotonic()+15
        while not server.started and time.monotonic()<deadline:time.sleep(.05)
        assert server.started
        env={**os.environ,'NEXT_DIST_DIR':os.environ['LOCAL_NATIVE_NEXT_DIR'],'NEXTAUTH_URL':f'http://localhost:{frontend_port}',
            'AUTH_URL':f'http://localhost:{frontend_port}','NEXTAUTH_SECRET':'local-native-synthetic-only','AUTH_SECRET':'local-native-synthetic-only',
            'AUTH_TRUST_HOST':'true','NEXT_PUBLIC_UAT2':'true','NEXT_PUBLIC_UAT2_COMMIT':sha,'BACKEND_API_URL':f'http://127.0.0.1:{backend_port}','API_URL':f'http://127.0.0.1:{backend_port}',
            'LOCAL_NATIVE_BROWSER_URL':f'http://localhost:{frontend_port}','LOCAL_NATIVE_BROWSER_SHA':sha,'LOCAL_NATIVE_BROWSER_HARNESS_SHA':os.environ.get('LOCAL_NATIVE_BROWSER_HARNESS_SHA',sha),
            'LOCAL_NATIVE_BROWSER_EVIDENCE':evidence}
        frontend=subprocess.Popen([node,'node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',str(frontend_port)],cwd=root/'frontend',env=env,stdout=log,stderr=log)
        time.sleep(3)
        script='scripts/incremental-calculation-browser.mjs'
        if os.getenv('LOCAL_NATIVE_F53_BROWSER'):
            assert os.getenv('LOCAL_NATIVE_F53_BROWSER')=='read-only-reference-ui'
            script='scripts/incremental-formula-browser.mjs'
        subprocess.run([node,script],cwd=root/'frontend',env=env,check=True,timeout=180)
        receipt=json.loads((Path(evidence)/'receipt.json').read_text())
        assert receipt['passed'] and receipt['source_sha']==sha
        if frame_only:
            after_binding=verified_build(root/'frontend'/os.environ['LOCAL_NATIVE_NEXT_DIR'],root/'backend/app')
            assert all(after_binding.get(key)==before_binding.get(key) for key in ('source_sha','build_id','asset_tree_sha256','backend_source_tree_sha256'))
            receipt.update(source_binding_verified=True,build_binding=after_binding)
            (Path(evidence)/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    finally:
        stop.set();runner.join(timeout=5);server.should_exit=True;server_thread.join(timeout=10)
        if frontend is not None:
            frontend.terminate()
            try:frontend.wait(timeout=10)
            except subprocess.TimeoutExpired:frontend.kill();frontend.wait(timeout=5)
        Path('/tmp/credx-incremental-f52-worker-errors.json' if frame_only else '/tmp/credx-local-native-worker-errors.json').write_text(json.dumps(list(errors)))
        log.close()
        asyncio.run(engine.dispose())
