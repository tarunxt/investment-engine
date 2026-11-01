import configparser
import importlib.util
from pathlib import Path
from unittest import TestCase, mock

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('viewer_serve', HERE/'serve.py')
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


class ServiceTests(TestCase):
    def test_launcher_rejects_missing_socket_activation_before_reading_credentials(self):
        with mock.patch.dict(serve.os.environ, {}, clear=True), mock.patch.object(Path,'read_text') as read:
            with self.assertRaisesRegex(SystemExit,'private socket/credential'):
                serve.main()
            read.assert_not_called()

    def test_dependency_fingerprint_rejects_unreviewed_versions(self):
        with mock.patch.object(serve,'version',side_effect=lambda name:serve.DEPENDENCIES[name]):
            serve.verify_dependencies()
        with mock.patch.object(serve,'version',return_value='unreviewed'):
            with self.assertRaisesRegex(SystemExit,'dependency fingerprint'):
                serve.verify_dependencies()

    def test_dedicated_service_has_no_application_environment_or_financial_dependencies(self):
        unit=configparser.ConfigParser(interpolation=None,strict=False)
        unit.read(HERE/'systemd/investor-database-viewer.service')
        self.assertEqual(unit['Service']['DynamicUser'],'yes')
        self.assertEqual(unit['Service']['User'],'investor-db-viewer')
        self.assertEqual(unit['Service']['MemoryMax'],'256M')
        self.assertEqual(unit['Service']['NoNewPrivileges'],'yes')
        self.assertEqual(unit['Service']['ProtectSystem'],'strict')
        self.assertEqual(unit['Service']['SocketBindDeny'],'any')
        self.assertNotIn('EnvironmentFile',unit['Service'])
        self.assertEqual(unit['Unit']['Requires'],'investor-database-viewer.socket')
        self.assertNotIn('backend.env',str(dict(unit['Service'])))
        self.assertNotIn('celery',str(dict(unit['Unit'])))
        socket=configparser.ConfigParser(interpolation=None,strict=False)
        socket.read(HERE/'systemd/investor-database-viewer.socket')
        self.assertEqual(socket['Socket']['ListenStream'],'/run/investor-database-viewer.sock')
        self.assertEqual(socket['Socket']['SocketUser'],'investor')
        self.assertEqual(socket['Socket']['SocketMode'],'0600')
