"""Opt-in disposable PostgreSQL fixture. Never reads an application database URL.

Requires a locally initialized synthetic cluster listening ONLY on the exact
/tmp/a11-pg-socket Unix socket at port 55432. Each test owns a random schema.
No production/provider/broker connection or application bootstrap is performed.
The Celery task body and repository are loaded from source with only external
adapters stubbed; Celery eager dispatch and actual ownership lifecycle execute.
"""
import ast
import builtins
import concurrent.futures
from contextlib import nullcontext
import logging
from pathlib import Path
import sys
import time
from threading import Barrier, Event
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

from celery import Celery
from celery.exceptions import MaxRetriesExceededError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.schema import CreateSchema, DropSchema

from test_execution_claim import Base, Job, claim

ROOT = Path(__file__).parents[2]
SOCKET = Path('/tmp/a11-pg-socket/.s.PGSQL.55432')
URL = 'postgresql+psycopg2://agent@/postgres?host=/tmp/a11-pg-socket&port=55432'


def load_nodes(path, names, namespace):
    nodes = [n for n in ast.parse(path.read_text()).body
             if isinstance(n, (ast.ClassDef, ast.FunctionDef)) and n.name in names]
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), *nodes], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(path), 'exec'), namespace)


def stub_module(name, **values):
    module = ModuleType(name)
    module.__dict__.update(values)
    return module


@unittest.skipUnless(SOCKET.exists() and Path('/tmp/a11-pg-run/A11_SYNTHETIC_ONLY').exists(),
                     'marked disposable local PostgreSQL fixture unavailable')
