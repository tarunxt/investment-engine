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
def test_installed_composition_ui_with_actual_login_and_no_dependency_overrides(order_env,monkeypatch,tmp_path):
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
    engine=create_async_engine('sqlite+aiosqlite:///'+str(e.path))
    monkeypatch.setattr(sessions,'AsyncSessionLocal',async_sessionmaker(engine,expire_on_commit=False))
    app=FastAPI();
    from app.domains.public_service.router import router as public_service
    for router in (auth,modules,connections,public_service):app.include_router(router)
    install_workflow(app,scope=analysis.scope,source_storage=analysis.analysis.source_storage)
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
    node=os.environ['LOCAL_NATIVE_NODE'];sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
    log=open('/tmp/credx-local-native-frontend.log','w')
    frontend=None
    try:
        deadline=time.monotonic()+15
        while not server.started and time.monotonic()<deadline:time.sleep(.05)
        assert server.started
        env={**os.environ,'NEXT_DIST_DIR':os.environ['LOCAL_NATIVE_NEXT_DIR'],'NEXTAUTH_URL':f'http://localhost:{frontend_port}',
            'AUTH_URL':f'http://localhost:{frontend_port}','NEXTAUTH_SECRET':'local-native-synthetic-only','AUTH_SECRET':'local-native-synthetic-only',
            'AUTH_TRUST_HOST':'true','NEXT_PUBLIC_UAT2':'true','NEXT_PUBLIC_UAT2_COMMIT':sha,'BACKEND_API_URL':f'http://127.0.0.1:{backend_port}','API_URL':f'http://127.0.0.1:{backend_port}',
            'LOCAL_NATIVE_BROWSER_URL':f'http://localhost:{frontend_port}','LOCAL_NATIVE_BROWSER_SHA':sha,
            'LOCAL_NATIVE_BROWSER_EVIDENCE':'/tmp/credx-local-native-browser'}
        frontend=subprocess.Popen([node,'node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',str(frontend_port)],cwd=root/'frontend',env=env,stdout=log,stderr=log)
        time.sleep(3)
        subprocess.run([node,'scripts/local-native-composition-browser.mjs'],cwd=root/'frontend',env=env,check=True,timeout=180)
        receipt=json.loads(Path('/tmp/credx-local-native-browser/receipt.json').read_text())
        assert receipt['passed'] and receipt['source_sha']==sha
    finally:
        stop.set();runner.join(timeout=5);server.should_exit=True;server_thread.join(timeout=10)
        if frontend is not None:
            frontend.terminate()
            try:frontend.wait(timeout=10)
            except subprocess.TimeoutExpired:frontend.kill();frontend.wait(timeout=5)
        Path('/tmp/credx-local-native-worker-errors.json').write_text(json.dumps(list(errors)))
        log.close()
        asyncio.run(engine.dispose())
