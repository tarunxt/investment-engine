"""Stored-only recovery admission uses synthetic records and no external I/O."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.core.config import settings
from app.core.recovery import (
    AUDIT_TASK, ANALYSIS_QUEUE, RecoveryBlocked, audit_recovery_blocked,
    recovery_http_allowed, require_audit_request_allowed, require_task_allowed,
)
from app.domains.recommendation_audit.models import VerificationRecord, SpendAttempt
from app.domains.recommendation_audit.outbox import dispatch_due
from app.domains.recommendation_audit.router import write_enabled, request_allowed
from app.domains.recommendation_audit.worker import run_verification, collect_external
from app.infrastructure.messaging.recovery_celery import RecoveryCelery, configure_recovery_queue
from app.infrastructure.messaging.recovery_celery import RecoveryTask
from celery import Celery
from kombu import Connection
from test_recommendation_audit import db, decision, request
from app.domains.recommendation_audit.service import create_verification


@pytest.fixture
def stored_recovery(monkeypatch):
    monkeypatch.setenv("CREDX_RECOVERY_MODE", "1")
    for name,value in {
        "recommendation_audit_enabled":True,
        "recommendation_audit_recovery_stored_only_enabled":True,
        "recommendation_audit_external_enabled":False,
        "recommendation_audit_fundamentals_enabled":False,
        "recommendation_audit_daily_cap_usd":0,
    }.items(): monkeypatch.setattr(settings,name,value)
    return settings


def rows(db):
    current=decision(db)
    records=[]
    for mode,budget in [("stored_only",0),("external_data",0),("stored_only",1)]:
        row=create_verification(db,1,request(current,mode=mode,budget=budget),daily_cap=0)
        records.append(row)
    db.commit()
    return records


@pytest.mark.parametrize("name,value", [
    ("recommendation_audit_enabled",False),
    ("recommendation_audit_recovery_stored_only_enabled",False),
    ("recommendation_audit_external_enabled",True),
    ("recommendation_audit_fundamentals_enabled",True),
    ("recommendation_audit_daily_cap_usd",0.01),
    ("recommendation_audit_daily_cap_usd",float("nan")),
])
def test_unsafe_tuple_blocks_all_audit_writes_and_task(stored_recovery,monkeypatch,name,value):
    monkeypatch.setattr(settings,name,value)
    assert audit_recovery_blocked()
    with pytest.raises(HTTPException): write_enabled()
    with pytest.raises(RecoveryBlocked): require_task_allowed(AUDIT_TASK)
    assert not recovery_http_allowed("POST","/runs/recommendation-audit/verifications")


def test_admission_is_exact_and_preserves_financial_containment(stored_recovery):
    write_enabled();require_task_allowed(AUDIT_TASK)
    for path in ["materialize","calculations","verifications"]:
        assert recovery_http_allowed("POST","/runs/recommendation-audit/"+path)
    assert recovery_http_allowed("POST","/runs/recommendation-audit/verifications/"+"a"*36+"/cancel")
    for path in ["/zerodha/orders","/runs/recommendation-audit/delete","/runs/recommendation-audit/verifications/not-a-record/cancel","/runs/recommendation-audit/verifications/"+"a"*36+"/cancel/extra"]:
        assert not recovery_http_allowed("POST",path)
    with pytest.raises(RecoveryBlocked): require_task_allowed("app.domains.mails.tasks.deliver_completion_email")


@pytest.mark.parametrize("payload", [
    {"mode":"external_data","budget_usd":"0"},
    {"mode":"stored_only","budget_usd":"0.01"},
    {"mode":"stored_only"}, {"mode":"unknown","budget_usd":"0"},
    {"mode":"stored_only","budget_usd":"NaN"},
    {"mode":[],"budget_usd":"0"}, {"mode":{},"budget_usd":"0"},
])
def test_route_guard_rejects_external_nonzero_and_malformed(stored_recovery,payload):
    with pytest.raises(HTTPException) as error: request_allowed(payload)
    assert error.value.status_code==403


def test_worker_and_relay_only_process_zero_cost_stored_rows(db,stored_recovery):
    stored,external,nonzero=rows(db)
    def prohibited(*args): pytest.fail("External collector was called")
    assert not run_verification(db,external.id,settings,external_collector=prohibited)
    assert not run_verification(db,nonzero.id,settings,external_collector=prohibited)
    delivered=[]
    def publisher(record_id):
        delivered.append(record_id)
        assert run_verification(db,record_id,settings,external_collector=prohibited)
    outcome=dispatch_due(db,publisher,configuration=settings)
    assert outcome["published"]==1 and delivered==[stored.id]
    db.expire_all()
    saved=db.get(VerificationRecord,stored.id)
    assert saved.status=="completed" and saved.verdict=="insufficient_evidence"
    assert saved.spent_usd==saved.reserved_usd==saved.budget_usd==0
    for row in [external,nonzero]:
        untouched=db.get(VerificationRecord,row.id)
        assert untouched.status=="queued" and untouched.fence==0 and untouched.last_dispatch_at is None
    assert list(db.scalars(select(SpendAttempt)))==[]


def test_corrupt_persisted_request_never_claimed(db,stored_recovery):
    row=rows(db)[0];row.request={**row.request,"mode":"unexpected"};db.commit()
    assert not run_verification(db,row.id,settings)
    assert dispatch_due(db,lambda _:pytest.fail("Published malformed row"),configuration=settings)["claimed"]==0
    assert row.fence==0 and row.status=="queued"


def test_direct_external_collector_refuses_before_credentials_or_http(stored_recovery):
    with pytest.raises(RecoveryBlocked): collect_external(None,None,None,None,None,settings)


def test_audit_consumer_uses_existing_isolated_queue_without_beat(stored_recovery):
    app=RecoveryCelery("stored-audit-fixture",broker="redis://127.0.0.1:6379/15",backend="redis://127.0.0.1:6379/15",set_as_current=False)
    try:
        configure_recovery_queue(app)
        assert app.conf.task_routes[AUDIT_TASK]=={"queue":ANALYSIS_QUEUE}
        assert len(app.conf.task_queues)==1 and app.conf.beat_schedule=={}
        assert "app.domains.recommendation_audit.tasks" in app.conf.imports
        assert app.conf.worker_enable_remote_control is False
    finally: app.close()


@pytest.mark.parametrize("mode",["stored_only","external_data"])
def test_recovery_publisher_validation_closes_bounded_private_engine(stored_recovery,monkeypatch,mode):
    import app.domains.recommendation_audit.outbox as outbox
    import app.infrastructure.database.sync_session as database
    from app.domains.recommendation_audit.tasks import verify_reversal
    calls=[]
    row=SimpleNamespace(request={"mode":mode,"budget_usd":"0"},budget_usd=0,spent_usd=0,reserved_usd=0)
    class Session:
        def __enter__(self): calls.append("opened");return self
        def __exit__(self,*args): calls.append("closed")
        def get(self,*args): return row
    monkeypatch.setattr(database,"SyncSessionLocal",lambda:pytest.fail("Shared task engine used by parent relay"))
    monkeypatch.setattr(outbox,"relay_database",lambda _: (SimpleNamespace(dispose=lambda:calls.append("disposed")),Session))
    monkeypatch.setattr(verify_reversal.app,"connection_for_write",lambda **_: (_ for _ in ()).throw(RuntimeError("fixture broker unavailable")))
    with pytest.raises(RecoveryBlocked if mode=="external_data" else RuntimeError): outbox.publish_verification("fixture")
    assert calls==["opened","closed","disposed"]


def test_real_task_delegation_accepts_only_bounded_canonical_connection(stored_recovery,monkeypatch):
    app=RecoveryCelery("stored-transport-fixture",broker="redis://127.0.0.1:6379/15",backend="redis://127.0.0.1:6379/15",task_cls=RecoveryTask,set_as_current=False)
    calls=[]
    monkeypatch.setattr(Celery,"send_task",lambda self,name,*args,**kwargs:calls.append((name,kwargs)))
    try:
        configure_recovery_queue(app)
        @app.task(name=AUDIT_TASK,shared=False,lazy=False)
        def fixture(record_id): return record_id
        with app.connection_for_write(connect_timeout=3,transport_options={**app.conf.broker_transport_options,"socket_timeout":3}) as connection:
            fixture.apply_async(args=["fixture"],connection=connection,retry=False)
            assert calls[0][0]==AUDIT_TASK and calls[0][1]["connection"] is connection
            assert calls[0][1]["queue"]==ANALYSIS_QUEUE
        for connection in [Connection("redis://127.0.0.1:6379/14",transport_options=app.conf.broker_transport_options),Connection("redis://127.0.0.1:6379/15"),object()]:
            with pytest.raises(RecoveryBlocked): fixture.apply_async(args=["fixture"],connection=connection,retry=False)
        assert len(calls)==1
        for alias in ["producer","publisher"]:
            with pytest.raises(RecoveryBlocked): fixture.apply_async(args=["fixture"],**{alias:object()})
            with pytest.raises(RecoveryBlocked): app.send_task(AUDIT_TASK,args=["fixture"],**{alias:object()})
        assert len(calls)==1
    finally: app.close()
