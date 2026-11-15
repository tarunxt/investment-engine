"""Passive progress projections and authenticated route, synthetic only."""
import ast
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace, ModuleType
import sys
import httpx
from fastapi import FastAPI, Depends, Header, HTTPException
import unittest
from unittest.mock import patch

from sqlalchemy import Column, DateTime, JSON, select
from sqlalchemy.dialects import postgresql
from test_execution_health_reader import tables
from app.domains.health import progress_reader as reader


def row(**changes):
    fields = dict(dispatch_state='delivered', created_at=50, claim_state='owned',
        claim_expires_at=120, job_status='processing', progress_version='1',
        receipt_scope='recovery_analysis', admitted_at='70', lease_checkpoint_at='90',
        provider_call_started_at='80', provider_call_returned_at='85', published_at=60,
        next_attempt_at=None, eta=None)
    return {**fields, **changes}


class ProgressReader(unittest.IsolatedAsyncioTestCase):
    def tables(self):
        _, jobs, outbox = tables()
        outbox.append_column(Column('published_at', DateTime))
        outbox.append_column(Column('next_attempt_at', DateTime))
        outbox.append_column(Column('payload', JSON))
        return jobs, outbox

    def test_normal_delayed_legacy_and_future_sources_never_turn_healthy(self):
        normal = reader.summarize_progress([row()], recovery=True, now=100)
        self.assertEqual(normal['sample_receipts'], 1)
        self.assertEqual(normal['last_receipt_age_seconds'], 30)
        self.assertEqual(normal['last_owner_checkpoint_age_seconds'], 10)
        self.assertEqual(normal['last_provider_return_age_seconds'], 15)
        self.assertEqual(normal['last_publish_age_seconds'], 40)
        self.assertEqual(normal['source_timestamp'], 90)
        for changes in ({}, {'lease_checkpoint_at':'10'}, {'progress_version':None},
                        {'receipt_scope':'unknown'}, {'admitted_at':'150'}):
            result = reader.summarize_progress([row(**changes)], recovery=True, now=100)
            self.assertEqual(result['status'], 'unknown')
            self.assertEqual(result['freshness'], 'unknown')
            self.assertEqual(result['queue_state'], 'unknown')
            self.assertFalse(result['deployment_gate'])
            self.assertIsNone(result['acceptance_threshold'])
        legacy = reader.summarize_progress([row(progress_version=None)], recovery=True, now=100)
        self.assertIsNone(legacy['last_receipt_age_seconds'])

    def test_eligible_dispatch_age_respects_eta_backoff_and_terminal_history(self):
        result = reader.summarize_progress([
            row(dispatch_state='pending', created_at=50, next_attempt_at=80),
            row(dispatch_state='pending', eta='1970-01-01T00:03:00+00:00'),
            row(dispatch_state='pending', job_status='completed', created_at=1, claim_expires_at=1),
        ], recovery=True, now=100)
        self.assertEqual(result['sample_oldest_eligible_dispatch_age_seconds'], 20)
        self.assertIsNone(result['oldest_eligible_queue_age_seconds'])
        self.assertEqual(result['sample_expired_active_claims'], 0)
        for changes in ({'eta':'malformed'}, {'next_attempt_at':'bad'}):
            unknown = reader.summarize_progress([row(dispatch_state='pending', **changes)],
                                                 recovery=True, now=100)
            self.assertIsNone(unknown['sample_oldest_eligible_dispatch_age_seconds'])
            self.assertEqual(unknown['sample_eligibility_unknown'], 1)
        expired = reader.summarize_progress([row(claim_expires_at=99)], recovery=True, now=100)
        self.assertEqual(expired['sample_expired_active_claims'], 1)
        self.assertEqual(expired['financial_services'], 'intentional_containment')

    def test_cap_and_missing_versus_empty(self):
        seen = []
        def rows():
            for i in range(1000):
                seen.append(i)
                yield row()
        result = reader.summarize_progress(rows(), recovery=True, now=100)
        self.assertEqual(len(seen), 101)
        self.assertTrue(result['truncated'])
        self.assertEqual(result['sample_size'], 100)
        empty = reader.summarize_progress([], recovery=True, now=100)
        self.assertEqual(empty['sample_receipts'], 0)
        self.assertEqual(empty['queue_state'], 'unknown')
        missing = reader.unknown_progress(recovery=True, now=100)
        self.assertIsNone(missing['sample_receipts'])
        self.assertIsNone(missing['sample_size'])

    def test_query_is_scoped_and_has_no_private_projection(self):
        jobs, outbox = self.tables()
        query = reader.progress_query(jobs, outbox, actor_id=7, recovery=True)
        compiled = query.compile(dialect=postgresql.dialect())
        self.assertIn(101, compiled.params.values())
        self.assertIn(7, compiled.params.values())
        self.assertIn('analysis.dispatch.v1', compiled.params.values())
        self.assertNotIn('FOR UPDATE', str(compiled))
        names = {column.key for column in query.selected_columns}
        self.assertNotIn('payload', names)
        self.assertNotIn('runtime_metadata_json', names)
        self.assertNotIn('owner_token', str(compiled))
        self.assertIn('admitted_at', names)

    async def test_timeout_and_store_error_are_unknown_without_exception_payload(self):
        jobs, outbox = self.tables()
        class Slow:
            async def __aenter__(self): await asyncio.sleep(100)
            async def __aexit__(self, *args): pass
        with patch.object(reader, 'READ_TIMEOUT_SECONDS', 0.01):
            result = await asyncio.wait_for(reader.read_progress(
                Slow, jobs, outbox, actor_id=7, recovery=True, now=100), 0.2)
        self.assertEqual(result['read_state'], 'unavailable')
        self.assertIsNone(result['sample_receipts'])
        def failed(): raise RuntimeError('synthetic-private-token')
        result = await reader.read_progress(failed, jobs, outbox, actor_id=7, recovery=True, now=100)
        self.assertNotIn('synthetic-private', str(result))
        self.assertEqual(result['consumer'], 'unknown')

    async def test_actual_endpoint_body_asgi_preserves_auth_and_actor_scope(self):
        path = Path(__file__).parents[1] / 'app/domains/health/router.py'
        route = next(n for n in ast.parse(path.read_text()).body
                     if isinstance(n, ast.AsyncFunctionDef) and n.name == 'health_execution_progress')
        route.decorator_list = []
        async def current_user(authorization: str | None = Header(None)):
            if authorization != 'synthetic-test-session':
                raise HTTPException(401)
            return SimpleNamespace(id=7)
        sentinel = object()
        ns = {'Depends':Depends, 'get_current_user':current_user, 'AsyncSessionLocal':sentinel}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[route], type_ignores=[])),
                     str(path), 'exec'), ns)
        calls = []
        async def sampled(factory, jobs, outbox, **kwargs):
            calls.append((factory, kwargs))
            return reader.summarize_progress([row()], recovery=kwargs['recovery'], now=100)
        recovery_stub = ModuleType('app.core.recovery')
        recovery_stub.recovery_mode = lambda: True
        job_stub = ModuleType('app.domains.jobs.models')
        job_stub.Job = SimpleNamespace(__table__=object())
        outbox_stub = ModuleType('app.infrastructure.database.outbox.models')
        outbox_stub.OutboxMessage = SimpleNamespace(__table__=object())
        app = FastAPI()
        app.get('/health/execution/progress')(ns['health_execution_progress'])
        with patch.dict(sys.modules, {'app.core.recovery':recovery_stub,
                'app.domains.jobs.models':job_stub,
                'app.infrastructure.database.outbox.models':outbox_stub}), \
                patch.object(reader, 'read_progress', sampled):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://synthetic') as client:
                unauthorized = await client.get('/health/execution/progress')
                self.assertEqual(unauthorized.status_code, 401)
                self.assertEqual(calls, [])
                response = await client.get('/health/execution/progress?actor_id=999',
                    headers={'Authorization':'synthetic-test-session'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(calls[0][1]['actor_id'], 7)
        self.assertIs(calls[0][0], sentinel)
        self.assertEqual(response.json()['status'], 'unknown')
        self.assertEqual(response.json()['receipt_evidence'], 'observed')

    async def test_authenticated_route_passes_only_current_actor(self):
        path = Path(__file__).parents[1] / 'app/domains/health/router.py'
        tree = ast.parse(path.read_text())
        route = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                     and n.name == 'health_execution_progress')
        self.assertEqual(route.args.defaults[0].func.id, 'Depends')
        self.assertEqual(route.args.defaults[0].args[0].id, 'get_current_user')
        # Source contains no actor query/header argument or work-publishing API.
        self.assertEqual([arg.arg for arg in route.args.args], ['current_user'])
        calls = [n.func.attr for n in ast.walk(route) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Attribute)]
        self.assertFalse({'commit','publish','send_task','delay','apply_async'} & set(calls))
