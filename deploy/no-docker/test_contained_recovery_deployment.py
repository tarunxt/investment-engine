"""Execute the real SSH workflow script against temporary source and fake services.

No SSH, systemd, git checkout, network, migration or credential access occurs.
"""
import getpass
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import yaml

REPO=Path(__file__).resolve().parents[2]
DRIVER=Path(__file__).with_name("deploy-recovery.sh")


class ContainedDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="/tmp/investor-deploy-fixture-");self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.app=self.root/"app";self.bin=self.root/"bin"
        self.bin.mkdir();(self.app/".git").mkdir(parents=True)
        for name in ("backend/app/nested","backend/scripts","backend/alembic/versions","backend/.venv/bin","deploy/no-docker/scripts","artifacts"):
            (self.app/name).mkdir(parents=True)
        for name,value in {"backend/app/main.py":"previous","backend/app/nested/guard.py":"old-guard","backend/requirements.txt":"unchanged","backend/.env":"env-sentinel","backend/.venv/marker":"venv-sentinel","deploy/no-docker/scripts/run-backend.sh":"previous-launcher"}.items():
            (self.app/name).write_text(value)
        (self.app/"deploy/no-docker/load-env-file.sh").write_text('load_env_file() { source "$1"; }\n')
        self.executable(self.app/"backend/.venv/bin/python","#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n")
        self.executable(self.app/"deploy/no-docker/redeploy.sh",'''#!/usr/bin/env bash
echo frontend-only-promotion >> "$FIXTURE_ROOT/commands"
[[ "$1" == frontend-only ]] || exit 1
echo candidate > "$FIXTURE_ROOT/frontend-state"
if ! bash "$CREDX_CONTAINED_RELEASE_DRIVER" --post-frontend-check; then
  echo previous > "$FIXTURE_ROOT/frontend-state"
  exit 1
fi
''')
        (self.root/"frontend-state").write_text("previous")
        (self.root/"tracked.json").write_text(json.dumps([p.relative_to(self.app).as_posix() for p in self.app.rglob('*') if p.is_file() and '.venv' not in p.parts and not p.name.startswith('.env')]))
        self.state=self.root/"state.json";self.state.write_text(json.dumps({"investor-backend":"active","investor-recovery-analysis":"active"}))
        (self.root/"head").write_text("a"*40)
        self.envfile=self.root/"backend.env";self.envfile.write_text("CREDX_RECOVERY_MODE=1\n")
        candidate=self.root/"candidate";candidate.mkdir()
        for name in ("deploy-recovery.sh","backend-recovery-artifact.py"): shutil.copyfile(DRIVER.parent/name,candidate/name)
        self.make_shims()
        workflow=yaml.load((REPO/".github/workflows/deploy.yml").read_text(),Loader=yaml.BaseLoader)
        step=next(s for s in workflow["jobs"]["deploy-production"]["steps"] if s.get("id")=="deploy-ssh")
        script=step["with"]["script"]
        script=re.sub(r'\$\{\{ vars\.EC2_APP_PATH.*?\}\}',str(self.app),script)
        script=re.sub(r'\$\{\{ vars\.EC2_APP_USER.*?\}\}',getpass.getuser(),script)
        script=script.replace('/etc/investor/backend.env',str(self.envfile)).replace('/run/investor-production-deploy.lock',str(self.root/"lock"))
        self.script=self.root/"workflow.sh";self.script.write_text(script)
        artifacts=self.app/"artifacts";(artifacts/"frontend.tar.gz").write_text("fixture");(artifacts/"frontend.tar.gz.sha256").write_text("fixture")
        self.environment={**os.environ,"PATH":str(self.bin)+os.pathsep+os.environ["PATH"],"FIXTURE_ROOT":str(self.root),"FIXTURE_APP":str(self.app),"FIXTURE_PYTHON":sys.executable,"FIXTURE_MODE":"1","DEPLOY_COMMIT_SHA":"b"*40,"DEPLOY_SCOPE":"backend-only","REMOTE_ARTIFACT_DIR":str(artifacts),"REMOTE_ARTIFACT_FILE":"frontend.tar.gz"}

    def executable(self,path,source):
        path.write_text(source);path.chmod(0o755)

    def make_shims(self):
        common=f"#!{sys.executable}\nimport os,sys,json,pathlib,shutil\nroot=pathlib.Path(os.environ['FIXTURE_ROOT']);app=pathlib.Path(os.environ['FIXTURE_APP']);args=sys.argv[1:]\nwith (root/'commands').open('a') as log: log.write(pathlib.Path(sys.argv[0]).name+' '+' '.join(args)+'\\n')\n"
        self.executable(self.bin/"sudo",common+"""
while args and args[0] in ('-u','-H','--'):
    args=args[2:] if args[0]=='-u' else args[1:]
if args[:2]==['python3','-']:
    sys.stdin.read();mode=os.environ['FIXTURE_MODE']
    if os.getenv('FIXTURE_FAIL_POST_FRONTEND') and (root/'frontend-state').read_text().strip()=='candidate': mode='0'
    if mode=='unknown': raise SystemExit(1)
    print(mode);raise SystemExit(0)
if args and args[0]=='chown': raise SystemExit(0)
os.execvp(args[0],args)
""")
        self.executable(self.bin/"python3",common+"os.execv(os.environ['FIXTURE_PYTHON'],[os.environ['FIXTURE_PYTHON'],*args])\n")
        self.executable(self.bin/"systemctl",common+"""
states=json.loads((root/'state.json').read_text());action=args[0]
if action=='show':
    unit=args[1];prop=next((a.split('=',1)[1] for a in args if a.startswith('--property=')),'')
    if prop=='MainPID': print('123' if states.get(unit)=='active' else '0')
    elif prop=='ActiveState': print(states.get(unit,'inactive'))
    elif prop=='ExecStartPre': print('unreviewed-hook' if os.getenv('FIXTURE_HOOK') else '')
elif action=='is-active': raise SystemExit(0 if states.get(args[-1])=='active' else 3)
elif action in ('stop','start'):
    for unit in args[1:]: states[unit]='inactive' if action=='stop' else 'active'
    (root/'state.json').write_text(json.dumps(states))
else: raise SystemExit('Unexpected service mutation')
""")
        self.executable(self.bin/"git",common+"""
while args and args[0] in ('-C','-H'):
    args=args[2:] if args[0]=='-C' else args[1:]
action=args[0]
if action=='rev-parse': print((root/'head').read_text())
elif action=='ls-files': sys.stdout.buffer.write(bytes([0]).join(p.encode() for p in json.loads((root/'tracked.json').read_text()))+bytes([0]))
elif action=='show': sys.stdout.write((root/'candidate'/args[-1].rsplit('/',1)[-1]).read_text())
elif action=='reset':
    (root/'head').write_text(os.environ['DEPLOY_COMMIT_SHA'])
    (app/'backend/app/main.py').write_text('candidate')
    (app/'backend/app/nested/guard.py').unlink()
    (app/'backend/app/new_feature.py').write_text('new-candidate')
    tracked=json.loads((root/'tracked.json').read_text())
    tracked.remove('backend/app/nested/guard.py');tracked.append('backend/app/new_feature.py')
    (root/'tracked.json').write_text(json.dumps(tracked))
    (app/'deploy/no-docker/scripts/run-backend.sh').write_text('candidate-launcher')
    if os.getenv('FIXTURE_CORRUPT_BACKUP'):
        backup=next(app.glob('.recovery-release-*/backend-source.tar.gz'))
        with backup.open('ab') as target: target.write(b'corrupt')
elif action not in ('diff','fetch','cat-file'): raise SystemExit('Unexpected git mutation')
""")
        self.executable(self.bin/"curl",common+"""
url=args[-1]
if '/health/ready' in url:
    if os.getenv('FIXTURE_FAIL_HEALTH') and (app/'backend/app/main.py').read_text()=='candidate': raise SystemExit(22)
elif url.endswith('/zerodha/orders'): print('503',end='')
else: print('401',end='')
""")
        self.executable(self.bin/"flock",common+"raise SystemExit(0)\n")
        self.executable(self.bin/"readlink",common+"print('/run/investor-production-deploy.lock')\n")
        self.executable(self.bin/"sleep",common+"raise SystemExit(0)\n")
        self.executable(self.bin/"df",common+"print('Filesystem 1024-blocks Used Available Capacity Mounted');print('fixture 99999999 0 99999999 0% /')\n")

    def run_workflow(self,**environment):
        result=subprocess.run(['bash',str(self.script)],env={**self.environment,**environment},capture_output=True,text=True,timeout=30)
        driver=re.search(r'stable recovery driver retained at (\S+)',result.stderr)
        if driver:
            path=Path(driver.group(1));self.assertTrue(path.is_dir())
            self.addCleanup(shutil.rmtree,path)
        return result

    def unchanged_runtime(self):
        self.assertEqual((self.app/'backend/.env').read_text(),'env-sentinel')
        self.assertEqual((self.app/'backend/.venv/marker').read_text(),'venv-sentinel')
        commands=(self.root/'commands').read_text()
        self.assertNotIn('daemon-reload',commands);self.assertNotIn('systemctl enable',commands)
        self.assertNotRegex(commands,r'systemctl (start|restart).*celery')

    def test_normal_unknown_and_unreviewed_hook_block_before_checkout(self):
        for extra in ({'FIXTURE_MODE':'0'},{'FIXTURE_MODE':'unknown'},{'FIXTURE_HOOK':'1'}):
            result=self.run_workflow(**extra);self.assertNotEqual(result.returncode,0)
            self.assertEqual((self.root/'head').read_text(),'a'*40)
            self.assertEqual((self.app/'backend/app/main.py').read_text(),'previous')
            self.assertNotIn('reset --hard',(self.root/'commands').read_text())
        self.unchanged_runtime()

    def test_snapshot_failure_blocks_before_stop_or_checkout(self):
        (self.app/'backend/app/.env').write_text('fixture')
        result=self.run_workflow();self.assertNotEqual(result.returncode,0)
        commands=(self.root/'commands').read_text();self.assertNotIn('reset --hard',commands);self.assertNotIn('systemctl stop',commands)
        self.unchanged_runtime()

    def test_failed_health_restores_complete_source_and_retains_candidate(self):
        result=self.run_workflow(FIXTURE_FAIL_HEALTH='1');self.assertNotEqual(result.returncode,0,result.stdout)
        self.assertEqual((self.app/'backend/app/main.py').read_text(),'previous')
        self.assertEqual((self.app/'backend/app/nested/guard.py').read_text(),'old-guard')
        self.assertEqual((self.app/'deploy/no-docker/scripts/run-backend.sh').read_text(),'previous-launcher')
        self.assertFalse((self.app/'backend/app/new_feature.py').exists())
        self.assertTrue(list(self.app.glob('.recovery-release-*/failed-candidate-*/backend/app/new_feature.py')))
        self.assertEqual(json.loads(self.state.read_text())['investor-backend'],'active')
        self.unchanged_runtime()

    def test_success_keeps_candidate_and_only_promotes_frontend_scope(self):
        result=self.run_workflow(DEPLOY_SCOPE='full-stack');self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((self.app/'backend/app/main.py').read_text(),'candidate')
        commands=(self.root/'commands').read_text();self.assertIn('frontend-only-promotion',commands)
        self.assertLess(commands.index('flock '),commands.index('snapshot '))
        self.assertLess(commands.index('snapshot '),commands.index('reset --hard'))
        self.assertLess(commands.index('systemctl stop investor-backend'),commands.index('reset --hard'))
        self.unchanged_runtime()

    def test_rollback_failure_is_explicit_and_leaves_consumers_stopped(self):
        result=self.run_workflow(FIXTURE_FAIL_HEALTH='1',FIXTURE_CORRUPT_BACKUP='1');self.assertNotEqual(result.returncode,0)
        self.assertIn('ROLLBACK_BLOCKED',result.stderr)
        self.assertEqual(json.loads(self.state.read_text())['investor-backend'],'inactive')
        self.unchanged_runtime()

    def test_post_frontend_gate_restores_both_prior_frontend_and_backend(self):
        result=self.run_workflow(DEPLOY_SCOPE='full-stack',FIXTURE_FAIL_POST_FRONTEND='1')
        self.assertNotEqual(result.returncode,0,result.stdout)
        self.assertEqual((self.root/'frontend-state').read_text().strip(),'previous')
        self.assertEqual((self.app/'backend/app/main.py').read_text(),'previous')
        self.assertFalse((self.app/'backend/app/new_feature.py').exists())
        self.unchanged_runtime()

    def test_actual_runtime_probe_rejects_missing_mode_activation_and_spend(self):
        probe=DRIVER.read_text().split("<<'PY'\n",1)[1].split('\nPY',1)[0]
        for values in (b'',b'CREDX_RECOVERY_MODE=1\0RECOMMENDATION_AUDIT_EXTERNAL_ENABLED=true',b'CREDX_RECOVERY_MODE=1\0RECOMMENDATION_AUDIT_DAILY_CAP_USD=1'):
            with self.subTest(values=values),patch.object(Path,'read_bytes',return_value=values),patch.object(sys,'argv',['probe','123']),patch('sys.stdout',new_callable=io.StringIO):
                with self.assertRaises(SystemExit): exec(compile(probe,'runtime-probe','exec'),{})

    def test_actual_runtime_probe_admits_only_complete_stored_pair(self):
        probe=DRIVER.read_text().split("<<'PY'\n",1)[1].split('\nPY',1)[0]
        base=b'CREDX_RECOVERY_MODE=1\0RECOMMENDATION_AUDIT_ENABLED=true'
        for values,allowed in [(base,False),(base+b'\0RECOMMENDATION_AUDIT_RECOVERY_STORED_ONLY_ENABLED=true',True),(base+b'\0RECOMMENDATION_AUDIT_RECOVERY_STORED_ONLY_ENABLED=true\0RECOMMENDATION_AUDIT_EXTERNAL_ENABLED=true',False)]:
            with self.subTest(allowed=allowed),patch.object(Path,'read_bytes',return_value=values),patch.object(sys,'argv',['probe','123']),patch('sys.stdout',new_callable=io.StringIO) as output:
                if allowed:
                    exec(compile(probe,'runtime-probe','exec'),{});self.assertEqual(output.getvalue(),'1\n')
                else:
                    with self.assertRaises(SystemExit): exec(compile(probe,'runtime-probe','exec'),{})

    def test_public_build_probe_redacts_other_keys_and_refuses_invalid_flags(self):
        workflow=yaml.load((REPO/'.github/workflows/deploy.yml').read_text(),Loader=yaml.BaseLoader)
        step=next(s for s in workflow['jobs']['build-frontend']['steps'] if s.get('id')=='audit-public-flag')
        probe=step['with']['script'].split("<<'PY'\n",1)[1].split('\nPY',1)[0]
        for content,expected in [('NEXTAUTH_SECRET=fixture-never-output\n','false'),('NEXT_PUBLIC_RECOMMENDATION_AUDIT_ENABLED="true"\nNEXTAUTH_SECRET=fixture-never-output','true'),('NEXT_PUBLIC_RECOMMENDATION_AUDIT_ENABLED=false','false'),('NEXT_PUBLIC_RECOMMENDATION_AUDIT_ENABLED=$(invalid)',None),('NEXT_PUBLIC_RECOMMENDATION_AUDIT_ENABLED=true\nNEXT_PUBLIC_RECOMMENDATION_AUDIT_ENABLED=false',None)]:
            with self.subTest(expected=expected),patch.object(Path,'read_text',return_value=content),patch('sys.stdout',new_callable=io.StringIO) as output:
                if expected is None:
                    with self.assertRaises(SystemExit): exec(compile(probe,'public-probe','exec'),{})
                else:
                    exec(compile(probe,'public-probe','exec'),{});self.assertEqual(output.getvalue(),'CREDX_PUBLIC_AUDIT_FLAG='+expected+'\n')
                self.assertNotIn('fixture-never-output',output.getvalue())


if __name__=='__main__': unittest.main()
