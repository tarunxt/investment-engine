"""Actual recovery controller/helper safeguards; no host or DB operations."""
import unittest,json
from unittest.mock import Mock,patch,MagicMock
import ctl,schema_service as helper
import test_recovery as baseline


class Stage13Recovery(baseline.RecoveryTests):
    def setUp(self):
        super().setUp();self.receipt['schema_revision']=ctl.STAGE12_REVISION
        self.reference=ctl.backup_reference(self.dump,self.receipt)
        ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate,'previous_source':self.source,'backup':self.reference})
        self.state={'revision':ctl.STAGE13_REVISION,'fingerprint':'e'*64,'stage09_tables':sorted(helper.TABLES),'stage10_tables':sorted(helper.ATTEMPTS),'stage11_columns':sorted(helper.IMPORT_COLUMNS),'stage12_columns':['auto_rebalance_workflows.execution_json'],'stage13_columns':['recommendation_spend_attempts.operation_key']}
    def schema(self,release,action,**kwargs):
        self.events.append(action)
        if action==self.failure:raise RuntimeError('synthetic '+action)
        if action=='inspect':return {'state':self.state}
        if action=='preserve':return {'state':self.state,'material':self.saved}
        if action=='downgrade':self.assertEqual(kwargs,{'expected':ctl.STAGE13_REVISION,'target':ctl.STAGE12_REVISION,'fingerprint':self.state['fingerprint'],'material':self.saved})
        if action=='verify':self.assertEqual(kwargs,{'expected':ctl.STAGE12_REVISION,'fingerprint':self.receipt['fingerprint']})
        return {'state':{'revision':ctl.STAGE12_REVISION}}
    def test_partial_spend_columns_at_baseline_cannot_restore(self):
        self.state['revision']=ctl.STAGE12_REVISION
        with self.assertRaisesRegex(RuntimeError,'partial schema'):ctl.rollback(str(self.dump))
        self.assertTrue(ctl.pending().exists());self.assertNotIn('restore',self.events)
    def test_cannot_skip_stage12_backup(self):
        self.receipt['schema_revision']=ctl.STAGE11_REVISION;self.reference=ctl.backup_reference(self.dump,self.receipt)
        ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate,'previous_source':self.source,'backup':self.reference})
        with self.assertRaisesRegex(RuntimeError,'Unexpected revision'):ctl.rollback(str(self.dump))
        self.assertNotIn('restore',self.events)


class Stage13Helper(baseline.HelperTests):
    def test_partial_and_historical_spend_schema_rejected(self):
        names=helper.TABLES|helper.ATTEMPTS|{helper.IMPORT_TABLE}|set(helper.WORKFLOW_COLUMNS)|set(helper.SPEND_COLUMNS)
        helper.validate_shape(helper.STAGE13,names,helper.IMPORT_COLUMNS,helper.WORKFLOW_COLUMNS,helper.SPEND_COLUMNS)
        for table,columns in helper.SPEND_COLUMNS.items():
            for column in columns:
                with self.subTest(table=table,column=column):
                    with self.assertRaisesRegex(RuntimeError,'spend'):helper.validate_shape(helper.STAGE13,names,helper.IMPORT_COLUMNS,helper.WORKFLOW_COLUMNS,{**helper.SPEND_COLUMNS,table:columns-{column}})
        with self.assertRaisesRegex(RuntimeError,'spend'):helper.validate_shape(helper.STAGE12,names,helper.IMPORT_COLUMNS,helper.WORKFLOW_COLUMNS,helper.SPEND_COLUMNS)
    def test_preserve_all_budget_and_export_evidence(self):
        before={'revision':helper.STAGE13,'fingerprint':'a'*64};engine=MagicMock();seen=[]
        def execute(table):
            seen.append(table);r=Mock();r.mappings.return_value=[{'id':1,'synthetic':True}];return r
        engine.connect.return_value.__enter__.return_value.execute.side_effect=execute
        with patch.object(helper,'capture',side_effect=[before,before]),patch('sqlalchemy.Table',side_effect=lambda name,*a,**k:name),patch('sqlalchemy.select',side_effect=lambda table:table):
            result=helper.execute(engine,'preserve','1'*32,helper.STAGE13)
        self.assertEqual(set(seen),helper.TABLES|helper.ATTEMPTS|{helper.IMPORT_TABLE}|helper.ANALYSIS_MATERIAL|set(helper.SPEND_COLUMNS))
        self.assertEqual(result['material']['rows'],len(seen))
    def test_wrong_target_or_fingerprint_cannot_start_cleanup(self):
        before={'revision':helper.STAGE13,'fingerprint':'a'*64};engine=Mock()
        for target,fingerprint in [(helper.STAGE11,'a'*64),(helper.STAGE12,'b'*64),(None,'a'*64)]:
            with self.subTest(target=target,fingerprint=fingerprint),patch.object(helper,'capture',return_value=before):
                with self.assertRaisesRegex(RuntimeError,'Exact supported'):helper.execute(engine,'downgrade','1'*32,helper.STAGE13,fingerprint,'2'*32,'3'*64,Mock(),target)
        engine.begin.assert_not_called()

    def test_guarded_cleanup_preserves_legacy_attempts_before_migrate(self):
        import sqlalchemy as sa
        engine=sa.create_engine('sqlite://')
        with engine.begin() as db:db.exec_driver_sql("ATTACH DATABASE ':memory:' AS public")
        table=sa.Table('recommendation_spend_attempts',sa.MetaData(),sa.Column('id',sa.String,primary_key=True),sa.Column('verification_id',sa.String),sa.Column('operation_key',sa.String),schema='public')
        table.create(engine)
        with engine.begin() as db:
            db.execute(table.insert(),[{'id':'legacy','verification_id':'old-verification','operation_key':None},{'id':'new','verification_id':None,'operation_key':'stage13-op'}])
        before={'revision':helper.STAGE13,'fingerprint':'a'*64}
        after={'revision':helper.STAGE12,'fingerprint':'b'*64,'stage09_tables':sorted(helper.TABLES),'stage10_tables':sorted(helper.ATTEMPTS),'stage11_columns':sorted(helper.IMPORT_COLUMNS),'stage12_columns':['execution_json'],'stage13_columns':[]}
        def migrate(target):
            self.assertEqual(target,helper.STAGE12)
            with engine.connect() as db:self.assertEqual(list(db.execute(sa.select(table.c.id)).scalars()),['legacy'])
        try:
            with patch.object(helper,'capture',side_effect=[before,after]):
                self.assertEqual(self.execute(engine=engine,expected=helper.STAGE13,target=helper.STAGE12,migrate=migrate),{'state':after})
        finally:engine.dispose()


class Stage13Backup(baseline.ProvenanceTests):
    def test_stage13_backup_requires_exact_release_manifest(self):
        self.receipt['schema_revision']=ctl.STAGE13_REVISION;self.save();self.assertEqual(ctl.checked_backup(str(self.dump))[2],self.release)
        self.receipt['manifest_sha256']='0'*64;self.save()
        with self.assertRaises(RuntimeError):ctl.checked_backup(str(self.dump))
