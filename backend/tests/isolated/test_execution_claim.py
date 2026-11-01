"""Synthetic ownership protocol tests; no app bootstrap, provider, Redis or DB URL.

SQLite validates persisted checkpoints; PostgreSQL row locking is inspected below.
Concurrency uses a serialized row-lock double, not a live PostgreSQL acceptance run.
Run: python -m unittest discover -s backend/tests/isolated -p test_execution_claim.py
"""
import importlib.util
from pathlib import Path
import sys
from types import ModuleType
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

from sqlalchemy import create_engine, Integer, JSON, String
from sqlalchemy.orm import DeclarativeBase, mapped_column, Session
from sqlalchemy.dialects import postgresql

class Base(DeclarativeBase):
    pass

class Job(Base):
    __tablename__ = 'jobs'
    id = mapped_column(Integer, primary_key=True)
    status = mapped_column(String)
    runtime_metadata_json = mapped_column(JSON)

spec = importlib.util.spec_from_file_location('isolated_claim', Path(__file__).parents[2] / 'app/domains/jobs/execution_claim.py')
claim = importlib.util.module_from_spec(spec)
model_stub = ModuleType('app.domains.jobs.models')
model_stub.Job = Job
sys.path.insert(0, str(Path(__file__).parents[2]))
with patch.dict(sys.modules, {'app.domains.jobs.models': model_stub}):
    spec.loader.exec_module(claim)

class Claims(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.db.add(Job(id=1, status='pending', runtime_metadata_json={'lineage': 'synthetic'}))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_live_duplicate_and_distinct_identity(self):
        token = claim.admit(self.db, 1, 'delivery-a', now=100)
        self.assertIsNone(claim.admit(self.db, 1, 'delivery-b', now=101))
        row = self.db.get(Job, 1)
        record = row.runtime_metadata_json[claim.KEY]
        self.assertNotEqual(token, record['attempt_id'])
        self.assertEqual('delivery-a', record['delivery_id'])
        self.assertEqual('synthetic', row.runtime_metadata_json['lineage'])

    def test_pre_boundary_expiry_replacement_and_stale_write(self):
        a = claim.admit(self.db, 1, 'a', now=100)
        b = claim.admit(self.db, 1, 'b', now=221)
        self.assertNotEqual(a, b)
        with self.assertRaises(claim.LostExecutionOwner):
            claim.require_owner(self.db, 1, a, now=222)
        claim.checkpoint(self.db, 1, b, now=222)
        self.assertEqual(1, len(self.db.get(Job, 1).runtime_metadata_json[claim.KEY]['previous_attempts']))

    def test_crash_after_provider_intent_no_replay(self):
        a = claim.admit(self.db, 1, 'a', now=100)
        claim.checkpoint(self.db, 1, a, provider_started=True, now=101)
        self.assertIsNone(claim.admit(self.db, 1, 'b', now=222))
        self.assertEqual('reconciliation_needed', self.db.get(Job, 1).runtime_metadata_json[claim.KEY]['state'])

    def test_cancel_wins_and_terminal_redelivery_skips(self):
        a = claim.admit(self.db, 1, 'a', now=100)
        row = self.db.get(Job, 1)
        row.status = claim.JobStatus.FAILED.value
        self.db.commit()
        with self.assertRaises(claim.LostExecutionOwner):
            claim.checkpoint(self.db, 1, a, now=101)
        claim.reconcile(self.db, 1, a)
        self.assertEqual('failed', self.db.get(Job, 1).status)
        self.assertIsNone(claim.admit(self.db, 1, 'b', now=102))

    def test_renewal_is_bounded_and_loss_is_explicit(self):
        a = claim.admit(self.db, 1, 'a', now=100)
        claim.checkpoint(self.db, 1, a, now=200)
        self.assertEqual(320, self.db.get(Job, 1).runtime_metadata_json[claim.KEY]['expires_at'])
        with self.assertRaises(claim.LostExecutionOwner):
            claim.checkpoint(self.db, 1, a, now=321)

    def test_database_failure_before_claim_commit_never_admits(self):
        with patch.object(self.db, 'commit', side_effect=RuntimeError('synthetic commit loss')):
            with self.assertRaises(RuntimeError):
                claim.admit(self.db, 1, 'a', now=100)
        self.db.rollback()
        self.assertNotIn(claim.KEY, self.db.get(Job, 1).runtime_metadata_json)

    def test_concurrent_delivery_serialized_row_double(self):
        row = Job(id=1, status='pending', runtime_metadata_json={})
        lock = Lock()
        class Transaction:
            def commit(self): lock.release()
            def rollback(self): lock.release()
        def locked(db, job_id):
            lock.acquire()
            return row
        with patch.object(claim, 'locked_job', side_effect=locked):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda delivery: claim.admit(Transaction(), 1, delivery, now=100), ['a', 'b']))
        self.assertEqual(1, sum(token is not None for token in results))

    def test_real_repository_fences_terminal_writes(self):
        import ast
        source = (Path(__file__).parents[2] / 'app/domains/jobs/repository.py').read_text()
        node = next(n for n in ast.parse(source).body if isinstance(n, ast.ClassDef) and n.name == 'SyncJobRepository')
        namespace = {'JobStatus': claim.JobStatus}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), node], type_ignores=[])), 'repository.py', 'exec'), namespace)
        settings_stub = ModuleType('app.core.config')
        settings_stub.settings = type('Settings', (), {'recommendation_audit_enabled': False})()
        repo = namespace['SyncJobRepository'](self.db)
        token = claim.admit(self.db, 1, 'a')
        repo.execution_token = 'stale'
        with patch.dict(sys.modules, {'app.domains.jobs.execution_claim': claim, 'app.core.config': settings_stub}):
            with self.assertRaises(claim.LostExecutionOwner):
                repo.update_status(self.db.get(Job, 1), claim.JobStatus.COMPLETED)
            repo.execution_token = token
            repo.update_status(self.db.get(Job, 1), claim.JobStatus.PARTIAL,
                               runtime_metadata_json={'usage': 'synthetic'})
        row = self.db.get(Job, 1)
        self.assertEqual('partial', row.status)
        self.assertEqual('finished', row.runtime_metadata_json[claim.KEY]['state'])
        self.assertEqual('synthetic', row.runtime_metadata_json['usage'])

    def test_postgres_lock_clause(self):
        class Capture:
            def execute(self, stmt):
                self.sql = str(stmt.compile(dialect=postgresql.dialect()))
                return self
            def scalar_one_or_none(self): return None
        db = Capture()
        claim.locked_job(db, 1)
        self.assertIn('FOR UPDATE', db.sql)

if __name__ == '__main__': unittest.main()
