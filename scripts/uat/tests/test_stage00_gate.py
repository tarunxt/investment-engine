import copy
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from stage00_gate import REQUIRED, evaluate
SHA = 'a' * 40

class Stage00GateTests(unittest.TestCase):
    def receipt(self, architecture='approved-dedicated-host'):
        extra = 'dedicated_host_capacity' if architecture == 'approved-dedicated-host' else 'representative_shared_host_headroom'
        return dict(source_sha=SHA, architecture=architecture,
                    target_instance='i-0dea5617814f8b351' if architecture == 'approved-dedicated-host' else 'i-0b8ad0aebce8510cb',
                    architecture_approval_reference='owner approval receipt',
                    checks={k:dict(status='PASS', observed_epoch=1000, evidence_reference='synthetic-test-fixture') for k in (*REQUIRED, extra)})
    def test_regressions_cannot_replace_missing_live_gates(self):
        r=self.receipt();r['checks']['five_actual_fault_tests']['status']='UNVERIFIED'
        result=evaluate(r, expected_sha=SHA, now=1001)
        self.assertEqual(result['status'],'BLOCKED')
        self.assertIn('five_actual_fault_tests',result['failed_or_stale'])
    def test_dedicated_pass_never_claims_existing_server_or_authorizes_stage01(self):
        r=evaluate(self.receipt(),expected_sha=SHA,now=1001)
        self.assertEqual(r['status'],'EVIDENCE_REVIEW_READY')
        self.assertFalse(r['existing_server_implemented']);self.assertFalse(r['stage01_authorized'])
    def test_existing_server_requires_representative_headroom(self):
        r=self.receipt('existing-server');r['checks']['representative_shared_host_headroom']['status']='FAIL'
        self.assertEqual(evaluate(r,expected_sha=SHA,now=1001)['status'],'BLOCKED')
    def test_missing_receipts_and_wrong_source_or_architecture_fail_closed(self):
        variants=[]
        for key in ['private_runtime_acceptance','tls_chain_host_sni','real_google_owner_acceptance']:
            r=self.receipt();del r['checks'][key];variants.append(r)
        r=self.receipt();r['source_sha']='b'*40;variants.append(r)
        r=self.receipt();r['architecture_approval_reference']='';variants.append(r)
        r=self.receipt();r['target_instance']='production';variants.append(r)
        for r in variants:
            with self.subTest(r=r),self.assertRaises(ValueError):evaluate(r,expected_sha=SHA,now=1001)
    def test_stale_future_and_nonfinite_evidence_rejected(self):
        for t in [-10000,1002,float('nan'),True]:
            r=self.receipt();r['checks']['cleanup_and_rollback']['observed_epoch']=t
            if isinstance(t,bool) or (isinstance(t,float) and t!=t):
                with self.assertRaises(ValueError):evaluate(r,expected_sha=SHA,now=1001)
            else:self.assertEqual(evaluate(r,expected_sha=SHA,now=1001)['status'],'BLOCKED')
    def test_bool_pass_and_empty_evidence_do_not_count(self):
        r=self.receipt();r['checks']['tls_chain_host_sni']['status']=True
        self.assertEqual(evaluate(r,expected_sha=SHA,now=1001)['status'],'BLOCKED')
        r=self.receipt();r['checks']['tls_chain_host_sni']['evidence_reference']=''
        with self.assertRaises(ValueError):evaluate(r,expected_sha=SHA,now=1001)
