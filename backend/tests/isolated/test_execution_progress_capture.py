"""Actual claim/checkpoint hooks on synthetic persisted rows, no app startup."""
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from sqlalchemy.orm import Session
import test_execution_claim as fixtures
Job, claim = fixtures.Job, fixtures.claim
from app.domains.jobs.execution_progress import capture, receipt_scope


class ProgressCapture(unittest.TestCase):
    setUp = fixtures.Claims.setUp
    tearDown = fixtures.Claims.tearDown

    def test_admission_checkpoint_and_return_timestamps_are_persisted(self):
        token = claim.admit(self.db, 1, 'synthetic-delivery', now=100,
                            receipt_scope='recovery_analysis')
        claim.checkpoint(self.db, 1, token, now=105)
        with patch.object(claim, 'timestamp', return_value=110):
            owner = claim.ExecutionOwnership(lambda: Session(self.engine), 1, token)
            owner.before_call()
        with patch.object(claim, 'timestamp', return_value=115):
            owner.after_call()
        self.db.expire_all()
        record = self.db.get(Job, 1).runtime_metadata_json
        self.assertEqual(record['lineage'], 'synthetic')
        p = record[claim.KEY]['progress']
        self.assertEqual(p['admitted_at'], 100)
        self.assertEqual(p['lease_checkpoint_at'], 105)
        self.assertEqual(p['provider_call_started_at'], 110)
        self.assertEqual(p['provider_call_returned_at'], 115)
        self.assertEqual(p['receipt_scope'], 'recovery_analysis')
        self.assertEqual(record[claim.KEY]['pending_calls'], 0)

    def test_duplicate_terminal_and_stale_owner_cannot_record_progress(self):
        token = claim.admit(self.db, 1, 'a', now=100, receipt_scope='recovery_analysis')
        before = dict(self.db.get(Job, 1).runtime_metadata_json[claim.KEY]['progress'])
        self.assertIsNone(claim.admit(self.db, 1, 'b', now=101))
        with self.assertRaises(claim.LostExecutionOwner):
            claim.checkpoint(self.db, 1, 'foreign-owner', now=102)
        self.assertEqual(self.db.get(Job, 1).runtime_metadata_json[claim.KEY]['progress'], before)
        self.db.get(Job, 1).status = 'completed'
        self.db.commit()
        with self.assertRaises(claim.LostExecutionOwner):
            claim.checkpoint(self.db, 1, token, now=103)
        self.assertEqual(self.db.get(Job, 1).runtime_metadata_json[claim.KEY]['progress'], before)

    def test_previous_attempt_retained_and_legacy_receipt_unknown(self):
        claim.admit(self.db, 1, 'a', now=100, receipt_scope='recovery_analysis')
        claim.admit(self.db, 1, 'b', now=221)
        record = self.db.get(Job, 1).runtime_metadata_json[claim.KEY]
        self.assertEqual(record['previous_attempts'][0]['progress']['admitted_at'], 100)
        self.assertEqual(record['progress']['receipt_scope'], 'unknown')
        self.assertIsNone(capture({'state':'owned'}, 'checkpoint', 10)['progress']['admitted_at'])

    def test_clock_regression_and_invalid_clock_do_not_fabricate_progress(self):
        original = capture({}, 'admitted', 100)
        self.assertEqual(capture(original, 'admitted', 99), original)
        for old in ({'version':2,'retained':'synthetic'}, 'retained-legacy'):
            record = {'progress':old}
            self.assertEqual(capture(record, 'checkpoint', 110), record)
        for now in (float('nan'), float('inf'), -1, True, '100'):
            self.assertEqual(capture(original, 'checkpoint', now), original)

    def test_receipt_scope_requires_actual_delivery_and_isolated_route(self):
        request = SimpleNamespace(id='synthetic', is_eager=False,
                                  delivery_info={'routing_key':'allowed'})
        conf = SimpleNamespace(broker_transport_options={'global_keyprefix':'isolated'})
        task = SimpleNamespace(request=request, app=SimpleNamespace(conf=conf))
        self.assertEqual(receipt_scope(task, recovery=True, queue='allowed', prefix='isolated'),
                         'recovery_analysis')
        for field, value in (('is_eager', True), ('id', None),
                             ('delivery_info', {'routing_key':'foreign'})):
            before = getattr(request, field)
            setattr(request, field, value)
            self.assertEqual(receipt_scope(task, recovery=True, queue='allowed', prefix='isolated'), 'unknown')
            setattr(request, field, before)
        self.assertEqual(receipt_scope(task, recovery=False, queue='allowed', prefix='isolated'), 'unknown')
        conf.broker_transport_options = {'global_keyprefix':'foreign'}
        self.assertEqual(receipt_scope(task, recovery=True, queue='allowed', prefix='isolated'), 'unknown')
