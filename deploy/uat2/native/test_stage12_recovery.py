"""Actual controller/helper rollback safeguards; process boundaries are fake."""
import unittest,json
from unittest.mock import Mock,patch,MagicMock
import ctl,schema_service as helper
import test_recovery as baseline

class Stage12Recovery(baseline.RecoveryTests):
    def setUp(self):
        super().setUp()
        self.receipt['schema_revision']=ctl.STAGE11_REVISION
        self.reference=ctl.backup_reference(self.dump,self.receipt)
        ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate,'previous_source':self.source,'backup':self.reference})
        self.state={'revision':ctl.STAGE12_REVISION,'fingerprint':'e'*64,'stage09_tables':sorted(helper.TABLES),'stage10_tables':sorted(helper.ATTEMPTS),'stage11_columns':sorted(helper.IMPORT_COLUMNS),'stage12_columns':['auto_rebalance_workflows.execution_json']}
    def schema(self,release,action,**kwargs):
        self.events.append(action)
        if action==self.failure:raise RuntimeError('synthetic '+action)
        if action=='inspect':return {'state':self.state}
        if action=='preserve':return {'state':self.state,'material':self.saved}
        if action=='downgrade':self.assertEqual(kwargs,{'expected':ctl.STAGE12_REVISION,'target':ctl.STAGE11_REVISION,'fingerprint':self.state['fingerprint'],'material':self.saved})
        if action=='verify':self.assertEqual(kwargs,{'expected':ctl.STAGE11_REVISION,'fingerprint':self.receipt['fingerprint']})
        return {'state':{'revision':ctl.STAGE11_REVISION}}
    def test_partial_workflow_columns_at_baseline_stop_before_restore(self):
        self.state['revision']=ctl.STAGE11_REVISION
        with self.assertRaisesRegex(RuntimeError,'partial schema'):ctl.rollback(str(self.dump))
        self.assertNotIn('restore',self.events);self.assertTrue(ctl.pending().exists())
    def test_cannot_skip_stage11_recovery_baseline(self):
        self.receipt['schema_revision']=ctl.STAGE10_REVISION;self.reference=ctl.backup_reference(self.dump,self.receipt)
        ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate,'previous_source':self.source,'backup':self.reference})
        with self.assertRaisesRegex(RuntimeError,'Unexpected revision'):ctl.rollback(str(self.dump))
        self.assertNotIn('restore',self.events)

class Stage12Helper(baseline.HelperTests):
    def test_exact_workflow_shape_and_reject_partial_or_historical_additions(self):
        names=helper.TABLES|helper.ATTEMPTS|{helper.IMPORT_TABLE}|set(helper.WORKFLOW_COLUMNS)
        helper.validate_shape(helper.STAGE12,names,helper.IMPORT_COLUMNS,helper.WORKFLOW_COLUMNS)
        for table,columns in helper.WORKFLOW_COLUMNS.items():
            for column in columns:
                partial={**helper.WORKFLOW_COLUMNS,table:columns-{column}}
                with self.assertRaisesRegex(RuntimeError,'workflow'):helper.validate_shape(helper.STAGE12,names,helper.IMPORT_COLUMNS,partial)
        with self.assertRaisesRegex(RuntimeError,'workflow'):helper.validate_shape(helper.STAGE11,names,helper.IMPORT_COLUMNS,helper.WORKFLOW_COLUMNS)
    def test_exact_stage12_downgrade_preserves_stage11(self):
        before={'revision':helper.STAGE12,'fingerprint':'a'*64}
        after={'revision':helper.STAGE11,'fingerprint':'b'*64,'stage09_tables':sorted(helper.TABLES),'stage10_tables':sorted(helper.ATTEMPTS),'stage11_columns':sorted(helper.IMPORT_COLUMNS),'stage12_columns':[]}
        migrate=Mock()
        with patch.object(helper,'capture',side_effect=[before,after]):self.assertEqual(self.execute(expected=helper.STAGE12,target=helper.STAGE11,migrate=migrate),{'state':after})
        migrate.assert_called_once_with(helper.STAGE11)
        for bad in [None,helper.STAGE10,helper.BASE]:
            migrate=Mock()
            with patch.object(helper,'capture',return_value=before),self.assertRaises(RuntimeError):self.execute(expected=helper.STAGE12,target=bad,migrate=migrate)
            migrate.assert_not_called()
        for field,value in [('stage12_columns',['execution_json']),('stage11_columns',[]),('stage10_tables',[])]:
            with patch.object(helper,'capture',side_effect=[before,{**after,field:value}]),self.assertRaisesRegex(RuntimeError,'incomplete'):self.execute(expected=helper.STAGE12,target=helper.STAGE11)
    def test_preservation_includes_all_workflow_inputs_attempts_and_checkpoints(self):
        before={'revision':helper.STAGE12,'fingerprint':'a'*64};engine=MagicMock();seen=[]
        def execute(table):
            seen.append(table);result=Mock();result.mappings.return_value=[{'id':1,'execution_json':{'synthetic':True},'checkpoint_json':{'attempts':[{'number':1}]}}];return result
        engine.connect.return_value.__enter__.return_value.execute.side_effect=execute
        with patch.object(helper,'capture',side_effect=[before,before]),patch('sqlalchemy.Table',side_effect=lambda name,*a,**k:name),patch('sqlalchemy.select',side_effect=lambda table:table):
            result=helper.execute(engine,'preserve','1'*32,helper.STAGE12)
        expected=helper.TABLES|helper.ATTEMPTS|{helper.IMPORT_TABLE}|helper.ANALYSIS_MATERIAL
        self.assertEqual(set(seen),expected)
        material=json.loads((helper.ARTIFACTS/('1'*32+'-material.json')).read_text())
        self.assertIn('checkpoint_json',material['tables']['auto_rebalance_workflow_stages'][0])
        self.assertEqual(result['material']['rows'],len(expected))

class Stage12Backup(baseline.ProvenanceTests):
    def test_same_stage12_private_backup_supported_with_manifest_required(self):
        self.receipt['schema_revision']=ctl.STAGE12_REVISION;self.save();self.assertEqual(ctl.checked_backup(str(self.dump))[2],self.release)
        self.receipt['manifest_sha256']='0'*64;self.save()
        with self.assertRaises(RuntimeError):ctl.checked_backup(str(self.dump))
