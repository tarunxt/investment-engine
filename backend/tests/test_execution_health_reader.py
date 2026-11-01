"""Synthetic SQLAlchemy compilation/SQLite scope tests; no runtime imports."""
import asyncio
from datetime import datetime
import unittest

from sqlalchemy import Column, DateTime, Integer, JSON, MetaData, String, Table, create_engine
from sqlalchemy.dialects import postgresql

from app.domains.health import execution_reader as reader


def tables():
    meta = MetaData()
    jobs = Table("jobs", meta, Column("id", Integer, primary_key=True),
                 Column("user_id", Integer), Column("status", String),
                 Column("runtime_metadata_json", JSON), Column("request_context_json", JSON),
                 Column("auto_rebalance_portfolio", String))
    outbox = Table("outbox", meta, Column("id", Integer, primary_key=True),
                   Column("job_id", Integer), Column("topic", String),
                   Column("state", String), Column("created_at", DateTime))
    return meta, jobs, outbox


class ReaderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.meta, self.jobs, self.outbox = tables()

    def test_actor_policy_topic_scope_and_projection(self):
        engine = create_engine("sqlite://")
        self.meta.create_all(engine)
        with engine.begin() as db:
            for i, actor, portfolio, topic in [
                (1, 7, "india", reader.TOPIC), (2, 8, "india", reader.TOPIC),
                (3, 7, "sports", reader.TOPIC), (4, 7, "india", "legacy"),
            ]:
                db.execute(self.jobs.insert().values(
                    id=i, user_id=actor, status="processing",
                    auto_rebalance_portfolio=portfolio,
                    request_context_json={"kind": "equity_output_sources_v1", "market": "india"},
                    runtime_metadata_json={"execution_claim": {
                        "state": "owned", "expires_at": 200, "owner_token": "synthetic-secret"}}))
                db.execute(self.outbox.insert().values(
                    id=i, job_id=i, topic=topic, state="pending", created_at=datetime(2026, 1, 1)))
            query = reader.projection_query(self.jobs, self.outbox, actor_id=7, recovery=True)
            rows = db.execute(query).mappings().all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["claim_state"], "owned")
            self.assertNotIn("synthetic-secret", str(rows))
        compiled = query.compile(dialect=postgresql.dialect())
        sql = str(compiled)
        self.assertIn(101, compiled.params.values())
        self.assertIn("LIMIT", sql)
        self.assertNotIn("FOR UPDATE", sql)
        self.assertNotIn("payload", sql)
        self.assertNotIn("owner_token", sql)
        self.assertEqual(len(query.selected_columns), 5)

    def test_database_row_cap(self):
        engine = create_engine("sqlite://")
        self.meta.create_all(engine)
        with engine.begin() as db:
            db.execute(self.jobs.insert(), [dict(
                id=i, user_id=7, status="pending", auto_rebalance_portfolio="india",
                request_context_json={"kind": "equity_output_sources_v1", "market": "india"},
            ) for i in range(1, 141)])
            db.execute(self.outbox.insert(), [dict(
                id=i, job_id=i, topic=reader.TOPIC, state="pending",
                created_at=datetime(2026, 1, 1),
            ) for i in range(1, 141)])
            rows = db.execute(reader.projection_query(
                self.jobs, self.outbox, actor_id=7, recovery=True)).all()
            self.assertEqual(len(rows), 101)

    async def test_deadlines_rollback_and_unknown_heartbeat(self):
        calls = []
        class Result:
            def mappings(self): return self
            def fetchmany(self, n):
                self.limit = n
                return [dict(dispatch_state="delivered", created_at=datetime(2026, 1, 1),
                             claim_state="owned", claim_expires_at="200", job_status="processing")]
        class Session:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return False
            def begin(self): return self
            async def execute(self, statement):
                calls.append(str(statement))
                return Result()
            async def rollback(self): calls.append("rollback")
        result = await reader.read_durable_projection(
            Session, self.jobs, self.outbox, actor_id=7, recovery=True, now=100)
        self.assertEqual(result["read_state"], "sampled")
        self.assertEqual(result["consumer"], "unknown")
        self.assertEqual(result["receipt"], "unknown")
        self.assertFalse(result["scope_complete"])
        self.assertEqual(calls[:3], ["SET TRANSACTION READ ONLY",
                         "SET LOCAL statement_timeout = '150ms'", "SET LOCAL lock_timeout = '50ms'"])
        self.assertEqual(calls[-1], "rollback")
        self.assertEqual(len(calls), 5)

    async def test_timeout_error_and_invalid_actor_fail_closed(self):
        class Slow:
            async def __aenter__(self): await asyncio.sleep(100)
            async def __aexit__(self, *args): pass
        original = reader.READ_TIMEOUT_SECONDS
        reader.READ_TIMEOUT_SECONDS = 0.01
        try:
            result = await asyncio.wait_for(reader.read_durable_projection(
                Slow, self.jobs, self.outbox, actor_id=7, recovery=True, now=100), 0.2)
        finally:
            reader.READ_TIMEOUT_SECONDS = original
        self.assertEqual(result["read_state"], "unavailable")
        def denied_factory(): raise RuntimeError("synthetic-private-connection")
        for actor in (7, None, True, -1):
            result = await reader.read_durable_projection(
                denied_factory, self.jobs, self.outbox, actor_id=actor, recovery=True, now=100)
            self.assertEqual(result["read_state"], "unavailable")
            self.assertNotIn("synthetic-private", str(result))


if __name__ == "__main__": unittest.main()
