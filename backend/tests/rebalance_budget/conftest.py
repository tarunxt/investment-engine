"""Synthetic ledger database; never use application DATABASE_URL as test target."""
import os
import uuid

import pytest
import app.models  # noqa: F401 — complete the shared ORM registry, no I/O
from sqlalchemy import Column, ForeignKey, Integer, MetaData, String, Table, create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from sqlalchemy.schema import CreateSchema, DropSchema

from app.domains.rebalance_budget import ledger, runtime
from app.domains.rebalance_budget.models import RebalanceSpendAttempt, RebalanceSpendBinding, RebalanceSpendScope


def guarded_url(raw):
    url = make_url(raw)
    if (os.environ.get("CREDX_CAP_TEST_DATABASE_ACK") != "disposable-local-only"
            or url.drivername not in {"postgresql", "postgresql+psycopg2"}
            or url.host not in {"127.0.0.1", "localhost", "::1"}
            or not (url.database or "").startswith("credx_cap_test_") or url.query):
        raise ValueError("Explicit disposable local cap-test PostgreSQL target required")
    return url.set(drivername="postgresql+psycopg2")


@pytest.fixture
def cap_db(monkeypatch):
    raw = os.environ.get("CREDX_CAP_TEST_DATABASE_URL")
    schema = "credx_cap_test_" + uuid.uuid4().hex
    if raw:
        engine = create_engine(guarded_url(raw), connect_args={"options": f"-csearch_path={schema} -cstatement_timeout=10000"})
        with engine.begin() as connection:
            connection.execute(CreateSchema(schema))
    else:
        engine = create_engine("sqlite://")
    metadata = MetaData()
    users = Table("users", metadata, Column("id", Integer, primary_key=True))
    jobs = Table("jobs", metadata, Column("id", Integer, primary_key=True),
        Column("user_id", Integer, ForeignKey("users.id")),
        Column("auto_rebalance_portfolio", String(32)), Column("auto_rebalance_sequence", Integer))
    for model in (RebalanceSpendScope, RebalanceSpendBinding, RebalanceSpendAttempt):
        model.__table__.to_metadata(metadata)
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(users.insert(), [{"id": 1}, {"id": 2}])
        connection.execute(jobs.insert(), [
            {"id": 1, "user_id": 1, "auto_rebalance_portfolio": "india", "auto_rebalance_sequence": 1},
            {"id": 2, "user_id": 1, "auto_rebalance_portfolio": "india", "auto_rebalance_sequence": 2},
            {"id": 3, "user_id": 1, "auto_rebalance_portfolio": "indmoney_us", "auto_rebalance_sequence": 1},
            {"id": 4, "user_id": 2, "auto_rebalance_portfolio": "india", "auto_rebalance_sequence": 1},
        ])
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(ledger, "job_table", lambda: jobs)
    monkeypatch.setattr(runtime, "sessions", factory)
    try:
        yield factory, engine
    finally:
        if raw:
            with engine.begin() as connection:
                connection.execute(DropSchema(schema, cascade=True))
        engine.dispose()
