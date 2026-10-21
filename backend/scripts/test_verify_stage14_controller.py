"""Local safety/provenance tests; no PostgreSQL, systemd or child processes."""
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch

spec=importlib.util.spec_from_file_location('stage14_controller_fixture',Path(__file__).with_name('verify_stage14_controller.py'))
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)

class GuardTests(unittest.TestCase):
    def setUp(self):
        self.sha='a'*40
        self.environment={'CI':'true','GITHUB_ACTIONS':'true','CREDX_STAGE14_CONTROLLER_ACK':'disposable-linux-ci-only','CREDX_STAGE14_SOURCE':self.sha}
        self.git=Mock(side_effect=lambda *a:self.sha.encode()+b'\n' if a==('rev-parse','HEAD') else b'')
        for name,value in [('CANDIDATE',self.sha),('REPO',Path('/home/runner/work/credx/repo')),('git',self.git),('Path',lambda value:SimpleNamespace(is_dir=lambda:value=='/run/systemd/system',exists=lambda:False))]:
            p=patch.object(fixture,name,value);p.start();self.addCleanup(p.stop)
        for p in [patch.object(fixture.os,'geteuid',return_value=0),patch.object(fixture.sys,'platform','linux'),patch.dict(os.environ,self.environment,clear=True)]:
            p.start();self.addCleanup(p.stop)

    def test_exact_clean_candidate_requires_accepted_stage12_ancestry(self):
        self.assertEqual(fixture.guard(),self.sha)
        self.git.assert_any_call('merge-base','--is-ancestor','31ecd3fa59a5e4ce4847170ff6b973a9e0709ddd',self.sha)

    def test_wrong_head_and_dirty_worktree_are_rejected(self):
        self.git.side_effect=lambda *a:b'b'*40 if a==('rev-parse','HEAD') else b''
        with self.assertRaisesRegex(RuntimeError,'Exact Stage14'):fixture.guard()
        self.git.side_effect=lambda *a:self.sha.encode() if a==('rev-parse','HEAD') else (b'M unsafe' if a==('status','--porcelain') else b'')
        with self.assertRaisesRegex(RuntimeError,'Clean committed'):fixture.guard()

    def test_missing_ack_non_runner_and_non_root_are_rejected(self):
        with patch.dict(os.environ,{'CREDX_STAGE14_CONTROLLER_ACK':'wrong'}),self.assertRaises(RuntimeError):fixture.guard()
        with patch.object(fixture,'REPO',Path('/tmp/repo')),self.assertRaises(RuntimeError):fixture.guard()
        with patch.object(fixture.os,'geteuid',return_value=1000),self.assertRaises(RuntimeError):fixture.guard()

    def test_fixture_environment_never_inherits_cloud_or_provider_credentials(self):
        self.assertFalse(any(key.startswith(('AWS_','GOOGLE_','ZERODHA_','OPENAI_')) for key in fixture.SAFE_ENV))
        self.assertEqual(set(fixture.SAFE_ENV),{'PATH','PYTHONDONTWRITEBYTECODE','CI','GITHUB_ACTIONS','CREDX_STAGE14_CONTROLLER_ACK','CREDX_STAGE14_SOURCE'})


class ReadinessFixtureTests(unittest.TestCase):
    def fixture(self):
        spec=importlib.util.spec_from_file_location('stage10_http_fixture',Path(__file__).parent/'stage10_fixtures/service.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

    def status(self,server):
        from urllib.request import urlopen
        from urllib.error import HTTPError
        try:
            with urlopen('http://127.0.0.1:'+str(server.server_port)+'/',timeout=3) as response:return response.status
        except HTTPError as exc:return exc.code

    def start(self,server):
        import threading
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def stop():server.shutdown();server.server_close();thread.join(timeout=3)
        self.addCleanup(stop)

    def test_real_http_failure_flag_is_local_to_stage14_then_clears(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);own=root/'stage10';own.mkdir();historical=root/'stage09';historical.mkdir()
            (historical/'readiness-fail').write_text('historical synthetic flag')
            server=self.fixture().make_server(0,readiness=True,directory=own);self.start(server)
            self.assertEqual(self.status(server),200)
            flag=own/'readiness-fail';flag.write_text('synthetic failure')
            self.assertEqual(self.status(server),503)
            flag.unlink();self.assertEqual(self.status(server),200)
            self.assertTrue((historical/'readiness-fail').exists())

    def test_dependency_endpoint_stays_healthy_when_app_flag_exists(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'readiness-fail').write_text('synthetic app-only failure')
            server=self.fixture().make_server(0,readiness=False,directory=root);self.start(server)
            self.assertEqual(self.status(server),200)

class ReadinessEvidenceTests(unittest.TestCase):
    def test_transient_startup_then503_requires_exact_controller_failure(self):
        case={};statuses=Mock(side_effect=[OSError('synthetic startup'),[503,503]])
        readiness=Mock(side_effect=RuntimeError(fixture.READINESS_FAILURE_MESSAGE))
        with self.assertRaises(fixture.ObservedReadinessFailure):
            fixture.observe_readiness_failure(readiness,statuses,case,timeout=1,interval=0)
        self.assertEqual(case['injected_http_statuses'],[503,503])
        self.assertTrue(case['controller_readiness_failure_observed']);readiness.assert_called_once()

    def test_missing503_or_transport_error_cannot_pass_or_invoke_readiness(self):
        for statuses in [Mock(return_value=[200,200]),Mock(side_effect=RuntimeError('synthetic curl failure'))]:
            case={};readiness=Mock(side_effect=RuntimeError(fixture.READINESS_FAILURE_MESSAGE))
            with self.assertRaisesRegex(AssertionError,'not observed'):
                fixture.observe_readiness_failure(readiness,statuses,case,timeout=0)
            readiness.assert_not_called();self.assertNotIn('controller_readiness_failure_observed',case)

    def test_unrelated_runtime_error_cannot_satisfy_expected_failure(self):
        case={}
        with self.assertRaisesRegex(AssertionError,'Unexpected controller error'):
            fixture.observe_readiness_failure(Mock(side_effect=RuntimeError('synthetic setup error')),lambda:[503,503],case)
        self.assertNotIn('controller_readiness_failure_observed',case)

    def test_unexpected_healthy_return_is_a_failure(self):
        case={}
        with self.assertRaisesRegex(AssertionError,'did not fail'):
            fixture.observe_readiness_failure(Mock(return_value=None),lambda:[503,503],case)
        self.assertNotIn('controller_readiness_failure_observed',case)

if __name__=='__main__':unittest.main()
