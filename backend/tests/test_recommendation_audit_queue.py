"""Real JWT + Celery delivery with disposable SQLite and an in-memory broker.

No application default DB/broker, credentials or external collector is used.
This exercises the queue path but does not replace PostgreSQL/Redis gates.
"""
import asyncio
import os
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

from celery import Celery, _state
from celery.contrib.testing.worker import start_worker
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import JWTUtils
from app.domains.auth.models import User, UserProfile, UserRole
from app.domains.recommendation_audit.models import DecisionRecord, EvidenceRecord, SpendAccount, SpendAttempt, VerificationRecord
from app.domains.recommendation_audit.router import router
from app.domains.recommendation_audit.service import create_verification
from app.domains.recommendation_audit.worker import claim_lease, run_verification
from app.domains.runs.models import Run
from app.infrastructure.database.base import Base
from app.infrastructure.database.session import get_async_db
from test_recommendation_audit import decision, request


@pytest.mark.asyncio
@pytest.mark.parametrize("broker",["memory",pytest.param("redis",marks=pytest.mark.skipif(not os.getenv("CREDX_AUDIT_TEST_REDIS_URL") or os.getenv("CREDX_AUDIT_TEST_REDIS_ACK")!="disposable-local-only",reason="Disposable Redis fixture not provided"))])
async def test_authenticated_api_delivers_to_isolated_celery_worker(tmp_path, monkeypatch, broker):
    import app.models
    import app.core.security as security_module
    from app.domains.recommendation_audit.tasks import verify_reversal
    database=tmp_path/"audit-auth-queue.sqlite"
    engine=create_engine(f"sqlite:///{database}",connect_args={"check_same_thread":False})
    Base.metadata.create_all(engine,tables=[m.__table__ for m in (User,UserProfile,Run,EvidenceRecord,DecisionRecord,VerificationRecord,SpendAccount,SpendAttempt)])
    monkeypatch.setattr(settings,"recommendation_audit_enabled",True)
    monkeypatch.setattr(settings,"recommendation_audit_external_enabled",False)
    monkeypatch.setattr(settings,"auth_disabled",False)
    monkeypatch.setattr(settings,"environment","test")
    monkeypatch.setattr(security_module,"SECRET_KEY","disposable-fixture-signing-key-only")
    monkeypatch.setenv("CREDX_RECOVERY_MODE","0")
    with Session(engine) as session:
        session.add_all([User(id=i,email=f"fixture-{i}@invalid.test",username=f"fixture-{i}",password_hash="unused-fixture",role=UserRole.USER,is_active=True) for i in (1,2)])
        session.add(Run(id=10,user_id=1,prompt="fixture",prompt_preview="fixture"))
        current=decision(session);body=request(current).model_dump(mode="json")
    async_engine=create_async_engine(f"sqlite+aiosqlite:///{database}")
    sessions=async_sessionmaker(async_engine,expire_on_commit=False)
    async def fixture_db():
        async with sessions() as session: yield session
    app=FastAPI();app.include_router(router);app.dependency_overrides[get_async_db]=fixture_db
    broker_url="memory://"
    if broker=="redis":
        from urllib.parse import urlsplit
        broker_url=os.environ["CREDX_AUDIT_TEST_REDIS_URL"]
        target=urlsplit(broker_url)
        if target.scheme!="redis" or target.hostname not in {"127.0.0.1","localhost","redis"} or target.path!="/15" or target.username or target.password: pytest.fail("Refusing a non-disposable local Redis URL")
    fixture_id=uuid4().hex
    celery=Celery("audit-isolated-fixture-"+fixture_id,broker=broker_url,backend="cache+memory://",set_as_current=False)
    celery.conf.update(task_default_queue="audit-fixture-only-"+fixture_id,task_serializer="json",accept_content=["json"],result_serializer="json",broker_connection_retry=False,broker_connection_retry_on_startup=False,broker_connection_timeout=3,broker_transport_options={"global_keyprefix":"audit-fixture:"+fixture_id+":","socket_connect_timeout":3,"socket_timeout":3})
    def prohibited(*args): raise AssertionError("External collector forbidden in queue fixture")
    # Shared global finalize callbacks may register a prior parametrization's
    # same-name task/SQLite closure. Bind this fixture task eagerly and privately.
    @celery.task(name="audit.fixture.verify."+fixture_id,shared=False,lazy=False)
    def queued_verification(record_id):
        with Session(engine,expire_on_commit=False) as session:
            return run_verification(session,record_id,SimpleNamespace(recommendation_audit_external_enabled=False),external_collector=prohibited)
    def unavailable(*args,**kwargs): raise RuntimeError("fixture broker unavailable")
    monkeypatch.setattr(verify_reversal,"apply_async",unavailable)
    token=JWTUtils.create_access_token(1,"fixture-1@invalid.test","user")
    other=JWTUtils.create_access_token(2,"fixture-2@invalid.test","user")
    previous_current=getattr(_state._tls,"current_app",None)
    previous_default=_state.default_app
    try:
        with start_worker(celery,pool="solo",perform_ping_check=False,shutdown_timeout=5):
            assert queued_verification.app is celery
            assert celery.tasks[queued_verification.name] is queued_verification
            assert any(cell.cell_contents is engine for cell in queued_verification.run.__closure__ or ())
            async with AsyncClient(transport=ASGITransport(app=app),base_url="http://fixture.test") as client:
                assert (await client.post("/runs/recommendation-audit/verifications",json=body)).status_code==401
                assert (await client.post("/runs/recommendation-audit/verifications",json=body,headers={"Authorization":"Bearer invalid"})).status_code==401
                headers={"Authorization":f"Bearer {token}"}
                response=await client.post("/runs/recommendation-audit/verifications",json=body,headers=headers)
                assert response.status_code==200,response.text
                record_id=response.json()["id"]
                assert response.json()["dispatch_pending"] is True
                # Recovery after a broker outage uses the actual relay service and
                # committed request, without another user/API redispatch request.
                from app.domains.recommendation_audit.outbox import RelayService
                with Session(engine) as session:
                    row=session.get(VerificationRecord,record_id)
                    from datetime import timedelta
                    from app.domains.recommendation_audit.models import utcnow
                    row.last_dispatch_at=utcnow()-timedelta(seconds=16);session.commit()
                delivered=[]
                def publish_fixture(record_id):
                    delivered.append(queued_verification.apply_async(args=[record_id],retry=False))
                relay=RelayService(lambda:Session(engine,expire_on_commit=False),publish_fixture,SimpleNamespace(recommendation_audit_enabled=True))
                relay.start()
                try:
                    deadline=asyncio.get_running_loop().time()+10
                    while True:
                        result=(await client.get(f"/runs/recommendation-audit/verifications/{record_id}",headers=headers)).json()
                        if result["status"]=="completed" or asyncio.get_running_loop().time()>=deadline: break
                        await asyncio.sleep(.05)
                finally: relay.stop()
                assert result["status"]=="completed" and result["verdict"]=="insufficient_evidence", {"record":result,"deliveries":[{"id":task.id,"state":task.state} for task in delivered]}
                assert result["spent_usd"]=="0E-8" and result["reserved_usd"]=="0E-8"
                assert (await client.get(f"/runs/recommendation-audit/verifications/{record_id}",headers={"Authorization":f"Bearer {other}"})).status_code==404
                duplicate=await client.post("/runs/recommendation-audit/verifications",json=body,headers=headers)
                assert duplicate.json()["id"]==record_id
    finally:
        _state._set_current_app(previous_current)
        _state.set_default_app(previous_default)
        await async_engine.dispose()
        engine.dispose()
        celery.close()


def test_disposable_sqlite_worker_claim_is_atomic_across_sessions(tmp_path):
    import app.models
    engine=create_engine(f"sqlite:///{tmp_path/'claims.sqlite'}",connect_args={"check_same_thread":False,"timeout":10})
    Base.metadata.create_all(engine,tables=[m.__table__ for m in (DecisionRecord,VerificationRecord,SpendAccount)])
    with Session(engine) as session:
        current=decision(session);v=create_verification(session,1,request(current),daily_cap=0);session.commit();record_id=v.id
    barrier=Barrier(2)
    def claim(_):
        with Session(engine) as session:
            barrier.wait();return claim_lease(session,record_id) is not None
    with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(claim,range(2)))
    assert sorted(results)==[False,True]
    engine.dispose()
