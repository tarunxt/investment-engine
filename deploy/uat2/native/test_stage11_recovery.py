"""Local actual controller/helper tests, with declared synthetic process boundaries."""
import unittest,json
from unittest.mock import Mock,patch
import ctl
import schema_service as helper
import test_recovery as baseline

class Stage11Recovery(baseline.RecoveryTests):
    def setUp(self):
        super().setUp();self.receipt['schema_revision']=ctl.STAGE10_REVISION
        self.reference=ctl.backup_reference(self.dump,self.receipt)
        ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate,'previous_source':self.source,'backup':self.reference})
        self.state={'revision':ctl.STAGE11_REVISION,'fingerprint':'e'*64,'stage09_tables':sorted(helper.TABLES),'stage10_tables':sorted(helper.ATTEMPTS),'stage11_columns':sorted(helper.IMPORT_COLUMNS)}
    def schema(self,release,action,**kwargs):
        self.events.append(action)
        if action==self.failure:raise RuntimeError('synthetic '+action)
        if action=='inspect':return {'state':self.state}
        if action=='preserve':return {'state':self.state,'material':self.saved}
        if action=='downgrade':self.assertEqual(kwargs,{'expected':ctl.STAGE11_REVISION,'target':ctl.STAGE10_REVISION,'fingerprint':self.state['fingerprint'],'material':self.saved})
        if action=='verify':self.assertEqual(kwargs,{'expected':ctl.STAGE10_REVISION,'fingerprint':self.receipt['fingerprint']})
        return {'state':{'revision':ctl.STAGE10_REVISION}}
    def test_no_skipping_stage10_rollback_baseline(self):
        for revision in [ctl.BASE_REVISION,ctl.STAGE09_REVISION]:
            ctl.pending().unlink(missing_ok=True);self.events=[];self.receipt['schema_revision']=revision;self.reference=ctl.backup_reference(self.dump,self.receipt)
            ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate,'previous_source':self.source,'backup':self.reference})
            with self.assertRaisesRegex(RuntimeError,'Unexpected revision'):ctl.rollback(str(self.dump))
            self.assertNotIn('restore',self.events)
    def test_partial_import_columns_at_baseline_fail_closed(self):
        self.state['revision']=ctl.STAGE10_REVISION
        with self.assertRaisesRegex(RuntimeError,'partial schema'):ctl.rollback(str(self.dump))
        self.assertTrue(ctl.pending().exists());self.assertNotIn('restore',self.events)

class Stage11Helper(baseline.HelperTests):
    def test_exact_import_schema_shape_and_prior_states(self):
        names=helper.TABLES|helper.ATTEMPTS|{helper.IMPORT_TABLE}
        helper.validate_shape(helper.STAGE11,names,helper.IMPORT_COLUMNS)
        helper.validate_shape(helper.STAGE10,names,set())
        for revision,columns in [(helper.STAGE11,helper.IMPORT_COLUMNS-{'content_hash'}),(helper.STAGE10,{'content_hash'}),(helper.STAGE09,helper.IMPORT_COLUMNS),('unknown',set())]:
            with self.assertRaises(RuntimeError):helper.validate_shape(revision,names,columns)
    def test_exact_stage11_downgrade_and_private_preservation_hash(self):
        before={'revision':helper.STAGE11,'fingerprint':'a'*64,'stage09_tables':sorted(helper.TABLES),'stage10_tables':sorted(helper.ATTEMPTS),'stage11_columns':sorted(helper.IMPORT_COLUMNS)}
        after={**before,'revision':helper.STAGE10,'stage11_columns':[]}
        migrate=Mock()
        with patch.object(helper,'capture',side_effect=[before,after]):self.assertEqual(self.execute(expected=helper.STAGE11,target=helper.STAGE10,migrate=migrate),{'state':after})
        migrate.assert_called_once_with(helper.STAGE10)
        for target in [None,helper.BASE,helper.STAGE09]:
            migrate=Mock()
            with patch.object(helper,'capture',return_value=before),self.assertRaises(RuntimeError):self.execute(expected=helper.STAGE11,target=target,migrate=migrate)
            migrate.assert_not_called()
        with patch.object(helper,'capture',return_value=before),self.assertRaises(RuntimeError):self.execute(expected=helper.STAGE11,target=helper.STAGE10,material_sha='0'*64)
        with patch.object(helper,'capture',side_effect=[before,{**after,'stage11_columns':['content_hash']}]),self.assertRaisesRegex(RuntimeError,'incomplete'):self.execute(expected=helper.STAGE11,target=helper.STAGE10)

class Stage11Backup(baseline.ProvenanceTests):
    def test_same_stage11_backup_provenance_supported(self):
        self.receipt['schema_revision']=ctl.STAGE11_REVISION;self.save();self.assertEqual(ctl.checked_backup(str(self.dump))[2],self.release)
        self.receipt['manifest_sha256']='0'*64;self.save()
        with self.assertRaises(RuntimeError):ctl.checked_backup(str(self.dump))

class Stage11PrivateMaterial(baseline.HelperTests):
    def test_preserves_full_import_payload_before_removing_provenance_columns(self):
        from unittest.mock import MagicMock
        before={'revision':helper.STAGE11,'fingerprint':'a'*64}
        engine=MagicMock();seen=[]
        def execute(table):
            seen.append(table);result=Mock();result.mappings.return_value=[{'id':1,'raw_text':'SYNTHETIC ONLY','import_provenance':{'source_hash':'synthetic'}}];return result
        engine.connect.return_value.__enter__.return_value.execute.side_effect=execute
        with patch.object(helper,'capture',side_effect=[before,before]),patch('sqlalchemy.Table',side_effect=lambda name,*a,**k:name),patch('sqlalchemy.select',side_effect=lambda table:table):
            result=helper.execute(engine,'preserve','1'*32,helper.STAGE11)
        self.assertEqual(set(seen),helper.TABLES|helper.ATTEMPTS|{helper.IMPORT_TABLE})
        material=json.loads((helper.ARTIFACTS/('1'*32+'-material.json')).read_text())
        self.assertIn('import_provenance',material['tables'][helper.IMPORT_TABLE][0]);self.assertEqual(result['material']['rows'],5)
        self.assertEqual((helper.ARTIFACTS/('1'*32+'-material.json')).stat().st_mode&0o777,0o600)

class SameStage11Recovery(unittest.TestCase):
    setUp=baseline.RecoveryTests.setUp
    service=baseline.RecoveryTests.service
    process=baseline.RecoveryTests.process
    def schema(self,release,action,**kwargs):
        self.events.append(action)
        state={'revision':ctl.STAGE11_REVISION,'fingerprint':'e'*64,'stage09_tables':sorted(helper.TABLES),'stage10_tables':sorted(helper.ATTEMPTS),'stage11_columns':sorted(helper.IMPORT_COLUMNS)}
        if action=='preserve':return {'state':state,'material':self.saved}
        if action=='verify':self.assertEqual(kwargs,{'expected':ctl.STAGE11_REVISION,'fingerprint':self.receipt['fingerprint']})
        return {'state':state}
    def test_same_stage11_schema_preserves_imports_without_downgrade(self):
        self.receipt['schema_revision']=ctl.STAGE11_REVISION;self.reference=ctl.backup_reference(self.dump,self.receipt)
        ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate,'previous_source':self.source,'backup':self.reference})
        ctl.rollback(str(self.dump))
        self.assertEqual([e for e in self.events if isinstance(e,str)],['inspect','preserve','restore','verify'])
        self.assertFalse(ctl.pending().exists())
