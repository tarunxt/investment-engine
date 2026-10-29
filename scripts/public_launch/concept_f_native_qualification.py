"""Exact-source disposable SQLite/browser qualification, never hosted/PG/Redis evidence.

One committed archive/build, sequential actual-auth fixtures, bounded process groups.
Only the existing CI webpack runner invokes this; no provider credentials are inherited.
"""
from pathlib import Path
import argparse,io,json,os,re,shutil,signal,socket,subprocess,sys,tarfile,tempfile,time
import xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[2]
SCENARIOS=('snapshot','research','legacy-table','legacy-formula','plans','utilities','library','journal','model-selection','long-text','zero','us-import','threats','onboarding','profile')
CASES=tuple((name,'concept-f-'+name,'filled',False) for name in SCENARIOS)+tuple(('safety-'+outcome,'concept-f-safety',outcome,False) for outcome in ('filled','partial','before_acceptance'))+(('screen-capture','concept-f-legacy-formula','filled',True),)

def evidence_path(value):
    path=Path(value)
    if not str(path).startswith('/tmp/') or path.is_symlink() or not path.resolve().is_relative_to(Path('/tmp').resolve()):
        raise ValueError('Dedicated /tmp evidence directory required')
    return path

def verify_case(receipt,junit,expected):
    if not re.fullmatch(r'[a-f0-9]{40}',expected):raise ValueError('Exact source SHA required')
    if receipt.get('passed') is not True or receipt.get('source_binding_verified') is not True or receipt.get('source_sha')!=expected or receipt.get('harness_sha')!=expected:
        raise ValueError('Passing exact compiled/backend/harness source receipt required')
    if receipt.get('sqlite') is not True or any(receipt.get(key) is not False for key in ('postgresql','redis','hosted')):
        raise ValueError('Disposable SQLite evidence must not claim hosted/PG/Redis qualification')
    if not isinstance(receipt.get('checks'),list) or not receipt['checks']:raise ValueError('Actual browser assertions required')
    tree=ET.parse(junit).getroot()
    if len(tree.findall('.//testcase'))!=1 or any(tree.findall('.//'+key) for key in ('skipped','failure','error')):
        raise ValueError('The actual native fixture must execute once without skips or failures')

def verify_native_workspace_observation(value,source,base):
    """Actual supported normal-profile UI observation, never hosted sign-off."""
    if not re.fullmatch(r'[a-f0-9]{40}',source) or not re.fullmatch(r'http://localhost:[1-9][0-9]{0,4}',base) or int(base.rsplit(':',1)[1])>65535:
        raise ValueError('Exact local source binding required')
    expected={'source_sha':source,'start_url':base+'/console/dashboard',
        'visible_build_prefix':source[:12],'normal_profile':True,'native_zoom_percent':200,
        'keyboard_primary_focus':'Review exact instructions',
        'primary_destination':base+'/console/profile/activity#order-review-heading',
        'keyboard_refresh_focus':'Review recorded status','refresh_activated':True,
        'created_tab_closed':True,'existing_user_tabs_untouched':True}
    if not isinstance(value,dict) or any(value.get(k)!=v or isinstance(v,bool) and value.get(k) is not v for k,v in expected.items()):
        raise ValueError('Complete actual native workspace actions required')
    original=value.get('original_zoom_percent')
    if type(original) is not int or not 25<=original<=500 or type(value.get('restored_zoom_percent')) is not int or value['restored_zoom_percent']!=original:
        raise ValueError('Actual original zoom restoration required')
    if type(value.get('native_zoom_percent')) is not int:
        raise ValueError('Actual numeric native zoom required')


