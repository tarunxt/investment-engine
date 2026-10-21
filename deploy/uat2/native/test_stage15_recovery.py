"""Real controller/helper paths with synthetic process boundaries only."""
import unittest
from unittest.mock import patch,MagicMock,Mock
import sqlalchemy as sa
import ctl,schema_service as helper
import test_recovery as baseline

class Stage15Recovery(baseline.RecoveryTests):
    def setUp(self):
        super().setUp();self.receipt['schema_revision']=ctl.STAGE14_REVISION
        self.reference=ctl.backup_reference(self.dump,self.receipt)
        ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate,'previous_source':self.source,'backup':self.reference})
        self.state={'revision':ctl.STAGE15_REVISION,'fingerprint':'e'*64,'stage09_tables':sorted(helper.TABLES),'stage10_tables':sorted(helper.ATTEMPTS),'stage11_columns':sorted(helper.IMPORT_COLUMNS),'stage12_columns':['auto_rebalance_workflows.execution_json'],'stage14_columns':['recommendation_spend_attempts.operation_key'],'stage14_tables':sorted(helper.ORDER_TABLES),'stage15_tables':sorted(helper.EXECUTION_TABLES)}
    def schema(self,release,action,**kwargs):
        self.events.append(action)
        if action==self.failure:raise RuntimeError('synthetic '+action)
        if action=='inspect':return {'state':self.state}
        if action=='preserve':return {'state':self.state,'material':self.saved}
        if action=='downgrade':self.assertEqual(kwargs,{'expected':ctl.STAGE15_REVISION,'target':ctl.STAGE14_REVISION,'fingerprint':self.state['fingerprint'],'material':self.saved})
        if action=='verify':self.assertEqual(kwargs,{'expected':ctl.STAGE14_REVISION,'fingerprint':self.receipt['fingerprint']})
        return {'state':{'revision':ctl.STAGE14_REVISION}}
    def test_partial_order_schema_at_stage14_blocks_restore(self):
        self.state['revision']=ctl.STAGE14_REVISION
        with self.assertRaisesRegex(RuntimeError,'partial schema'):ctl.rollback(str(self.dump))
        self.assertTrue(ctl.pending().exists());self.assertNotIn('restore',self.events)
    def test_cannot_skip_stage14_backup(self):
        self.receipt['schema_revision']=ctl.STAGE13_REVISION;self.reference=ctl.backup_reference(self.dump,self.receipt)
        ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate,'previous_source':self.source,'backup':self.reference})
        with self.assertRaisesRegex(RuntimeError,'Unexpected revision'):ctl.rollback(str(self.dump))
        self.assertNotIn('restore',self.events)

class Stage15Helper(baseline.HelperTests):
    def shape(self, revision=helper.STAGE15, execution=None, names=None):
        names=names if names is not None else helper.TABLES|helper.ATTEMPTS|{helper.IMPORT_TABLE}|set(helper.WORKFLOW_COLUMNS)|set(helper.SPEND_COLUMNS)|helper.ORDER_TABLES|helper.EXECUTION_TABLES
        helper.validate_shape(revision,names,helper.IMPORT_COLUMNS,helper.WORKFLOW_COLUMNS,helper.SPEND_COLUMNS,helper.ORDER_COLUMNS,helper.EXECUTION_COLUMNS if execution is None else execution)
    def test_execution_shape_exact_and_only_stage15(self):
        self.shape()
        with self.assertRaisesRegex(RuntimeError,'execution'):self.shape(revision=helper.STAGE14)
        names=helper.TABLES|helper.ATTEMPTS|{helper.IMPORT_TABLE}|set(helper.WORKFLOW_COLUMNS)|set(helper.SPEND_COLUMNS)|helper.ORDER_TABLES|helper.EXECUTION_TABLES
        for table,columns in helper.EXECUTION_COLUMNS.items():
            with self.subTest(table=table),self.assertRaisesRegex(RuntimeError,'execution'):self.shape(names=names-{table})
            for column in columns:
                with self.subTest(table=table,column=column),self.assertRaisesRegex(RuntimeError,'execution columns'):
                    self.shape(execution={**helper.EXECUTION_COLUMNS,table:columns-{column}})
            with self.assertRaisesRegex(RuntimeError,'execution columns'):
                self.shape(execution={**helper.EXECUTION_COLUMNS,table:columns|{'unexpected'}})
    def test_preservation_includes_orders_and_outbox_spend_bindings(self):
        before={'revision':helper.STAGE15,'fingerprint':'a'*64};engine=MagicMock();seen=[]
        def execute(table):
            seen.append(table);r=Mock();r.mappings.return_value=[{'id':'synthetic'}];return r
        engine.connect.return_value.__enter__.return_value.execute.side_effect=execute
        with patch.object(helper,'capture',side_effect=[before,before]),patch('sqlalchemy.Table',side_effect=lambda name,*a,**k:name),patch('sqlalchemy.select',side_effect=lambda table:table):helper.execute(engine,'preserve','1'*32,helper.STAGE15)
        self.assertEqual(set(seen),helper.EXECUTION_TABLES|helper.ORDER_TABLES|helper.TABLES|helper.ATTEMPTS|{helper.IMPORT_TABLE}|helper.ANALYSIS_MATERIAL|set(helper.SPEND_COLUMNS))
    def test_order_cleanup_atomic_on_failure_and_preserves_stage14_rows(self):
        engine=sa.create_engine('sqlite://')
        with engine.begin() as db:db.exec_driver_sql("ATTACH DATABASE ':memory:' AS public")
        tables={name:sa.Table(name,sa.MetaData(),sa.Column('id',sa.String,primary_key=True),schema='public') for name in [*helper.EXECUTION_TABLES,'confirmed_order_intents']}
        for t in tables.values():
            t.create(engine)
            with engine.begin() as db:db.execute(t.insert().values(id='keep'))
        def fail(target,*,connection):
            self.assertEqual(target,helper.STAGE14);self.assertTrue(connection.in_transaction())
            for name in helper.EXECUTION_TABLES:self.assertEqual(connection.scalar(sa.select(sa.func.count()).select_from(tables[name])),0)
            raise RuntimeError('synthetic failed order DDL')
        try:
            with patch.object(helper,'capture',return_value={'revision':helper.STAGE15,'fingerprint':'a'*64}):
                with self.assertRaisesRegex(RuntimeError,'failed order DDL'):self.execute(engine=engine,expected=helper.STAGE15,target=helper.STAGE14,migrate=fail)
            with engine.connect() as db:
                for t in tables.values():self.assertEqual(db.scalar(sa.select(sa.func.count()).select_from(t)),1)
        finally:engine.dispose()

class Stage15Backup(baseline.ProvenanceTests):
    def test_stage15_backup_checks_exact_manifest(self):
        self.receipt['schema_revision']=ctl.STAGE15_REVISION;self.save();self.assertEqual(ctl.checked_backup(str(self.dump))[2],self.release)
        self.receipt['manifest_sha256']='0'*64;self.save()
        with self.assertRaises(RuntimeError):ctl.checked_backup(str(self.dump))
