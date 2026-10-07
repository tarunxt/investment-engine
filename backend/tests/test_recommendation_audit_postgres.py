"""Run in the Docker test environment only, against an explicitly disposable DB.

Set CREDX_AUDIT_DISPOSABLE_DB=1 and CREDX_AUDIT_TEST_POSTGRES_URL to a database
whose name starts credx_audit_test. No production URL fallback is permitted.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import os
from pathlib import Path
from threading import Barrier
from uuid import uuid4
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from app.domains.recommendation_audit.models import EvidenceRecord, DecisionRecord, VerificationRecord, SpendAccount, SpendAttempt
from app.domains.recommendation_audit.ledger import reserve, BudgetBlocked
from app.domains.recommendation_audit.worker import claim_lease

DSN=os.getenv("CREDX_AUDIT_TEST_POSTGRES_URL","")
pytestmark=pytest.mark.skipif(not DSN or os.getenv("CREDX_AUDIT_DISPOSABLE_DB")!="1" or not Path("/.dockerenv").exists(),reason="Disposable PostgreSQL Docker test environment not provided")


@pytest.fixture
def engine():
    from sqlalchemy.engine import make_url
    url=make_url(DSN)
    if not url.database or not url.database.startswith("credx_audit_test"): pytest.fail("Refusing a non-test database")
    base=create_engine(url)
    schema="audit_test_"+uuid4().hex
    # Raw DDL is limited to isolated-schema and immutable-trigger verification.
    with base.begin() as conn: conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    isolated=base.execution_options(schema_translate_map={None:schema})
    # Exercise the actual additive migration and its triggers in this disposable
    # schema, rather than reconstructing a different schema from model metadata.
    import importlib.util
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    path=Path(__file__).resolve().parents[1]/"alembic/versions/recommendation_audit_001.py"
    spec=importlib.util.spec_from_file_location("audit_fixture_migration",path)
    migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)
    with isolated.begin() as conn:
        conn.execute(text(f'SET LOCAL search_path TO "{schema}"'))
        with Operations.context(MigrationContext.configure(conn)): migration.upgrade()
    yield isolated
    with base.begin() as conn: conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    base.dispose()


def seed(engine,count=1):
    ids=[]
    with Session(engine) as session:
        for i in range(count):
            v=VerificationRecord(user_id=1,current_id=str(uuid4()),request_hash=uuid4().hex,idempotency_key=uuid4().hex,request={},budget_usd=Decimal("0.2"),spent_usd=0,reserved_usd=0,status="processing",fence=1,lease_until=datetime.now(timezone.utc)+timedelta(seconds=180))
            session.add(v);session.flush();ids.append(v.id)
        session.add(SpendAccount(user_id=1,day=datetime.now(timezone.utc).date().isoformat(),cap_usd=Decimal("0.02"),spent_usd=0,reserved_usd=0));session.commit()
    return ids


def test_daily_reservation_serializes_across_verifications(engine):
    ids=seed(engine,2);barrier=Barrier(2)
    def attempt(record_id):
        with Session(engine) as session:
            barrier.wait()
            try:
                reserve(session,record_id,1,attempt_key="one",adapter="fixture",tariff_version="v1",upper_bound="0.015",daily_cap="0.02")
                return "reserved"
            except BudgetBlocked:
                session.rollback();return "blocked"
    with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(attempt,ids))
    assert sorted(results)==["blocked","reserved"]


def test_one_worker_claims_queued_record(engine):
    record_id=seed(engine)[0]
    with Session(engine) as session:
        v=session.get(VerificationRecord,record_id);v.status="queued";session.commit()
    barrier=Barrier(2)
    def claim(_):
        with Session(engine) as session: barrier.wait();return claim_lease(session,record_id) is not None
    with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(claim,range(2)))
    assert sorted(results)==[False,True]


def test_core_update_cannot_mutate_immutable_evidence(engine):
    from sqlalchemy import update
    with Session(engine) as session:
        evidence=EvidenceRecord(user_id=1,kind="fixture",source_key="immutable",content_hash="a"*64,payload={})
        session.add(evidence);session.commit();record_id=evidence.id
    with Session(engine) as session:
        with pytest.raises(Exception,match="append.only"):
            session.execute(update(EvidenceRecord).where(EvidenceRecord.id==record_id).values(content="rewrite"));session.commit()


def test_actual_migration_columns_and_constraints_match_models(engine):
    from sqlalchemy import inspect
    with engine.connect() as conn:
        schema=conn.get_execution_options()["schema_translate_map"][None]
        inspector=inspect(conn)
        for model in (EvidenceRecord,DecisionRecord,VerificationRecord,SpendAccount,SpendAttempt):
            table=model.__table__
            assert {c["name"] for c in inspector.get_columns(table.name,schema=schema)}==set(table.columns.keys())
            model_unique={tuple(c.columns.keys()) for c in table.constraints if c.__class__.__name__=="UniqueConstraint"}
            migrated_unique={tuple(c["column_names"]) for c in inspector.get_unique_constraints(table.name,schema=schema)}
            assert model_unique==migrated_unique