def run_group(command,*,cwd,env,log,timeout):
    with Path(log).open('w') as stream:
        process=subprocess.Popen(command,cwd=cwd,env=env,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
        try:return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            # This group was created above; never discover/kill unrelated processes.
            os.killpg(process.pid,signal.SIGTERM)
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
            raise

def main():
    parser=argparse.ArgumentParser(__doc__);parser.add_argument('--source',required=True);parser.add_argument('--evidence',required=True);parser.add_argument('--plan',action='store_true');args=parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{40}',args.source):raise SystemExit('Full source SHA required')
    evidence=evidence_path(args.evidence)
    if args.plan:
        print(json.dumps({'source_sha':args.source,'cases':[row[0] for row in CASES],'cases_total':len(CASES),'builds':1,'sqlite':True,'postgresql':False,'redis':False,'hosted':False}));return
    if os.getenv('CREDX_CONCEPT_F_QUALIFICATION')!='disposable-loopback-only':raise SystemExit('Explicit disposable qualification scope required')
    actual=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    if actual!=args.source:raise SystemExit('Checkout must be the exact requested source')
    if evidence.exists():raise SystemExit('Refusing to overwrite prior qualification evidence')
    node=shutil.which('node')
    if not node or not (ROOT/'frontend/node_modules/next/dist/bin/next').is_file():raise SystemExit('Existing installed frontend dependencies required')
    safe={key:os.environ[key] for key in ('PATH','HOME','TMPDIR','LANG','LC_ALL','PLAYWRIGHT_BROWSERS_PATH') if key in os.environ}
    safe.update(ENVIRONMENT='test',STAGE01_PREVIEW='synthetic-only',PYTHONDONTWRITEBYTECODE='1')
    browser=os.getenv('CONCEPT_F_CHROMIUM_PATH') or subprocess.check_output([node,'--input-type=module','-e',"import {chromium} from 'playwright'; console.log(chromium.executablePath())"],cwd=ROOT/'frontend',env=safe,text=True).strip()
    if not Path(browser).is_file():raise SystemExit('Existing installed Chromium required; this runner does not install/download it')
    evidence.mkdir(parents=True);runtime=ROOT/'.runtime';runtime.mkdir(exist_ok=True)
    archive=Path(tempfile.mkdtemp(prefix='concept-f-ci-'+args.source[:12]+'-',dir=runtime));started=time.monotonic();deadline=started+840
    summary={'schema_version':1,'source_sha':args.source,'passed':False,'sqlite':True,'postgresql':False,'redis':False,'hosted':False,'full_visual_acceptance':False,'cases':[],'unrun':[]}
    try:
        with tarfile.open(fileobj=io.BytesIO(subprocess.check_output(['git','archive',args.source],cwd=ROOT))) as bundle:bundle.extractall(archive,filter='data')
        (archive/'frontend/node_modules').symlink_to(ROOT/'frontend/node_modules',target_is_directory=True)
        (archive/'source.json').write_text(json.dumps({'sha':args.source})+'\n')
        build=run_group([sys.executable,str(archive/'scripts/public_launch/preview.py'),'build','--concept-f-ui'],cwd=archive,env=safe,log=evidence/'build.log',timeout=min(300,deadline-time.monotonic()))
        if build:raise RuntimeError('Committed archive build failed; see build.log')
        summary['build_passed']=True
        for index,(name,scenario,outcome,capture) in enumerate(CASES):
            remaining=deadline-time.monotonic()
            if remaining<30:summary['unrun']=[row[0] for row in CASES[index:]];break
            target=evidence/name;target.mkdir();env={**safe,'PYTHONPATH':str(archive/'backend')+':'+str(archive),'CREDX_LOCAL_NATIVE_BROWSER':'disposable-loopback-only','LOCAL_NATIVE_NODE':node,'LOCAL_NATIVE_NEXT_DIR':'.next','CONCEPT_F_CHROMIUM_PATH':browser,'LOCAL_NATIVE_BROWSER_SCENARIO':scenario,'LOCAL_NATIVE_BROWSER_ORDER_OUTCOME':outcome,'LOCAL_NATIVE_BROWSER_EVIDENCE':str(target)}
            if capture:env['LOCAL_NATIVE_BROWSER_CAPTURE_ONLY']='source-bound-read-only'
            for key in ('LOCAL_NATIVE_BACKEND_PORT','LOCAL_NATIVE_FRONTEND_PORT'):
                with socket.socket() as sock:sock.bind(('127.0.0.1',0));env[key]=str(sock.getsockname()[1])
            item={'name':name,'scenario':scenario,'outcome':outcome,'passed':False}
            try:
                code=run_group([sys.executable,'-m','pytest','-q','--junitxml='+str(target/'junit.xml'),'backend/tests/test_local_native_composition_browser.py'],cwd=archive,env=env,log=target/'pytest.log',timeout=min(450 if capture else 240,remaining))
                item['exit_code']=code
                if code:raise RuntimeError('Native fixture failed; inspect retained pytest/browser receipt')
                receipt=json.loads((target/'receipt.json').read_text());verify_case(receipt,target/'junit.xml',args.source)
                if capture:
                    observed=receipt.get('observed_screens',[])
                    if len({row.get('id') for row in observed})!=57 or any(row.get('status')=='capture failed' for row in observed):raise ValueError('All 57 available-route captures must finish; captures are not visual acceptance')
                item.update(passed=True,browser_checks=len(receipt['checks']),source_binding_verified=True)
            except Exception as error:item['error']=type(error).__name__+': '+str(error)
            summary['cases'].append(item);(evidence/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
            print(json.dumps(item),flush=True)
        summary['passed']=len(summary['cases'])==len(CASES) and not summary['unrun'] and all(row['passed'] for row in summary['cases'])
    except Exception as error:summary['error']=type(error).__name__+': '+str(error)
    finally:
        summary['elapsed_seconds']=round(time.monotonic()-started,2);(evidence/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    if not summary['passed']:raise SystemExit('Exact-source Concept F native qualification incomplete; inspect retained summary')
if __name__=='__main__':main()
