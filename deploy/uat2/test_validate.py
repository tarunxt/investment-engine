import importlib.util
import tempfile
import unittest
import shutil
import subprocess
from pathlib import Path

spec = importlib.util.spec_from_file_location('uat2_validate', Path(__file__).with_name('validate.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.files = {
            '.env': {'UAT2_SOURCE_COMMIT': 'a'*40, **{f'UAT2_{name}_IMAGE': f'test/{name.lower()}@sha256:'+'a'*64 for name in ['FRONTEND','BACKEND','PROXY','CERTS','POSTGRES','REDIS']}},
            'backend.env': {'CREDX_UAT2':'1','ENVIRONMENT':'uat2','AUTH_DISABLED':'false', 'UAT2_ADAPTERS':'simulation',
                            'DATABASE_URL':'postgresql+psycopg2://credx_uat2:synthetic-test-only@postgres/credx_uat2',
                            'REDIS_URL':'redis://redis/0', 'UAT2_JWT_SIGNING_KEY':'unit-test-only-jwt-material-never-deployed',
                            'GOOGLE_SIGNIN_CLIENT_ID':'independent-test-client'},
            'frontend.env': {'CREDX_UAT2':'1','NEXTAUTH_SECRET':'unit-test-only-authjs-material-never-deployed',
                             'NEXTAUTH_URL':'https://uat2.cred-x.in','BACKEND_API_URL':'http://backend:8000', 'NEXT_PUBLIC_DISABLE_AUTH':'false'},
            'database.env': {'POSTGRES_USER':'credx_uat2','POSTGRES_DB':'credx_uat2','POSTGRES_PASSWORD':'synthetic-test-only'},
            'barrier.env': {'UAT2_BARRIER_USER':'synthetic-test-only','UAT2_BARRIER_HASH':'$2-unit-test-only-not-a-valid-hash'},
        }
        self.write()

    def tearDown(self):
        self.directory.cleanup()

    def write(self):
        for name, values in self.files.items():
            path = self.root / name
            path.write_text(''.join(f'{key}={value}\n' for key,value in values.items()))
            path.chmod(0o600)

    def test_isolated_config_accepts_and_returns_only_manifest(self):
        self.assertEqual(module.validate(self.root)['UAT2_SOURCE_COMMIT'], 'a'*40)

    def test_production_database_rejected(self):
        self.files['backend.env']['DATABASE_URL']='postgresql://credx_uat2:synthetic-test-only@production/credx_uat2'
        self.write()
        with self.assertRaises(ValueError): module.validate(self.root)

    def test_external_adapter_config_rejected(self):
        self.files['backend.env']['SMTP_HOST']='smtp.example.test'
        self.write()
        with self.assertRaises(ValueError): module.validate(self.root)

    def test_unresolved_secret_reference_rejected(self):
        self.files['backend.env']['UAT2_JWT_SIGNING_KEY']='{{resolve:secretsmanager:test:SecretString:key}}'
        self.write()
        with self.assertRaises(ValueError): module.validate(self.root)

    def test_mutable_image_rejected(self):
        self.files['.env']['UAT2_BACKEND_IMAGE']='test/backend:latest'
        self.write()
        with self.assertRaises(ValueError): module.validate(self.root)

    def test_group_readable_configuration_rejected(self):
        (self.root/'backend.env').chmod(0o640)
        with self.assertRaises(ValueError): module.validate(self.root)

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI unavailable for Compose syntax check')
    def test_compose_parses_without_launch_or_secret_output(self):
        shutil.copy(Path(__file__).with_name('compose.yaml'), self.root/'compose.yaml')
        result = subprocess.run(['docker', 'compose', '--project-directory', str(self.root),
                                 '--env-file', str(self.root/'.env'), '-f', str(self.root/'compose.yaml'),
                                 'config', '--quiet'], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__': unittest.main()
