"""Actual-auth read-only governed browser fixture, real durable fake services, SQLite only."""
import os,time,threading,subprocess,json,asyncio,hashlib
from pathlib import Path
from datetime import datetime,timezone
from contextvars import ContextVar
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import select,event,func
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from test_stage18_linked_analysis_preview import linked_env,complete_analysis,current_source

pytestmark=pytest.mark.skipif(os.getenv('CREDX_LOCAL_NATIVE_BROWSER')!='disposable-loopback-only',reason='Explicit synthetic loopback browser required')

def test_governed_zero_run_actual_auth_and_no_effects(linked_env,monkeypatch,tmp_path):
    import uvicorn
    import app.infrastructure.database.session as sessions
    from app.infrastructure.database.base import Base
    from app.domains.auth.models import User,UserProfile,ActivityLog,UserSession,APIKey
    from app.domains.auth.router import router as auth
    from app.domains.modules.router import router as modules
    from app.domains.connections.router import router as connections
    from app.domains.public_service.router import router as public_service
    from app.domains.runs.models import Run,RunJob,AutoRebalanceWorkflow,AutoRebalanceWorkflowStage
    from app.domains.jobs.models import Job
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.domains.modules.models import UserModule,UserModulePreferences
    from app.domains.recommendation_audit.models import SpendAccount,SpendAttempt
    from app.domains.runs.analysis_workflows.service import Workflows
    from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
    from app.domains.modules.transports import install_route_policy
    from app.core.security import PasswordUtils
    from app.shared.exceptions import AppException
    from app.uat2.workflow import install_workflow
    e=linked_env;root=Path(__file__).resolve().parents[2]
    monkeypatch.setenv('CREDX_UAT2','0');monkeypatch.setenv('JWT_SIGNING_KEY','governed-local-synthetic-'+('x'*40))
    Base.metadata.create_all(e.engine)
    for owner in (1,2):
        for portfolio in ('india','indmoney_us'):
            e.now=datetime.now(timezone.utc)
            complete_analysis(e,owner,portfolio,key=f'governed-browser-{owner}-{portfolio}')
        e.db.get(User,owner).password_hash=PasswordUtils.hash_password('SyntheticPreview123!')
    e.now=datetime.now(timezone.utc)
    snapshot=current_source(e,1,'india');Workflows(e.db,e.runtime).create(1,'india','governed-pending-history',snapshot_id=snapshot,now=e.now);e.db.commit()
    assert e.db.scalar(select(func.count()).select_from(Run))==0 and e.db.scalar(select(func.count()).select_from(RunJob))==0
    e.db.commit()
    models=(Run,RunJob,AutoRebalanceWorkflow,AutoRebalanceWorkflowStage,Job,OutboxMessage,UserModule,UserModulePreferences,SpendAccount,SpendAttempt)
    def fingerprint():
        with e.engine.connect() as c:
            data={m.__tablename__:[dict(row) for row in c.execute(select(m.__table__).order_by(*m.__table__.primary_key.columns)).mappings()] for m in models}
        return hashlib.sha256(json.dumps(data,sort_keys=True,default=str).encode()).hexdigest()
    before=fingerprint();engine=create_async_engine('sqlite+aiosqlite:///'+str(e.path))
    monkeypatch.setattr(sessions,'AsyncSessionLocal',async_sessionmaker(engine,expire_on_commit=False))
    app=FastAPI()
    for router in (auth,modules,connections,public_service):app.include_router(router)
    install_workflow(app,scope=SimulationSourceScope('preview'));install_route_policy(app)
    assert app.dependency_overrides=={}
    @app.exception_handler(AppException)
    async def failure(request,error):return JSONResponse(status_code=error.status_code,content={'detail':error.message})
    reading=ContextVar('projection-read',default=False);queries=[]
    @app.middleware('http')
    async def read_scope(request,call_next):
        token=reading.set(request.url.path.endswith('/calculation-inputs'))
        try:return await call_next(request)
        finally:reading.reset(token)
    def record(conn,cursor,statement,parameters,context,many):
        if reading.get():queries.append(statement)
    event.listen(engine.sync_engine,'before_cursor_execute',record)
    from scripts.public_launch.concept_f_build_receipt import verified_build
    binding=verified_build(root/'frontend'/os.environ['LOCAL_NATIVE_NEXT_DIR'],root/'backend/app');sha=json.loads((root/'source.json').read_text())['sha'];assert binding['source_sha']==sha
    node=os.environ['LOCAL_NATIVE_NODE'];backend_port=int(os.environ['LOCAL_NATIVE_BACKEND_PORT']);frontend_port=int(os.environ['LOCAL_NATIVE_FRONTEND_PORT']);evidence=os.environ['LOCAL_NATIVE_BROWSER_EVIDENCE']
    server=uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=backend_port,log_level='warning'));thread=threading.Thread(target=server.run,daemon=True);thread.start();frontend=None
    log=open(evidence+'-frontend.log','w')
    try:
        deadline=time.monotonic()+15
        while not server.started and time.monotonic()<deadline:time.sleep(.05)
        assert server.started
        env={**os.environ,'NEXT_DIST_DIR':os.environ['LOCAL_NATIVE_NEXT_DIR'],'NEXTAUTH_URL':f'http://localhost:{frontend_port}','AUTH_URL':f'http://localhost:{frontend_port}','NEXTAUTH_SECRET':'local-native-synthetic-only','AUTH_SECRET':'local-native-synthetic-only','AUTH_TRUST_HOST':'true','NEXT_PUBLIC_UAT2':'true','NEXT_PUBLIC_UAT2_COMMIT':sha,'BACKEND_API_URL':f'http://127.0.0.1:{backend_port}','API_URL':f'http://127.0.0.1:{backend_port}','LOCAL_NATIVE_BROWSER_URL':f'http://localhost:{frontend_port}','LOCAL_NATIVE_BROWSER_SHA':sha}
        frontend=subprocess.Popen([node,'node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',str(frontend_port)],cwd=root/'frontend',env=env,stdout=log,stderr=log);time.sleep(3)
        subprocess.run([node,'scripts/governed-calculation-browser.mjs'],cwd=root/'frontend',env=env,check=True,timeout=180)
        receipt=json.loads((Path(evidence)/'receipt.json').read_text());assert receipt['passed'] and receipt['source_sha']==sha
        assert fingerprint()==before
        assert queries and all(q.lstrip().upper().startswith('SELECT') and 'FOR UPDATE' not in q.upper() for q in queries)
        after=verified_build(root/'frontend'/os.environ['LOCAL_NATIVE_NEXT_DIR'],root/'backend/app');assert all(binding[k]==after[k] for k in ('source_sha','build_id','asset_tree_sha256','backend_source_tree_sha256'))
        receipt.update(harness_sha=os.environ.get('LOCAL_NATIVE_BROWSER_HARNESS_SHA',sha),source_binding_verified=True,business_store_fingerprint_unchanged=True,projection_select_only=True,legacy_run_count=0,sqlite=True,postgresql=False,redis=False,hosted=False)
        (Path(evidence)/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    finally:
        server.should_exit=True;thread.join(timeout=10)
        if frontend is not None:
            frontend.terminate()
            try:frontend.wait(timeout=10)
            except subprocess.TimeoutExpired:frontend.kill();frontend.wait(timeout=5)
        log.close();event.remove(engine.sync_engine,'before_cursor_execute',record);asyncio.run(engine.dispose())
