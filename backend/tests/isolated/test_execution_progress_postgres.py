"""Native safe projection on an explicitly acknowledged disposable fixture."""
import unittest
from unittest.mock import patch
from sqlalchemy import Column, DateTime, JSON, Integer, MetaData, String, Table, text, null
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.schema import CreateSchema, DropSchema
from pathlib import Path
from datetime import datetime
from uuid import uuid4
from app.domains.health import progress_reader as reader
from execution_health_fixture import configured_target
URL = configured_target()

class NativeFixture:
    async def asyncSetUp(self):
        self.schema = 'a11_progress_' + uuid4().hex
        self.admin = create_async_engine(URL)
        async with self.admin.begin() as conn:
            version = await conn.scalar(text('SHOW server_version'))
            self.assertGreaterEqual(int(version.split('.')[0]), 16, version)
            print('Synthetic progress PostgreSQL:', version.split(' ')[0])
            await conn.execute(CreateSchema(self.schema))
        self.engine = create_async_engine(URL, pool_size=1, max_overflow=0,
            connect_args={'server_settings': {'search_path': self.schema}})
        self.sessions = async_sessionmaker(self.engine)
        meta = MetaData()
        self.jobs = Table('jobs', meta, Column('id', Integer, primary_key=True),
            Column('user_id', Integer), Column('status', String),
            Column('auto_rebalance_portfolio', String), Column('request_context_json', JSON),
            Column('runtime_metadata_json', JSON))
        self.outbox = Table('outbox', meta, Column('id', UUID(as_uuid=True), primary_key=True),
            Column('job_id', Integer, unique=True), Column('topic', String, index=True),
            Column('state', String, index=True), Column('created_at', DateTime, index=True))
        async with self.engine.begin() as conn:
            await conn.run_sync(meta.create_all)
            await conn.execute(self.jobs.insert(), [dict(id=i, user_id=7 if i<=140 else 8,
                status='processing', auto_rebalance_portfolio='india',
                request_context_json={'kind':'equity_output_sources_v1','market':'india'})
                for i in range(1,151)])
            await conn.execute(self.outbox.insert(), [dict(id=uuid4(),job_id=i,
                topic='analysis.dispatch.v1',
                state='delivered',created_at=datetime(2026,1,1)) for i in range(1,151)])

    async def asyncTearDown(self):
        await self.engine.dispose()
        async with self.admin.begin() as conn:
            await conn.execute(DropSchema(self.schema, cascade=True))
        await self.admin.dispose()

    async def assert_clean(self):
        async with self.engine.connect() as conn:
            self.assertEqual(await conn.scalar(text('SHOW transaction_read_only')), 'off')
            self.assertEqual(await conn.scalar(text('SHOW statement_timeout')), '0')
            self.assertEqual(await conn.scalar(text('SHOW lock_timeout')), '0')
            self.assertEqual(await conn.scalar(text('SELECT count(*) FROM jobs')), 150)



@unittest.skipUnless(URL is not None, 'disposable PostgreSQL fixture not acknowledged')
class NativeProgress(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Reuse exact marked synthetic fixture; never an application URL.
        await NativeFixture.asyncSetUp(self)
        self.outbox.append_column(Column('published_at', DateTime))
        self.outbox.append_column(Column('next_attempt_at', DateTime(timezone=True)))
        self.outbox.append_column(Column('payload', JSON))
        async with self.engine.begin() as conn:
            await conn.execute(text('ALTER TABLE outbox ADD COLUMN published_at timestamp, '
                                    'ADD COLUMN next_attempt_at timestamptz, ADD COLUMN payload json'))
            await conn.execute(self.outbox.update().values(payload={'eta':None}))
            await conn.execute(self.jobs.update().values(runtime_metadata_json={
                'execution_claim': {'state':'owned','expires_at':120,
                    'owner_token':'synthetic-private', 'progress': {
                        'version':1, 'receipt_scope':'recovery_analysis','admitted_at':70,
                        'lease_checkpoint_at':90,'provider_call_returned_at':85}}}))
            await conn.execute(self.jobs.update().where(self.jobs.c.user_id==8).values(
                runtime_metadata_json={'execution_claim': {'state':'owned','expires_at':120,
                    'progress': {'version':1,'receipt_scope':'recovery_analysis',
                                 'admitted_at':99,'lease_checkpoint_at':99}}}))

    asyncTearDown = NativeFixture.asyncTearDown
    assert_clean = NativeFixture.assert_clean

    async def read(self):
        return await reader.read_progress(self.sessions, self.jobs, self.outbox,
                                          actor_id=7, recovery=True, now=100)

    async def test_real_json_projection_owner_scope_and_no_false_green(self):
        result = await self.read()
        self.assertEqual(result['read_state'], 'sampled')
        self.assertEqual(result['sample_receipts'], 100)
        self.assertTrue(result['truncated'])
        self.assertEqual(result['source_timestamp'], 90)
        self.assertEqual(result['last_owner_checkpoint_age_seconds'], 10)
        self.assertEqual(result['receipt_evidence'], 'observed')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['consumer'], 'unknown')
        self.assertNotIn('synthetic-private', str(result))
        await self.assert_clean()

    async def test_store_timeout_cancellation_cleanup_and_no_mutation(self):
        for budget in (0.45, 0.02):
            with patch.object(reader, 'progress_query', return_value=text('SELECT pg_sleep(2)')), \
                    patch.object(reader, 'READ_TIMEOUT_SECONDS', budget):
                result = await self.read()
            self.assertEqual(result['read_state'], 'unavailable')
            self.assertIsNone(result['sample_receipts'])
            await self.assert_clean()
        with patch.object(reader, 'progress_query', return_value=text("UPDATE jobs SET status='failed'")):
            result = await self.read()
        self.assertEqual(result['read_state'], 'unavailable')
        async with self.engine.connect() as conn:
            self.assertEqual(await conn.scalar(text("SELECT count(*) FROM jobs WHERE status='failed'")), 0)
        await self.assert_clean()

    async def test_native_sql_and_json_null_receipts_are_not_dropped(self):
        async with self.engine.begin() as conn:
            for i, context in [(1, None), (2, null()), (3, 'null'), (4, {})]:
                await conn.execute(self.jobs.update().where(self.jobs.c.id == i).values(
                    user_id=9, request_context_json=context))
        result = await reader.read_progress(self.sessions, self.jobs, self.outbox,
            actor_id=9, recovery=True, now=100)
        self.assertEqual(result['read_state'], 'sampled')
        self.assertEqual(result['sample_size'], 2)
        self.assertEqual(result['sample_receipts'], 2)
        self.assertEqual(result['receipt_evidence'], 'observed')
        self.assertEqual(result['status'], 'unknown')
        await self.assert_clean()
