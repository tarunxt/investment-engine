"""Direct controller regression: real filesystem markers/pointer, synthetic DB/services."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(Path(__file__).parent))
import ctl


class PromotionRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve();self.config=self.root/'config';self.config.mkdir()
        self.previous=self.root/'releases'/('a'*40);self.previous.mkdir(parents=True)
        self.candidate=self.root/'releases'/('b'*40);self.candidate.mkdir()
        (self.root/'current').symlink_to(self.candidate,target_is_directory=True)
        self.dump=self.root/'synthetic.dump';self.dump.write_bytes(b'synthetic only')
        self.receipt={'sha256':'c'*64,'source_commit':self.previous.name,'schema_revision':ctl.BASE_REVISION,'fingerprint':'d'*64}
        self.reference=ctl.backup_reference(self.dump,self.receipt)
        ctl.durable_json(self.root/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':self.candidate.name,'previous_source':self.previous.name,'backup':self.reference})
        for name,value in [('ROOT',self.root),('CONFIG',self.config),('checked_backup',Mock(return_value=(self.dump,self.receipt,self.previous))),('require_apps_stopped',Mock()),('configure_units',Mock()),('systemctl',Mock()),('readiness',Mock()),('schema_operation',Mock(return_value={'state':{'revision':ctl.BASE_REVISION,'stage09_tables':[]}}))]:
            p=patch.object(ctl,name,value);p.start();self.addCleanup(p.stop)
        p=patch.object(ctl.subprocess,'run',return_value=Mock(returncode=0));self.process=p.start();self.addCleanup(p.stop)

    def test_failed_rename_blocks_start_then_verify_only_recovery_succeeds(self):
        original=ctl.os.replace
        def fail_current(src,dst):
            if Path(dst)==self.root/'current':raise OSError('synthetic rename failure')
            return original(src,dst)
        with patch.object(ctl.os,'replace',side_effect=fail_current):
            with self.assertRaises(OSError):ctl.rollback(str(self.dump))
        self.assertEqual(ctl.private_json(ctl.pending())['phase'],'database_verified')
        self.assertEqual(ctl.current(),self.candidate)
        self.assertFalse(list(self.root.glob('current.*.new')))
        self.assertFalse((self.root/'current.new').exists())
        self.assertFalse(any(call.args[0]=='start' for call in ctl.systemctl.call_args_list))
        with patch.object(ctl,'host_guard'),patch.object(ctl,'acquire_lock'),patch.object(ctl,'validate'),patch.object(sys,'argv',['ctl','start']):
            with self.assertRaisesRegex(RuntimeError,'Unfinished deployment'):ctl.main()
        self.assertEqual(self.process.call_count,1,'one actual controller restore attempt before failure')
        ctl.rollback(str(self.dump),recover_only=True)
        self.assertEqual(self.process.call_count,1,'verified recovery must not repeat restore')
        self.assertEqual(ctl.current(),self.previous)
        self.assertEqual((self.config/'release.env').read_text(),'UAT2_SOURCE_COMMIT='+self.previous.name+'\n')
        self.assertFalse(ctl.pending().exists());ctl.readiness.assert_called_once()
        ctl.systemctl.assert_any_call('start',['backend','worker','frontend','proxy'])

    def test_orphan_from_killed_attempt_and_legacy_pointer_do_not_collide(self):
        for name in ['current.orphan.new','current.new']:(self.root/name).symlink_to(self.candidate)
        ctl.durable_json(ctl.pending(),{'schema_version':2,'operation':'rollback','candidate':self.candidate.name,'previous_source':self.previous.name,'backup':self.reference,'phase':'database_verified'})
        ctl.rollback(str(self.dump),recover_only=True)
        self.process.assert_not_called();self.assertEqual(ctl.current(),self.previous)
        self.assertFalse(ctl.pending().exists())
        for name in ['current.orphan.new','current.new']:self.assertTrue((self.root/name).is_symlink(),'prior orphan is not removed as a recovery bypass')

    def collision(self,kind):
        pointer=self.root/('current.'+'e'*32+'.new')
        if kind=='file':pointer.write_bytes(b'unrelated synthetic file')
        else:pointer.symlink_to(self.candidate,target_is_directory=True)
        with patch.object(ctl,'uuid4',return_value=Mock(hex='e'*32)):
            with self.assertRaises(FileExistsError):ctl.promote(self.previous)
        self.assertEqual(ctl.current(),self.candidate)
        if kind=='file':self.assertEqual(pointer.read_bytes(),b'unrelated synthetic file')
        else:self.assertTrue(pointer.is_symlink());self.assertEqual(pointer.readlink(),self.candidate)

    def test_colliding_regular_file_is_preserved(self):self.collision('file')

    def test_colliding_symlink_is_preserved(self):self.collision('symlink')


if __name__=='__main__':unittest.main()
