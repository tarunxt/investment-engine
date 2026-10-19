import errno
import importlib.util
import io
import json
from pathlib import Path
import runpy
import socket
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch, Mock

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import package
import validate
import ctl


class NativeTests(unittest.TestCase):
    def test_chrony_requires_normal_tracking_and_selected_source(self):
        for tracking,sources,accepted in [
            ('Stratum : 4\nLeap status : Normal\n','^* 169.254.169.123 3 4 377 8 -3us',True),
            ('Stratum : 0\nLeap status : Not synchronised\n','^? 169.254.169.123',False),
            ('Stratum : 4\nLeap status : Normal\n','^- 169.254.169.123',False),
        ]:
            with self.subTest(accepted=accepted, sources=sources), \
                 patch.object(ctl.subprocess,'run',return_value=Mock(returncode=0)), \
                 patch.object(ctl,'run',side_effect=[tracking,sources]), \
                 patch.object(ctl.time,'monotonic',side_effect=[0,0,61]), \
                 patch.object(ctl.time,'sleep'):
                if accepted:ctl.time_check()
                else:
                    with self.assertRaisesRegex(RuntimeError,'Time synchronization'):ctl.time_check()

    def test_timesyncd_checks_its_own_diagnostics(self):
        with patch.object(ctl.subprocess,'run',side_effect=[Mock(returncode=3),Mock(returncode=0)]), \
             patch.object(ctl,'run',side_effect=['yes','synchronized diagnostic']) as run, \
             patch.object(ctl.time,'monotonic',side_effect=[0,0]):
            ctl.time_check()
            self.assertEqual(run.call_args_list[-1].args[0],['timedatectl','timesync-status','--no-pager'])

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)

    def tearDown(self): self.temp.cleanup()

    def config(self):
        files={
            'backend.env':{'CREDX_UAT2':'1','ENVIRONMENT':'uat2','AUTH_DISABLED':'false','UAT2_RUNTIME':'native','UAT2_ADAPTERS':'simulation',
                           'DATABASE_URL':'postgresql://credx_uat2:synthetic-test-only@127.0.0.1:5542/credx_uat2','REDIS_URL':'redis://127.0.0.1:6479/0',
                           'GOOGLE_SIGNIN_CLIENT_ID':'independent-test-client','UAT2_JWT_SIGNING_KEY':'unit-test-only-jwt-material-never-deployed'},
            'frontend.env':{'CREDX_UAT2':'1','BACKEND_API_URL':'http://127.0.0.1:8002','NEXTAUTH_URL':'https://uat2.cred-x.in','NEXT_PUBLIC_DISABLE_AUTH':'false',
                            'NEXTAUTH_SECRET':'unit-test-only-authjs-material-never-deployed'},
            'barrier.env':{'UAT2_BARRIER_USER':'synthetic-test-only','UAT2_BARRIER_HASH':'$2-test-only-not-a-valid-hash'},
        }
        for name,values in files.items():
            path=self.root/name; path.write_text(''.join(f'{k}={v}\n' for k,v in values.items()));path.chmod(0o600)
        return files

    def test_native_config_rejects_wrong_port_and_real_adapters(self):
        self.config(); validate.validate(self.root)
        path=self.root/'backend.env'
        path.write_text(path.read_text().replace(':5542/',':5432/'))
        with self.assertRaises(ValueError):validate.validate(self.root)
        self.config();path.write_text(path.read_text()+'SMTP_HOST=smtp.example.test\n')
        with self.assertRaises(ValueError):validate.validate(self.root)

    def test_unresolved_signing_material_and_shared_keys_rejected(self):
        self.config();path=self.root/'backend.env'
        path.write_text(path.read_text().replace('unit-test-only-jwt-material-never-deployed','{{resolve:secretsmanager:test:SecretString:key}}'))
        with self.assertRaises(ValueError):validate.validate(self.root)
        self.config();path.write_text(path.read_text().replace('unit-test-only-jwt-material-never-deployed','unit-test-only-authjs-material-never-deployed'))
        with self.assertRaises(ValueError):validate.validate(self.root)

    def test_independent_client_in_same_google_project_allowed(self):
        self.config();path=self.root/'backend.env'
        path.write_text(path.read_text().replace('independent-test-client','833980592098-independent-uat2-test-client.apps.googleusercontent.com'))
        validate.validate(self.root)
        path.write_text(path.read_text().replace('833980592098-independent-uat2-test-client.apps.googleusercontent.com',validate.shared.PRODUCTION_GOOGLE_CLIENT_ID))
        with self.assertRaises(ValueError):validate.validate(self.root)

    def test_unexpected_frontend_integration_config_rejected(self):
        self.config();path=self.root/'frontend.env';path.write_text(path.read_text()+'GOOGLE_CLIENT_SECRET=synthetic-test-only\n')
        with self.assertRaises(ValueError):validate.validate(self.root)

    def bundle(self):
        for name in ['application.tar.gz','frontend.tar.gz']:(self.root/name).write_bytes(b'synthetic archive placeholder')
        (self.root/'wheels').mkdir();(self.root/'wheels/test_only-1-py3-none-any.whl').write_bytes(b'synthetic wheel placeholder')
        return package.create(self.root,'a'*40)

    def complete_audit_bundle(self, runtime_env=False):
        def write_archive(name, contents):
            with tarfile.open(self.root/name,'w:gz') as output:
                for path,content in contents.items():
                    payload=content.encode();entry=tarfile.TarInfo(path);entry.size=len(payload);output.addfile(entry,io.BytesIO(payload))
        source={name:'synthetic test source' for name in ['backend/requirements.txt','backend/app/uat2/main.py','deploy/uat2/native/ctl.py','deploy/uat2/native/package.py']}
        if runtime_env:source['backend/.env']='synthetic-test-only-not-a-runtime-secret'
        write_archive('application.tar.gz',source)
        manifest={'build_sha':'a'*40,'platform':'linux','arch':'x64','node_major':22,
                  'public_environment':{'NEXT_PUBLIC_FRONTEND_URL':'https://uat2.cred-x.in','NEXT_PUBLIC_DISABLE_AUTH':'false'}}
        write_archive('frontend.tar.gz',{'server.js':'synthetic test entrypoint','deployment-manifest.json':json.dumps(manifest),
                      '.next/BUILD_ID':'test','.next/server/app-paths-manifest.json':json.dumps({'/console/uat2/page':'test.js'})})
        (self.root/'wheels').mkdir();(self.root/'wheels/test_only-1-py3-none-any.whl').write_bytes(b'synthetic wheel placeholder')
        package.create(self.root,'a'*40)

    def test_complete_bundle_content_audit(self):
        self.complete_audit_bundle()
        receipt=package.audit(self.root)
        self.assertEqual(receipt['wheel_count'],1)
        self.assertEqual(receipt['files_verified'],3)
        self.assertFalse(receipt['runtime_configuration_included'])

    def test_retained_bundle_rejects_runtime_env_files(self):
        self.complete_audit_bundle(runtime_env=True)
        with self.assertRaisesRegex(ValueError,'Runtime environment'):
            package.audit(self.root)

    def test_retained_bundle_rejects_unlisted_files(self):
        self.complete_audit_bundle();(self.root/'unexpected.txt').write_text('synthetic unexpected file')
        with self.assertRaisesRegex(ValueError,'Unexpected retained'):
            package.audit(self.root)

    def test_manifest_integrity_and_fixed_filenames(self):
        self.bundle();self.assertEqual(package.verify(self.root)['source_commit'],'a'*40)
        (self.root/'application.tar.gz').write_bytes(b'tampered')
        with self.assertRaises(ValueError):package.verify(self.root)

    def test_archive_traversal_denied(self):
        archive=self.root/'bad.tar'
        with tarfile.open(archive,'w') as output:
            entry=tarfile.TarInfo('../outside');entry.size=1;output.addfile(entry,io.BytesIO(b'x'))
        with self.assertRaises(tarfile.FilterError):package.extract(archive,self.root/'extracted')
        self.assertFalse((self.root/'outside').exists())

    def test_excluded_host_identity_denied(self):
        expected={'purpose':'credx-uat2','account':'457945009677','region':'ap-south-1','instance_id':'i-new-synthetic'}
        actual={'accountId':'457945009677','region':'ap-south-1','instanceId':'i-new-synthetic'}
        ctl.validate_identity(expected,actual)
        for instance in ctl.EXCLUDED:
            with self.assertRaises(RuntimeError):ctl.validate_identity({**expected,'instance_id':instance},{**actual,'instanceId':instance})
        with self.assertRaises(RuntimeError):ctl.validate_identity(expected,{**actual,'accountId':'000000000000'})

    def test_units_have_dedicated_users_and_confinement(self):
        for name in ['backend','worker','frontend','migrate']:
            content=(HERE/'systemd'/f'credx-uat2-{name}.service').read_text()
            for item in ['IPAddressDeny=any','IPAddressAllow=localhost','runtime-preflight.py','NoNewPrivileges=yes','LogNamespace=credx-uat2','Requires=credx-uat2-network.service']:
                self.assertIn(item,content)
            self.assertNotIn('sync-bullpen-operator-credentials',content)
            self.assertNotIn('/etc/investor',content)
        network=(HERE/'network.nft').read_text()
        self.assertIn('meta skuid',network)
        self.assertIn('reject with icmpx type admin-prohibited',network)
        self.assertNotIn('flush ruleset',(HERE/'network-apply.sh').read_text())
        self.assertIn('admin off',(HERE/'Caddyfile').read_text())
        self.assertIn('listen 127.0.0.1:18082',(HERE/'nginx.conf').read_text())

    def network_probe(self,result):
        class Probe:
            def __init__(self,family,*args):
                if family==socket.AF_INET6:raise OSError(errno.EAFNOSUPPORT,'test-only restriction')
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def settimeout(self,value):pass
            def connect_ex(self,address):return result
        response=Mock();response.__enter__=Mock(return_value=io.BytesIO(b'{"test-only-cert":"synthetic"}'));response.__exit__=Mock(return_value=False)
        with patch('urllib.request.OpenerDirector.open',return_value=response),patch('socket.socket',Probe):
            runpy.run_path(str(HERE/'runtime-preflight.py'))

    def test_network_gate_requires_explicit_denial(self):
        self.network_probe(errno.EACCES)
        for result in [0,errno.ETIMEDOUT,errno.ENETUNREACH]:
            with self.assertRaises(SystemExit):self.network_probe(result)

    def test_failed_migration_does_not_promote_or_restart_apps(self):
        release=self.root/'releases'/('a'*40);release.mkdir(parents=True)
        events=[]
        def systemctl(action,names):
            events.append((action,names))
            if names==['migrate']:raise RuntimeError('synthetic migration failure')
        with patch.object(ctl,'ROOT',self.root),patch.object(ctl,'CONFIG',self.root),patch.object(ctl,'host_guard'),patch.object(ctl,'acquire_lock'),patch.object(ctl,'validate'),patch.object(ctl,'time_check'),patch.object(ctl,'install_release',return_value=release),patch.object(ctl,'configure_units'),patch.object(ctl,'systemctl',side_effect=systemctl),patch.object(ctl,'backup',return_value=self.root/'backup.dump'),patch.object(ctl,'write_release_environment'),patch.object(ctl,'promote') as promote,patch.object(ctl.shutil,'disk_usage',return_value=Mock(free=4*1024**3)),patch.object(sys,'argv',['ctl.py','deploy',str(self.root)]):
            with self.assertRaises(RuntimeError):ctl.main()
        promote.assert_not_called()
        self.assertTrue((self.root/'pending-deployment.json').exists())
        self.assertIn(('stop',ctl.APPS),events)
        self.assertFalse(any(action=='restart' for action,names in events))

    def test_reset_uses_serving_model_registry_and_release_directory(self):
        release=self.root/'releases'/('a'*40)
        for state in ('empty','populated'):
            with self.subTest(state=state), patch.object(ctl,'host_guard'), patch.object(ctl,'acquire_lock'), patch.object(ctl,'validate'), patch.object(ctl,'current',return_value=release), patch.object(ctl,'env_for',return_value={}), patch.object(ctl,'run') as run, patch.object(sys,'argv',['ctl.py','reset',state]):
                ctl.main()
            run.assert_called_once()
            command=run.call_args.args[0]
            self.assertEqual(command[:4],['/usr/sbin/runuser','-u','credx-uat2-app','--'])
            self.assertEqual(command[-1],state)
            self.assertEqual(command[-3],'-c')
            self.assertIn('import app.uat2.main',command[-2])
            self.assertIn("runpy.run_module('app.uat2.reset', run_name='__main__')",command[-2])
            self.assertEqual(run.call_args.kwargs['cwd'],release/'backend')
            self.assertEqual(run.call_args.kwargs['env']['PYTHONPATH'],str(release/'backend'))


if __name__=='__main__':unittest.main()
