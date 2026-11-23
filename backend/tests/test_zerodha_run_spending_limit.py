"""Exercise the actual provider boundary with local fixtures and zero external calls."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.domains.api_usage.metering import metered_call
from app.domains.jobs.models import Job
from app.domains.runs import spend_guard as guard
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow, AutoRebalanceWorkflowStage as Stage
from app.domains.runs.schemas import AutoRebalanceRunReservationRequest as Reservation
from test_auto_rebalance_audit_durability import anyio_backend, audit_db


def quote(paise=360):
    return {"max_paise": paise, "contract_ref": "synthetic-fixed-price",
            "valid_until": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()}


@pytest.mark.parametrize("amount", [True, -1, "0.001", 100001, "NaN"])
def test_invalid_cap_rejected(amount):
    with pytest.raises(ValidationError):
        Reservation(portfolio="india", max_cost_inr=amount)


@pytest.mark.anyio
async def test_all_stages_and_recovery_share_durable_headroom(monkeypatch, audit_db):
    engine = create_engine(audit_db.sync_url)
    sessions = sessionmaker(engine)
    monkeypatch.setattr(guard, "SyncSessionLocal", sessions)
    monkeypatch.setattr(settings, "zerodha_run_charge_ceilings", {"test:model:request": quote()})
    async with audit_db.sessions() as db:
        source = await db.get(Workflow, 7001)
        assert await guard.attach_budget(db, source, limit_paise=1000, parent_sequence=None) == {
            "max_cost_inr": 10, "headroom_inr": 10}
        await db.flush()
        child = Workflow(user_id=7, portfolio="india", sequence=43, label="recovery")
        db.add(child)
        await guard.attach_budget(db, child, limit_paise=None, parent_sequence=42)
        for job_id, seq in [(79, 42), (80, 43)]:
            db.add(Job(id=job_id, user_id=7, auto_rebalance_portfolio="india", auto_rebalance_sequence=seq,
                       model="model", provider="test", prompt="offline"))
        await db.commit()
    calls = []
    barrier = Barrier(2)

    def worker(job_id):
        with sessions() as db:
            token = guard.bind_job_budget(db, db.get(Job, job_id))
        try:
            barrier.wait(timeout=5)
            for _ in range(2):
                try:
                    metered_call(lambda: calls.append(job_id), provider="test", meter_model="model")
                except guard.SpendLimitError:
                    pass
        finally:
            guard.reset_job_budget(token)

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(worker, [79, 80]))
    assert len(calls) == 2
    async with audit_db.sessions() as db:
        workflows = list((await db.scalars(select(Workflow))).all())
        receipts = await guard.history_budgets(db, workflows)
        assert list(receipts.values()) == [{"max_cost_inr": 10, "headroom_inr": 2.8}] * 2
        attempts = list((await db.scalars(select(Stage).where(Stage.stage.startswith("sc1.inr.")))).all())
        assert sum(x.summary_json["held_paise"] for x in attempts) == 720
        with pytest.raises(guard.SpendLimitError, match="retain"):
            await guard.attach_budget(db, child, limit_paise=5000, parent_sequence=42)
        with pytest.raises(guard.SpendLimitError, match="not found"):
            await guard.attach_budget(db, SimpleNamespace(user_id=8), limit_paise=1000, parent_sequence=42)
    engine.dispose()


@pytest.mark.anyio
async def test_zero_cap_unpriced_timeout_and_legacy(monkeypatch, audit_db):
    engine = create_engine(audit_db.sync_url)
    sessions = sessionmaker(engine)
    monkeypatch.setattr(guard, "SyncSessionLocal", sessions)
    monkeypatch.setattr(settings, "zerodha_run_charge_ceilings", {"test:model:request": quote(100)})
    async with audit_db.sessions() as db:
        source = await db.get(Workflow, 7001)
        await guard.attach_budget(db, source, limit_paise=100, parent_sequence=None)
        for seq, lim in [(43, 0), (44, None)]:
            w = Workflow(user_id=7, portfolio="india", sequence=seq, label="synthetic")
            db.add(w)
            await guard.attach_budget(db, w, limit_paise=lim, parent_sequence=None)
        for seq in [42, 43, 44]:
            db.add(Job(id=seq, user_id=7, auto_rebalance_portfolio="india", auto_rebalance_sequence=seq,
                       provider="test", model="model", prompt="offline"))
        await db.commit()

    def call(job_id, model, fn):
        with sessions() as session:
            token = guard.bind_job_budget(session, session.get(Job, job_id))
        try:
            return metered_call(fn, provider="test", meter_model=model)
        finally:
            guard.reset_job_budget(token)

    def forbid():
        pytest.fail("An unapproved provider dispatch reached transport")

    with pytest.raises(guard.SpendLimitError, match="No verified"):
        call(42, "unpriced", forbid)
    with pytest.raises(guard.SpendLimitError, match="remaining"):
        call(43, "model", forbid)
    call(44, "unpriced", lambda: None)
    def ambiguous():
        raise TimeoutError("synthetic timeout after dispatch")
    with pytest.raises(TimeoutError):
        call(42, "model", ambiguous)
    with pytest.raises(guard.SpendLimitError, match="remaining"):
        call(42, "model", forbid)
    engine.dispose()
