"""Stage10 exercises actual controller state machine; boundaries are synthetic."""
import json
import unittest
from unittest.mock import Mock,patch
import ctl
import test_recovery as baseline

class Stage10RecoveryTests(baseline.RecoveryTests):
    def setUp(self):
        super().setUp()
        self.receipt['schema_revision']=ctl.STAGE09_REVISION
        self.reference=ctl.backup_reference(self.dump,self.receipt)
        ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate,'previous_source':self.source,'backup':self.reference})
        self.state={'revision':ctl.STAGE10_REVISION,'fingerprint':'e'*64,'stage09_tables':['integration_connections','connection_credentials'],'stage10_tables':['connection_attempts']}

    def schema(self,release,action,**kwargs):
        self.events.append(action)
        if action==self.failure:raise RuntimeError('synthetic '+action)
        if action=='inspect':return {'state':self.state}
        if action=='preserve':return {'state':self.state,'material':self.saved}
        if action=='downgrade':
            self.assertEqual(kwargs,{'expected':ctl.STAGE10_REVISION,'target':ctl.STAGE09_REVISION,'fingerprint':self.state['fingerprint'],'material':self.saved})
            self.assertEqual(ctl.private_json(ctl.pending())['material'],self.saved)
        if action=='verify':self.assertEqual(kwargs,{'expected':ctl.STAGE09_REVISION,'fingerprint':self.receipt['fingerprint']})
        return {'state':{'revision':ctl.STAGE09_REVISION}}

    def test_stage10_cannot_restore_stage08_backup_or_skip_revision(self):
        self.receipt['schema_revision']=ctl.BASE_REVISION
        self.reference=ctl.backup_reference(self.dump,self.receipt)
        ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate,'previous_source':self.source,'backup':self.reference})
        with self.assertRaisesRegex(RuntimeError,'Unexpected revision'):ctl.rollback(str(self.dump))
        self.assertNotIn('restore',self.events);self.assertTrue(ctl.pending().exists())

    def test_partial_attempt_table_at_baseline_stays_stopped(self):
        self.state['revision']=ctl.STAGE09_REVISION
        with self.assertRaisesRegex(RuntimeError,'partial schema'):ctl.rollback(str(self.dump))
        self.assertNotIn('restore',self.events);self.assertTrue(ctl.pending().exists())

class Stage10HelperTests(baseline.HelperTests):
    def test_stage10_requires_exact_target_and_preserved_hash(self):
        before={'revision':self.helper.STAGE10,'fingerprint':'a'*64,'stage09_tables':sorted(self.helper.TABLES),'stage10_tables':['connection_attempts']}
        after={'revision':self.helper.STAGE09,'fingerprint':'b'*64,'stage09_tables':sorted(self.helper.TABLES),'stage10_tables':[]}
        for target in [None,self.helper.BASE,'unknown']:
            migrate=Mock()
            with patch.object(self.helper,'capture',return_value=before),self.assertRaises(RuntimeError):
                self.execute(expected=self.helper.STAGE10,target=target,migrate=migrate)
            migrate.assert_not_called()
        migrate=Mock()
        with patch.object(self.helper,'capture',side_effect=[before,after]):
            self.assertEqual(self.execute(expected=self.helper.STAGE10,target=self.helper.STAGE09,migrate=migrate),{'state':after})
        migrate.assert_called_once_with(self.helper.STAGE09)
        with patch.object(self.helper,'capture',return_value=before),self.assertRaises(RuntimeError):
            self.execute(expected=self.helper.STAGE10,target=self.helper.STAGE09,material_sha='0'*64)

    def test_stage10_partial_downgrade_and_wrong_fingerprint_rejected(self):
        before={'revision':self.helper.STAGE10,'fingerprint':'a'*64,'stage09_tables':sorted(self.helper.TABLES),'stage10_tables':['connection_attempts']}
        after={'revision':self.helper.STAGE09,'fingerprint':'b'*64,'stage09_tables':sorted(self.helper.TABLES),'stage10_tables':['connection_attempts']}
        with patch.object(self.helper,'capture',side_effect=[before,after]),self.assertRaisesRegex(RuntimeError,'incomplete'):
            self.execute(expected=self.helper.STAGE10,target=self.helper.STAGE09)
        with patch.object(self.helper,'capture',return_value={**after,'stage10_tables':[]}),self.assertRaises(RuntimeError):
            self.execute(action='verify',expected=self.helper.STAGE09,fingerprint='wrong')

class Stage10ProvenanceTests(baseline.ProvenanceTests):
    def test_stage09_backup_is_accepted_with_unchanged_provenance_checks(self):
        self.receipt['schema_revision']=ctl.STAGE09_REVISION;self.save()
        self.assertEqual(ctl.checked_backup(str(self.dump))[2],self.release)
        self.receipt['manifest_sha256']='0'*64;self.save()
        with self.assertRaisesRegex(RuntimeError,'provenance'):ctl.checked_backup(str(self.dump))

class SameRevisionRecoveryTests(unittest.TestCase):
    setUp=baseline.RecoveryTests.setUp
    schema=baseline.RecoveryTests.schema
    service=baseline.RecoveryTests.service
    process=baseline.RecoveryTests.process
    def test_same_stage10_revision_preserves_material_without_downgrade(self):
        self.receipt['schema_revision']=ctl.STAGE10_REVISION
        self.reference=ctl.backup_reference(self.dump,self.receipt)
        ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate,'previous_source':self.source,'backup':self.reference})
        def schema(release,action,**kwargs):
            if action=='verify':self.assertEqual(kwargs['expected'],ctl.STAGE10_REVISION)
            return {'state':{'revision':ctl.STAGE10_REVISION,'stage09_tables':['integration_connections','connection_credentials'],'stage10_tables':['connection_attempts','connection_binding_history']},'material':self.saved}
        with patch.object(ctl,'schema_operation',side_effect=schema) as operations:
            ctl.rollback(str(self.dump))
            self.assertEqual([call.args[1] for call in operations.call_args_list],['inspect','preserve','verify'])
        self.assertFalse(ctl.pending().exists())
