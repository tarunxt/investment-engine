from datetime import timedelta
from types import SimpleNamespace
from sqlalchemy import select

from app.domains.recommendation_audit.models import utcnow,VerificationRecord,SpendAttempt
from app.domains.recommendation_audit.outbox import dispatch_due,relay_pass,RelayService,relay_database
from app.domains.recommendation_audit.worker import claim_lease,run_verification
from app.domains.recommendation_audit.ledger import reserve,BudgetBlocked
from test_recommendation_audit import db,verification


def test_publish_failure_is_durable_and_recovered_without_manual_request(db,monkeypatch):
    monkeypatch.setenv("CREDX_RECOVERY_MODE","0")
    v=verification(db);now=utcnow();calls=[]
    def failed(record_id): calls.append(record_id);raise RuntimeError("fixture broker unavailable")
    assert dispatch_due(db,failed,now=now)["failed"]==1
    db.expire_all();assert db.get(VerificationRecord,v.id).dispatch_pending is True
    assert dispatch_due(db,calls.append,now=now+timedelta(seconds=10))["claimed"]==0
    assert dispatch_due(db,calls.append,now=now+timedelta(seconds=16))["published"]==1
    db.expire_all();assert db.get(VerificationRecord,v.id).dispatch_pending is False
    assert calls==[v.id,v.id]


def test_recovery_handles_expired_and_lost_delivery_but_not_active_cancelled_or_finished(db,monkeypatch):
    monkeypatch.setenv("CREDX_RECOVERY_MODE","0")
    v=verification(db);now=utcnow();calls=[]
    dispatch_due(db,calls.append,now=now)
    assert dispatch_due(db,calls.append,now=now+timedelta(seconds=179))["claimed"]==0
    assert dispatch_due(db,calls.append,now=now+timedelta(seconds=181))["claimed"]==1
    lease=claim_lease(db,v.id);assert lease
    assert dispatch_due(db,calls.append)["claimed"]==0
    lease.lease_until=utcnow()-timedelta(seconds=1);lease.last_dispatch_at=utcnow()-timedelta(seconds=20);db.commit()
    assert dispatch_due(db,calls.append)["claimed"]==1
    for state in ["cancelled","completed","failed"]:
        lease.status=state;lease.dispatch_pending=True;lease.last_dispatch_at=None;db.commit()
        assert dispatch_due(db,calls.append)["claimed"]==0


def test_late_publish_cannot_erase_later_claim(db,monkeypatch):
    monkeypatch.setenv("CREDX_RECOVERY_MODE","0")
    v=verification(db);now=utcnow()
    def publisher(record_id):
        current=db.get(VerificationRecord,record_id,populate_existing=True)
        current.last_dispatch_at=now+timedelta(seconds=16);current.dispatch_pending=True;db.commit()
    dispatch_due(db,publisher,now=now)
    db.expire_all();assert db.get(VerificationRecord,v.id).dispatch_pending is True


def test_disabled_recovery_and_shutdown_make_no_db_or_broker_call(monkeypatch):
    def never(*args): raise AssertionError("Unexpected DB/broker access")
    off=SimpleNamespace(recommendation_audit_enabled=False)
    assert relay_pass(never,never,off)["blocked"] is True
    service=RelayService(never,never,off);service.start();assert service.thread is None
    on=SimpleNamespace(recommendation_audit_enabled=True)
    monkeypatch.setenv("CREDX_RECOVERY_MODE","1")
    assert relay_pass(never,never,on)["blocked"] is True
    monkeypatch.setenv("CREDX_RECOVERY_MODE","0")
    assert relay_pass(never,never,on,should_stop=lambda:True)["blocked"] is True


def test_relay_owns_an_unpooled_engine_with_bounded_postgres_operations(monkeypatch):
    import app.domains.recommendation_audit.outbox as outbox
    from sqlalchemy.pool import NullPool
    captured={}
    sentinel=object()
    def create(url,**kwargs): captured.update(url=url,**kwargs);return sentinel
    monkeypatch.setattr(outbox,"create_engine",create)
    monkeypatch.setattr(outbox,"sessionmaker",lambda **kwargs:kwargs)
    engine,factory=relay_database("postgresql+asyncpg://fixture:fixture@localhost/disposable")
    assert engine is sentinel and factory["bind"] is sentinel
    assert captured["poolclass"] is NullPool
    assert captured["url"].drivername=="postgresql"
    assert captured["connect_args"]=={"connect_timeout":3,"options":"-c statement_timeout=3000 -c lock_timeout=1000"}


def test_relay_returns_no_idle_connection_to_an_inherited_pool(tmp_path):
    from sqlalchemy import event,text
    from sqlalchemy.pool import NullPool
    engine,factory=relay_database(f"sqlite:///{tmp_path/'relay.sqlite'}")
    connects=[];closes=[]
    event.listen(engine,"connect",lambda *args:connects.append(1))
    event.listen(engine,"close",lambda *args:closes.append(1))
    try:
        for _ in range(2):
            with factory() as session: assert session.scalar(text("SELECT 1"))==1
        assert isinstance(engine.pool,NullPool) and len(connects)==len(closes)==2
    finally: engine.dispose()


def test_recovered_task_does_not_repeat_reserved_paid_attempt(db,monkeypatch):
    monkeypatch.setenv("CREDX_RECOVERY_MODE","0")
    v=verification(db,budget="0.1",daily="0.1");lease=claim_lease(db,v.id)
    reserve(db,v.id,lease.fence,attempt_key="kite:1",adapter="fixture",tariff_version="v1",upper_bound="0.01",daily_cap="0.1")
    lease.lease_until=utcnow()-timedelta(seconds=1);lease.last_dispatch_at=utcnow()-timedelta(seconds=20)
    lease.request={**lease.request,"mode":"external_data"};db.commit()
    attempts=[]
    def collector(session,record,fence,*args):
        try: reserve(session,record.id,fence,attempt_key="kite:1",adapter="fixture",tariff_version="v1",upper_bound="0.01",daily_cap="0.1")
        except BudgetBlocked: return [],[],["Prior ambiguous attempt prevents repeat paid I/O"]
        attempts.append("external-I/O");raise AssertionError("Paid retry")
    dispatch_due(db,lambda record_id:run_verification(db,record_id,SimpleNamespace(recommendation_audit_external_enabled=True),external_collector=collector))
    db.expire_all();saved=db.get(VerificationRecord,v.id)
    assert saved.status=="completed" and saved.verdict=="insufficient_evidence"
    assert saved.reserved_usd>0 and not attempts and len(list(db.scalars(select(SpendAttempt))))==1
