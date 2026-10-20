"""Actual controller paths with synthetic filesystem/process boundaries only."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).parent))
import ctl


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.source='a'*40;self.candidate='b'*40
        self.target=self.root/'releases'/self.source;self.target.mkdir(parents=True)
        self.dump=self.root/'backup.dump';self.dump.write_bytes(b'synthetic dump')
        self.receipt={'sha256':'c'*64,'source_commit':self.source,'schema_revision':ctl.BASE_REVISION,'fingerprint':'d'*64}
        self.reference=ctl.backup_reference(self.dump,self.receipt)
        ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate,'previous_source':self.source,'backup':self.reference})
        self.events=[];self.failure=None
        self.state={'revision':ctl.STAGE09_REVISION,'fingerprint':'e'*64,'stage09_tables':['integration_connections','connection_credentials']}
        self.saved={'request':'f'*32,'sha256':'9'*64,'rows':4}
        for name,value in [('ROOT',self.root),('checked_backup',Mock(return_value=(self.dump,self.receipt,self.target))),('current',Mock(return_value=self.root/'releases'/self.candidate)),('require_apps_stopped',Mock()),('configure_units',Mock()),('promote',Mock()),('readiness',Mock()),('schema_operation',Mock(side_effect=self.schema)),('systemctl',Mock(side_effect=self.service))]:
            p=patch.object(ctl,name,value);p.start();self.addCleanup(p.stop)
        p=patch.object(ctl.subprocess,'run',side_effect=self.process);p.start();self.addCleanup(p.stop)

    def service(self,action,names):
        self.events.append((action,names))
        if action=='stop':self.assertTrue(ctl.pending().exists(),'marker must precede first stop')

    def schema(self,release,action,**kwargs):
        self.events.append(action)
        if action==self.failure:raise RuntimeError('synthetic '+action)
        if action=='inspect':return {'state':self.state}
        if action=='preserve':return {'state':self.state,'material':self.saved}
        if action=='downgrade':
            self.assertEqual(kwargs,{'expected':ctl.STAGE09_REVISION,'fingerprint':self.state['fingerprint'],'material':self.saved})
            self.assertEqual(ctl.private_json(ctl.pending())['material'],self.saved)
        if action=='verify':self.assertEqual(kwargs,{'expected':ctl.BASE_REVISION,'fingerprint':self.receipt['fingerprint']})
        return {'state':{'revision':ctl.BASE_REVISION}}

    def process(self,args,**kwargs):
        self.events.append('restore')
        self.assertIn('--single-transaction',args)
        self.assertEqual(ctl.private_json(ctl.pending())['phase'],'restore_started')
        if self.failure=='crash':raise KeyboardInterrupt('synthetic interruption')
        return Mock(returncode=int(self.failure=='restore'))

    def test_success_preserves_downgrades_restores_verifies_before_start(self):
        ctl.rollback(str(self.dump))
        self.assertEqual([e for e in self.events if isinstance(e,str)],['inspect','preserve','downgrade','restore','verify'])
        ctl.promote.assert_called_once_with(self.target);ctl.readiness.assert_called_once()
        self.assertFalse(ctl.pending().exists())

    def test_failures_keep_marker_and_never_promote_or_start(self):
        for failure in ['inspect','preserve','downgrade','restore','verify','crash']:
            with self.subTest(failure=failure):
                ctl.pending().unlink(missing_ok=True);self.events.clear();self.failure=failure
                with self.assertRaises((RuntimeError,KeyboardInterrupt)):ctl.rollback(str(self.dump))
                self.assertTrue(ctl.pending().exists());ctl.promote.assert_not_called();ctl.readiness.assert_not_called()
                self.assertFalse(any(isinstance(e,tuple) and e[0]=='start' for e in self.events))

    def test_unknown_or_partial_revision_never_restores(self):
        self.state={'revision':'unknown','stage09_tables':[]}
        with self.assertRaises(RuntimeError):ctl.rollback(str(self.dump))
        self.assertNotIn('restore',self.events);ctl.promote.assert_not_called()

    def test_interrupted_operation_refuses_blind_retry_then_verifies_only(self):
        self.failure='crash'
        with self.assertRaises(KeyboardInterrupt):ctl.rollback(str(self.dump))
        self.events.clear()
        with self.assertRaisesRegex(RuntimeError,'no blind retry'):ctl.rollback(str(self.dump))
        self.assertEqual(self.events,[])
        self.failure=None;ctl.rollback(str(self.dump),recover_only=True)
        self.assertEqual([e for e in self.events if isinstance(e,str)],['verify'])
        self.assertFalse(ctl.pending().exists())

    def test_recovery_verification_failure_stays_blocked(self):
        self.failure='restore'
        with self.assertRaises(RuntimeError):ctl.rollback(str(self.dump))
        self.failure='verify';self.events.clear()
        with self.assertRaises(RuntimeError):ctl.rollback(str(self.dump),recover_only=True)
        self.assertTrue(ctl.pending().exists());ctl.promote.assert_not_called()
        self.assertNotIn('restore',self.events)

    def test_wrong_backup_context_fails_before_stop(self):
        self.receipt['sha256']='0'*64
        with self.assertRaisesRegex(RuntimeError,'recorded pre-deployment'):ctl.rollback(str(self.dump))
        self.assertEqual(self.events,[]);self.assertFalse(ctl.pending().exists())

    def test_pending_marker_blocks_start(self):
        ctl.durable_json(ctl.pending(),{'operation':'rollback'})
        with patch.object(ctl,'host_guard'),patch.object(ctl,'acquire_lock'),patch.object(ctl,'validate'),patch.object(sys,'argv',['ctl','start']):
            with self.assertRaisesRegex(RuntimeError,'Unfinished deployment'):ctl.main()
        self.assertEqual(self.events,[])


class HelperTests(unittest.TestCase):
    def setUp(self):
        import schema_service
        self.helper=schema_service
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        p=patch.object(schema_service,'ARTIFACTS',Path(self.tmp.name));p.start();self.addCleanup(p.stop)
        self.before={'revision':schema_service.STAGE09,'fingerprint':'a'*64,'stage09_tables':sorted(schema_service.TABLES)}
        self.after={'revision':schema_service.BASE,'fingerprint':'b'*64,'stage09_tables':[]}
        self.request='c'*32;self.material='d'*32
        self.hash=schema_service.private_write(Path(self.tmp.name)/(self.material+'-material.json'),{'synthetic':'ciphertext'})

    def execute(self,**overrides):
        values=dict(engine=Mock(),action='downgrade',request=self.request,expected=self.helper.STAGE09,fingerprint='a'*64,material_request=self.material,material_sha=self.hash,migrate=Mock())
        values.update(overrides)
        return self.helper.execute(**values)

    def test_exact_downgrade_and_postcondition(self):
        migrate=Mock()
        with patch.object(self.helper,'capture',side_effect=[self.before,self.after]):
            self.assertEqual(self.execute(migrate=migrate),{'state':self.after})
        migrate.assert_called_once_with(self.helper.BASE)

    def test_material_or_state_mismatch_never_downgrades(self):
        for overrides in [{'material_sha':'0'*64},{'fingerprint':'0'*64},{'expected':self.helper.BASE}]:
            migrate=Mock()
            with patch.object(self.helper,'capture',return_value=self.before),self.assertRaises(RuntimeError):self.execute(migrate=migrate,**overrides)
            migrate.assert_not_called()

    def test_downgrade_failure_and_partial_outcome_fail_closed(self):
        with patch.object(self.helper,'capture',return_value=self.before),self.assertRaises(RuntimeError):self.execute(migrate=Mock(side_effect=RuntimeError('synthetic')))
        with patch.object(self.helper,'capture',side_effect=[self.before,self.before]),self.assertRaisesRegex(RuntimeError,'incomplete'):self.execute()

    def test_restore_verification_requires_exact_fingerprint(self):
        with patch.object(self.helper,'capture',return_value=self.after):
            self.execute(action='verify',expected=self.helper.BASE,fingerprint='b'*64)
            with self.assertRaises(RuntimeError):self.execute(action='verify',expected=self.helper.BASE,fingerprint='0'*64)

class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve();self.data=self.root/'data';(self.data/'backups').mkdir(parents=True)
        self.source='a'*40;self.release=self.root/'releases'/self.source;self.release.mkdir(parents=True)
        manifest=self.release/'native-manifest.json';manifest.write_text(json.dumps({'source_commit':self.source}));manifest.chmod(0o644)
        self.dump=self.data/'backups/uat2-20261020T000000Z.dump';self.dump.write_bytes(b'PGDMPsynthetic');self.dump.chmod(0o600)
        self.receipt={'schema_version':2,'source_commit':self.source,'manifest_sha256':ctl.digest(manifest),'sha256':ctl.digest(self.dump),'schema_revision':ctl.BASE_REVISION,'fingerprint':'b'*64,'created_at':'2026-01-01T00:00:00+00:00'}
        for name,value in [('ROOT',self.root),('DATA',self.data)]:
            p=patch.object(ctl,name,value);p.start();self.addCleanup(p.stop)
        self.save()

    def save(self):ctl.durable_json(self.dump.with_suffix('.json'),self.receipt)

    def test_verified_backup_requires_private_matching_source_and_hash(self):
        self.assertEqual(ctl.checked_backup(str(self.dump))[2],self.release)
        self.dump.write_bytes(b'corrupted')
        with self.assertRaisesRegex(RuntimeError,'checksum'):ctl.checked_backup(str(self.dump))

    def test_legacy_wrong_revision_future_time_and_manifest_rejected(self):
        for key,value in [('schema_version',1),('schema_revision','unsupported_future_revision'),('created_at','2999-01-01T00:00:00+00:00'),('manifest_sha256','0'*64)]:
            old=self.receipt[key];self.receipt[key]=value;self.save()
            with self.assertRaises((RuntimeError,ValueError)):ctl.checked_backup(str(self.dump))
            self.receipt[key]=old

    def test_symlink_and_public_backup_refused(self):
        link=self.dump.parent/'uat2-20261021T000000Z.dump';link.symlink_to(self.dump)
        with self.assertRaisesRegex(RuntimeError,'Symlink'):ctl.checked_backup(str(link))
        self.dump.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError,'Private'):ctl.checked_backup(str(self.dump))

    def test_unconfirmed_app_state_fails_closed(self):
        with patch.object(ctl.subprocess,'run',return_value=Mock(returncode=4)),self.assertRaisesRegex(RuntimeError,'verifiably stopped'):ctl.require_apps_stopped()


if __name__=='__main__':unittest.main()
