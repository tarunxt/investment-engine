"""No-DB safety tests and mocked reproductions of unchanged native controller gaps."""
import hashlib
import contextlib
import io
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch

import verify_stage09_restore as v


class RestoreSafety(unittest.TestCase):
    def test_exact_ci_target_and_container_required_before_connect(self):
        with patch.object(v,'inside_container',return_value=True):
            env=v.guarded_environment(v.REQUIRED)
            self.assertEqual(env['DATABASE_URL'],v.URL)
            self.assertNotIn('AWS_ACCESS_KEY_ID',env)
            for key,value in [('DATABASE_URL',v.URL+'?options=unsafe'),('CI','false'),
                              ('CREDX_STAGE09_RESTORE_ACK',''),('ENVIRONMENT','uat2')]:
                with self.subTest(key=key),self.assertRaises(RuntimeError):
                    v.guarded_environment({**v.REQUIRED,key:value})
        with patch.object(v,'inside_container',return_value=False),self.assertRaises(RuntimeError):
            v.guarded_environment(v.REQUIRED)

    def test_unrelated_errors_never_count_as_dependency_evidence(self):
        expected='cannot drop constraint users_pkey on table public.users because other objects depend on it; constraint integration_connections_owner_id_fkey depends on index users_pkey'
        self.assertTrue(v.expected_dependency_failure(expected))
        for error in ['password authentication failed','permission denied for schema public',
                      'connection refused','syntax error','duplicate key value','cannot drop unrelated table']:
            with self.subTest(error=error):self.assertFalse(v.expected_dependency_failure(error))

    def test_runtime_paths_and_client_major_cannot_drift(self):
        v.validate_changed_paths(v.ALLOWED_CHANGES)
        for path in ['backend/app/core/uat2.py','deploy/uat2/native/ctl.py','frontend/auth.ts']:
            with self.subTest(path=path),self.assertRaises(RuntimeError):v.validate_changed_paths([path])
        v.postgres16('pg_restore (PostgreSQL) 16.11')
        with self.assertRaises(RuntimeError):v.postgres16('pg_restore (PostgreSQL) 17.0')

    def test_schema_normalization_keeps_real_object_changes(self):
        self.assertEqual(v.normalize_schema('\\restrict a\nCREATE TABLE x(a int);\n\\unrestrict a'),
                         v.normalize_schema('\\restrict b\nCREATE TABLE x(a int);\n\\unrestrict b'))
        self.assertNotEqual(v.normalize_schema('GRANT SELECT ON x TO PUBLIC;'),
                            v.normalize_schema('REVOKE SELECT ON x FROM PUBLIC;'))

    def test_proposed_sequence_requires_revision_and_existing_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker=Path(tmp)/'pending-deployment.json';calls=[Mock() for _ in range(5)]
            with self.assertRaises(RuntimeError):v.guarded_test_sequence(marker,v.NEW_REVISION,*calls)
            marker.write_text('{}')
            with self.assertRaises(RuntimeError):v.guarded_test_sequence(marker,v.BASE_REVISION,*calls)
            self.assertTrue(marker.exists());self.assertTrue(all(not c.called for c in calls))

    def test_injected_downgrade_and_restore_failures_keep_marker_and_never_finalize(self):
        # This proves the test-only proposed sequence, not a runtime-controller repair.
        for phase in ('downgrade','restore'):
            with self.subTest(phase=phase),tempfile.TemporaryDirectory() as tmp:
                marker=Path(tmp)/'pending-deployment.json';marker.write_text('{}')
                preserve,downgrade,restore,verify,finalize=[Mock() for _ in range(5)]
                (downgrade if phase=='downgrade' else restore).side_effect=RuntimeError('injected fixture failure')
                with self.assertRaises(RuntimeError):
                    v.guarded_test_sequence(marker,v.NEW_REVISION,preserve,downgrade,restore,verify,finalize)
                self.assertTrue(marker.exists());verify.assert_not_called();finalize.assert_not_called()
                if phase=='downgrade':restore.assert_not_called()


class NativeControllerKnownGap(unittest.TestCase):
    """Expected-current-behavior repros: green means the P1 was reproduced, NOT fixed."""
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve()/'root';self.data=Path(self.tmp.name).resolve()/'data'
        directory=self.data/'backups';directory.mkdir(parents=True)
        self.backup=directory/'uat2-20261020T000000Z.dump';self.backup.write_bytes(b'PGDMP-synthetic-fixture')
        self.backup.with_suffix('.json').write_text(json.dumps({'source_commit':v.STAGE08_SOURCE,
                   'sha256':hashlib.sha256(self.backup.read_bytes()).hexdigest()}))
        release=self.root/'releases'/v.STAGE08_SOURCE;release.mkdir(parents=True)
        (release/'native-manifest.json').write_text('{}')
        self.marker=self.root/'pending-deployment.json'
        native=v.ROOT/'deploy/uat2/native';sys.path.insert(0,str(native));self.addCleanup(lambda:sys.path.remove(str(native)))
        spec=importlib.util.spec_from_file_location('stage09_unchanged_native_ctl',native/'ctl.py')
        self.ctl=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.ctl)
        for name,value in [('ROOT',self.root),('DATA',self.data)]:
            p=patch.object(self.ctl,name,value);p.start();self.addCleanup(p.stop)
        self.mocks={}
        for name in ('host_guard','acquire_lock','validate','time_check','readiness','configure_units','promote','systemctl','current'):
            p=patch.object(self.ctl,name);self.mocks[name]=p.start();self.addCleanup(p.stop)
        self.mocks['current'].return_value=self.root/'releases'/v.APP_SOURCE
        p=patch.object(self.ctl.subprocess,'run',return_value=SimpleNamespace(returncode=1,stderr=b'injected pg_restore failure'))
        p.start();self.addCleanup(p.stop)

    def rollback_failure(self):
        with patch.object(sys,'argv',['ctl.py','rollback',str(self.backup)]):
            with self.assertRaisesRegex(RuntimeError,'Restore failed; app remains stopped'):self.ctl.main()
        self.mocks['systemctl'].assert_called_once_with('stop',self.ctl.APPS)
        for name in ('configure_units','promote','readiness'):self.mocks[name].assert_not_called()

    def test_existing_pending_marker_survives_restore_failure_and_blocks_start(self):
        self.marker.write_text(json.dumps({'candidate':v.APP_SOURCE}))
        self.rollback_failure();self.assertTrue(self.marker.exists())
        with patch.object(sys,'argv',['ctl.py','start']),self.assertRaisesRegex(RuntimeError,'Unfinished deployment'):
            self.ctl.main()
        self.mocks['systemctl'].assert_called_once_with('stop',self.ctl.APPS)
        self.mocks['readiness'].assert_not_called()

    def test_known_p1_standalone_failure_leaves_later_start_unblocked(self):
        self.rollback_failure();self.assertFalse(self.marker.exists())
        with patch.object(sys,'argv',['ctl.py','start']),contextlib.redirect_stdout(io.StringIO()):self.ctl.main()
        self.mocks['systemctl'].assert_any_call('start',self.ctl.SERVICES)
        self.mocks['readiness'].assert_called_once()
        print('KNOWN_P1_REPRODUCED: standalone failed rollback creates no pending marker; later start can run (all service calls mocked).')


if __name__=='__main__':unittest.main()