class PostgreSQLExecution(unittest.TestCase):
    def setUp(self):
        self.admin = create_engine(URL)
        self.schema = 'a11_synthetic_' + uuid4().hex
        with self.admin.begin() as connection:
            connection.execute(CreateSchema(self.schema))
        self.engine = create_engine(URL, connect_args={'options': '-csearch_path=' + self.schema})
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(self.engine, expire_on_commit=False)
        with self.sessions() as db:
            db.add(Job(id=1, status='pending', runtime_metadata_json={'lineage': 'synthetic'}))
            db.commit()
        self.namespace = {'JobStatus': claim.JobStatus, 'Job': Job}
        load_nodes(ROOT / 'app/domains/jobs/repository.py', {'SyncJobRepository'}, self.namespace)
        self.repo = self.namespace['SyncJobRepository']
        self.settings = stub_module('app.core.config', settings=SimpleNamespace(recommendation_audit_enabled=False))
        self.modules = {'app.domains.jobs.execution_claim': claim, 'app.core.config': self.settings}
        self.module_patch = patch.dict(sys.modules, self.modules)
        self.module_patch.start()

    def tearDown(self):
        self.module_patch.stop()
        self.engine.dispose()
        with self.admin.begin() as connection:
            connection.execute(DropSchema(self.schema, cascade=True))
        self.admin.dispose()

    def row(self):
        with self.sessions() as db:
            return db.get(Job, 1)

    def admit(self, delivery='a', **kwargs):
        with self.sessions() as db:
            return claim.admit(db, 1, delivery, **kwargs)

    def test_concurrent_delivery_one_provider_entry(self):
        barrier = Barrier(2)
        entries = []
        def deliver(delivery):
            barrier.wait(timeout=5)
            token = self.admit(delivery)
            if token:
                owner = claim.ExecutionOwnership(self.sessions, 1, token)
                owner.before_call()
                entries.append(delivery)
                owner.after_call()
            return token
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            tokens = list(pool.map(deliver, ['a', 'b']))
        self.assertEqual(1, len(entries))
        self.assertEqual(1, sum(token is not None for token in tokens))

    def test_expired_owner_stale_completion_cannot_overwrite(self):
        a = self.admit(now=100)
        b = self.admit('b', now=221)
        with self.sessions() as db, patch.object(claim, 'timestamp', return_value=222):
            repo = self.repo(db)
            repo.execution_token = b
            repo.update_status(db.get(Job, 1), claim.JobStatus.COMPLETED, response='owner-b')
        with self.sessions() as db, patch.object(claim, 'timestamp', return_value=222):
            repo = self.repo(db)
            repo.execution_token = a
            with self.assertRaises(claim.LostExecutionOwner):
                repo.update_status(db.get(Job, 1), claim.JobStatus.COMPLETED, response='stale-a')
        self.assertEqual('owner-b', self.row().response)

    def test_live_heartbeat_extends_lease_and_thread_stops(self):
        token = self.admit()
        before = self.row().runtime_metadata_json[claim.KEY]['expires_at']
        renewed = Event()
        original = claim.checkpoint
        def observe(*args, **kwargs):
            original(*args, **kwargs)
            renewed.set()
        owner = claim.ExecutionOwnership(self.sessions, 1, token, interval=0.01)
        with patch.object(claim, 'checkpoint', side_effect=observe):
            owner.start()
            self.assertTrue(renewed.wait(3))
            owner.close()
        self.assertFalse(owner.thread.is_alive())
        self.assertGreater(self.row().runtime_metadata_json[claim.KEY]['expires_at'], before)

    def test_renewal_db_failure_is_sticky_and_blocks_provider(self):
        owner = claim.ExecutionOwnership(self.sessions, 1, self.admit(), interval=0.01)
        with patch.object(claim, 'checkpoint', side_effect=RuntimeError('synthetic database unavailable')):
            owner.start()
            self.assertTrue(owner.lost_event.wait(3))
        with self.assertRaises(claim.LostExecutionOwner):
            owner.before_call()
        owner.close()
        self.assertFalse(self.row().runtime_metadata_json[claim.KEY]['provider_started'])

    def test_provider_accepted_then_db_failure_no_replay(self):
        token = self.admit()
        owner = claim.ExecutionOwnership(self.sessions, 1, token)
        owner.before_call()
        with patch.object(claim, 'require_owner', side_effect=RuntimeError('synthetic commit/read failure')):
            with self.assertRaises(RuntimeError):
                owner.after_call()
        with self.sessions() as db:
            claim.reconcile(db, 1, token, evidence={'response': 'synthetic accepted result', 'tokens_in': 3})
        self.assertIsNone(self.admit('redelivery', now=time.time() + 200))
        row = self.row()
        self.assertEqual('reconciliation_needed', row.runtime_metadata_json[claim.KEY]['state'])
        self.assertEqual('synthetic accepted result', row.response)
        self.assertEqual(3, row.tokens_in)

    def task(self, generate, *, partial=False):
        celery = Celery('a11-synthetic', broker='memory://', backend='cache+memory://')
        celery.conf.task_always_eager = True
        celery.conf.task_eager_propagates = True
        lifecycle = []
        sessions = self.sessions
        class ObservedOwnership(claim.ExecutionOwnership):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs, interval=0.01)
                lifecycle.append(self)
        provider = SimpleNamespace(generate=generate)
        factory = SimpleNamespace(create=lambda name: provider)
        technical = MagicMock()
        modules = {
            **self.modules,
            'app.domains.ai_providers.factory': stub_module('app.domains.ai_providers.factory', ProviderFactory=factory),
            'app.domains.jobs.technical_prices': stub_module('app.domains.jobs.technical_prices', validate_technical_prices=technical),
            'app.domains.jobs.partial_output': stub_module('app.domains.jobs.partial_output', has_partial_output=lambda metadata: partial, PARTIAL_NOTICE='synthetic partial'),
        }
        namespace = dict(self.namespace, celery=celery, SyncSessionLocal=sessions,
            recovery_mode=lambda: False, monotonic=time.monotonic, Job=Job,
            MaxRetriesExceededError=MaxRetriesExceededError,
            logger=logging.getLogger('a11.synthetic'), WorkerLogHelper=MagicMock(),
            resolve_job_usage_identity=lambda *args: {},
            configure_output_context=lambda *args: None,
            set_provider_usage_context=lambda **kwargs: None,
            reset_output_context=MagicMock(), reset_provider_usage_context=MagicMock(),
            content_hash=lambda value: 'synthetic-hash', active_contract_hash=lambda: 'synthetic-schema',
            register_job_task_sync=MagicMock(), _publish_job_update=MagicMock(), _refresh_run_status=MagicMock(),
            rebalance_serialization_instructions=lambda: '', provider_usage_phase=lambda phase: nullcontext(),
            merge_web_metadata=lambda *args, **kwargs: (False, [], []),
            output_validation_metadata=lambda content: None,
            _requires_generic_table_output=lambda prompt: False, _is_portfolio_events_job=lambda prompt: False,
            merge_failure_diagnostics=lambda meta, diagnostics: {**(meta or {}), **diagnostics},
            build_failure_diagnostics=lambda *args, **kwargs: {'failure': 'synthetic'})
        load_nodes(ROOT / 'app/domains/jobs/tasks.py', {'execute_ai_job', '_mark_failed', '_update_job_status', '_job_was_cancelled'}, namespace)
        return namespace['execute_ai_job'], modules, lifecycle, technical, ObservedOwnership

    def run_task(self, generate, *, partial=False):
        task, modules, lifecycle, technical, owner = self.task(generate, partial=partial)
        with patch.dict(sys.modules, modules), patch.object(claim, 'ExecutionOwnership', owner):
            task.apply(args=[1], task_id='synthetic-delivery').get()
        self.assertEqual(1, len(lifecycle))
        self.assertFalse(lifecycle[0].thread.is_alive())
        return task, modules, lifecycle, technical

    def test_celery_heartbeat_runs_during_generation_and_closes(self):
        renewed = Event()
        original = claim.checkpoint
        def checkpoint(*args, **kwargs):
            original(*args, **kwargs)
            renewed.set()
        def generate(**kwargs):
            self.assertTrue(renewed.wait(3))
            return self.response()
        with patch.object(claim, 'checkpoint', side_effect=checkpoint):
            self.run_task(generate)
        self.assertEqual('completed', self.row().status)

    def test_celery_renewal_loss_during_generation_discards_terminal_write(self):
        task, modules, lifecycle, technical, owner = self.task(None)
        generate = modules['app.domains.ai_providers.factory'].ProviderFactory.create('synthetic')
        def finish_after_loss(**kwargs):
            self.assertTrue(lifecycle[0].lost_event.wait(3))
            return self.response()
        generate.generate = finish_after_loss
        with patch.dict(sys.modules, modules), patch.object(claim, 'ExecutionOwnership', owner), patch.object(claim, 'checkpoint', side_effect=RuntimeError('synthetic renewal lost')):
            task.apply(args=[1], task_id='synthetic-delivery').get()
        self.assertFalse(lifecycle[0].thread.is_alive())
        row = self.row()
        self.assertEqual('processing', row.status)
        self.assertEqual('reconciliation_needed', row.runtime_metadata_json[claim.KEY]['state'])
        self.assertEqual('synthetic output', row.response)

    def test_celery_terminal_database_failure_retains_returned_evidence(self):
        original = self.repo.update_status
        def fail_completion(repo, job, status, **kwargs):
            if status == claim.JobStatus.COMPLETED:
                raise RuntimeError('synthetic result commit failure')
            return original(repo, job, status, **kwargs)
        generate = MagicMock(return_value=self.response())
        with patch.object(self.repo, 'update_status', new=fail_completion):
            self.run_task(generate)
        self.assertEqual(1, generate.call_count)
        self.assertEqual('failed', self.row().status)
        self.assertEqual('synthetic output', self.row().response)
        self.assertEqual(3, self.row().tokens_in)

    def test_uncommitted_claim_crash_can_be_admitted(self):
        with self.sessions() as db:
            original_commit = db.commit
            with patch.object(db, 'commit', side_effect=RuntimeError('synthetic crash before commit')):
                with self.assertRaises(RuntimeError):
                    claim.admit(db, 1, 'crashed-delivery')
            db.rollback()
        self.assertIsNotNone(self.admit('replacement-delivery'))

    def test_owner_lifetime_is_bounded_even_with_future_expiry(self):
        token = self.admit(now=100)
        with self.sessions() as db:
            row = db.get(Job, 1)
            record = row.runtime_metadata_json[claim.KEY]
            claim.save_claim(row, {**record, 'expires_at': 999999})
            db.commit()
            with self.assertRaises(claim.LostExecutionOwner):
                claim.require_owner(db, 1, token, now=100 + claim.MAX_OWNER_SECONDS)

    @staticmethod
    def response(content='synthetic output'):
        return SimpleNamespace(content=content, tokens_in=3, tokens_out=5, cost=0.0,
                               web_search_used=False, web_search_queries=[], web_sources=[])

    def test_celery_complete_then_duplicate_no_second_execution(self):
        generate = MagicMock(return_value=self.response())
        task, modules, lifecycle, technical = self.run_task(generate)
        with patch.dict(sys.modules, modules):
            task.apply(args=[1], task_id='synthetic-redelivery').get()
        self.assertEqual(1, generate.call_count)
        self.assertEqual('completed', self.row().status)
        self.assertEqual('synthetic output', self.row().response)
        self.assertEqual(3, self.row().tokens_in)
        self.assertEqual(0, self.row().runtime_metadata_json[claim.KEY]['pending_calls'])

    def test_two_celery_deliveries_while_provider_is_live(self):
        entered, release = Event(), Event()
        def generate(**kwargs):
            entered.set()
            self.assertTrue(release.wait(3))
            return self.response()
        provider = MagicMock(side_effect=generate)
        task, modules, lifecycle, technical, owner = self.task(provider)
        with patch.dict(sys.modules, modules), patch.object(claim, 'ExecutionOwnership', owner):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(lambda: task.apply(args=[1], task_id='synthetic-first').get())
                try:
                    self.assertTrue(entered.wait(3))
                    duplicate = pool.submit(lambda: task.apply(args=[1], task_id='synthetic-duplicate').get())
                    duplicate.result(timeout=3)
                    self.assertEqual(1, provider.call_count)
                finally:
                    release.set()
                first.result(timeout=3)
        self.assertEqual(1, len(lifecycle))
        self.assertFalse(lifecycle[0].thread.is_alive())
        self.assertEqual('completed', self.row().status)

    def test_celery_partial_retains_usage_and_response(self):
        self.run_task(MagicMock(return_value=self.response()), partial=True)
        self.assertEqual('partial', self.row().status)
        self.assertEqual(5, self.row().tokens_out)
        self.assertEqual('synthetic output', self.row().response)

    def test_celery_known_validation_failure_is_failed_without_replay(self):
        generate = MagicMock(return_value=self.response(content=''))
        self.run_task(generate)
        self.assertEqual('failed', self.row().status)
        self.assertEqual('finished', self.row().runtime_metadata_json[claim.KEY]['state'])
        self.assertEqual(1, generate.call_count)

    def test_celery_ambiguous_provider_timeout_stays_reconciliation_needed(self):
        generate = MagicMock(side_effect=TimeoutError('synthetic accepted request lost response'))
        task, modules, lifecycle, _ = self.run_task(generate)
        with patch.dict(sys.modules, modules):
            task.apply(args=[1], task_id='synthetic-redelivery').get()
        self.assertEqual(1, generate.call_count)
        self.assertEqual('processing', self.row().status)
        self.assertEqual('reconciliation_needed', self.row().runtime_metadata_json[claim.KEY]['state'])

    def test_celery_cancel_during_generation_wins(self):
        def generate(**kwargs):
            with self.sessions() as db:
                job = db.get(Job, 1)
                job.status = 'failed'
                job.error_message = 'Cancelled by synthetic test'
                db.commit()
            return self.response()
        self.run_task(generate)
        self.assertEqual('failed', self.row().status)
        self.assertEqual('Cancelled by synthetic test', self.row().error_message)
        self.assertIsNone(self.row().response)

if __name__ == '__main__': unittest.main()
