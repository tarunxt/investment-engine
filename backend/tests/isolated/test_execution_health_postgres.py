"""Opt-in PG18.6 synthetic fixture. Fixed disposable socket; no app DB config.

Fixture: official postgres image, network none, tmpfs data, Unix socket mounted at
/tmp/a11-004-pg-socket, port 55434 (container mount /var/run/postgresql). Never point this suite at an application DB.
"""
import asyncio
import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch
from uuid import uuid4
from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, JSON, MetaData, String, Table, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.schema import CreateSchema, DropSchema

from app.domains.health import execution_reader as reader

SOCKET = Path('/tmp/a11-004-pg-socket/.s.PGSQL.55434')
URL = 'postgresql+asyncpg://postgres@/postgres?host=/tmp/a11-004-pg-socket&port=55434'


@unittest.skipUnless(SOCKET.exists(), 'disposable PostgreSQL fixture unavailable')
class NativeReader(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.schema = 'a11_health_' + uuid4().hex
        self.admin = create_async_engine(URL)
        async with self.admin.begin() as conn:
            version = await conn.scalar(text('SHOW server_version'))
            self.assertTrue(version.startswith('18.6'), version)
            await conn.execute(CreateSchema(self.schema))
        self.engine = create_async_engine(URL, pool_size=1, max_overflow=0,
            connect_args={'server_settings': {'search_path': self.schema}})
        self.sessions = async_sessionmaker(self.engine)
        m = MetaData()
        self.jobs = Table('jobs', m, Column('id', Integer, primary_key=True),
            Column('user_id', Integer), Column('status', String(50)),
            Column('auto_rebalance_portfolio', String(32)),
            Column('request_context_json', JSON), Column('runtime_metadata_json', JSON))
        self.outbox = Table('outbox', m, Column('id', UUID(as_uuid=True), primary_key=True),
            Column('job_id', Integer, unique=True), Column('topic', String(200), index=True),
            Column('state', String(32), index=True), Column('created_at', DateTime, index=True))
        async with self.engine.begin() as conn:
            await conn.run_sync(m.create_all)
            await conn.execute(self.jobs.insert(), [dict(id=i, user_id=7 if i <= 140 else 8,
                status='processing', auto_rebalance_portfolio='india',
                request_context_json={'kind':'equity_output_sources_v1','market':'india'},
                runtime_metadata_json={'execution_claim': {'state':'owned',
                    'expires_at':200,'owner_token':'synthetic-private'}}) for i in range(1, 151)])
            await conn.execute(self.outbox.insert(), [dict(id=uuid4(), job_id=i,
                topic=reader.TOPIC, state='delivered', created_at=datetime(2026,1,1))
                for i in range(1,151)])

    async def asyncTearDown(self):
        await self.engine.dispose()
        async with self.admin.begin() as conn:
            await conn.execute(DropSchema(self.schema, cascade=True))
        await self.admin.dispose()

    async def read(self, factory=None):
        return await reader.read_durable_projection(factory or self.sessions,
            self.jobs, self.outbox, actor_id=7, recovery=True, now=200)

    async def assert_clean(self):
        async with self.engine.connect() as conn:
            self.assertEqual(await conn.scalar(text('SHOW transaction_read_only')), 'off')
            self.assertEqual(await conn.scalar(text('SHOW statement_timeout')), '0')
            self.assertEqual(await conn.scalar(text('SHOW lock_timeout')), '0')
            self.assertEqual(await conn.scalar(text('SELECT count(*) FROM jobs')), 150)

    async def test_plan_cap_foreign_scope_and_wiring(self):
        query = reader.projection_query(self.jobs, self.outbox, actor_id=7, recovery=True)
        async with self.engine.connect() as conn:
            # EXPLAIN only; synthetic literal binds, never application row data.
            sql = str(query.compile(dialect=conn.dialect, compile_kwargs={'literal_binds':True}))
            plan = await conn.scalar(text('EXPLAIN (FORMAT JSON) ' + sql))
            parsed = json.loads(plan) if isinstance(plan, str) else plan
            self.assertEqual(parsed[0]['Plan']['Node Type'], 'Limit')
            rows = (await conn.execute(query)).all()
            self.assertEqual(len(rows), 101)
            foreign = reader.projection_query(self.jobs, self.outbox, actor_id=8, recovery=True)
            self.assertEqual(len((await conn.execute(foreign)).all()), 10)
            print('Synthetic PG plan nodes:', sorted(set(self.nodes(parsed[0]['Plan']))))
        result = await self.read()
        self.assertEqual(result['read_state'], 'sampled')
        self.assertTrue(result['truncated'])
        self.assertEqual(result['consumer'], 'unknown')
        self.assertEqual(result['receipt'], 'unknown')
        self.assertNotIn('synthetic-private', str(result))
        await self.assert_clean()

    def nodes(self, plan):
        yield plan['Node Type']
        for child in plan.get('Plans', []): yield from self.nodes(child)

    async def test_native_statement_timeout_and_rollback(self):
        started = time.monotonic()
        with patch.object(reader, 'projection_query', return_value=text('SELECT pg_sleep(2)')):
            result = await self.read()
        self.assertEqual(result['read_state'], 'unavailable')
        self.assertLess(time.monotonic() - started, 0.45)
        await self.assert_clean()

    async def test_inflight_cancellation_cleanup(self):
        with patch.object(reader, 'projection_query', return_value=text('SELECT pg_sleep(2)')), \
                patch.object(reader, 'READ_TIMEOUT_SECONDS', 0.02):
            result = await self.read()
        self.assertEqual(result['read_state'], 'unavailable')
        await self.assert_clean()

    async def test_outer_pool_timeout(self):
        async with self.engine.connect():
            started = time.monotonic()
            result = await self.read()
            self.assertEqual(result['read_state'], 'unavailable')
            self.assertLess(time.monotonic() - started, 0.8)
        await self.assert_clean()

    async def test_readonly_rejects_write(self):
        with patch.object(reader, 'projection_query',
                          return_value=text("UPDATE jobs SET status='failed'")):
            result = await self.read()
        self.assertEqual(result['read_state'], 'unavailable')
        async with self.engine.connect() as conn:
            self.assertEqual(await conn.scalar(text("SELECT count(*) FROM jobs WHERE status='failed'")), 0)
        await self.assert_clean()

    async def test_lock_timeout_and_cleanup(self):
        async with self.admin.connect() as lock:
            async with lock.begin():
                await lock.execute(text('LOCK TABLE ' + self.schema + '.outbox IN ACCESS EXCLUSIVE MODE'))
                started = time.monotonic()
                result = await self.read()
                self.assertEqual(result['read_state'], 'unavailable')
                self.assertLess(time.monotonic() - started, 0.45)
        await self.assert_clean()


if __name__ == '__main__': unittest.main()
