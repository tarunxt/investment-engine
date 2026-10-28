"""Exact-source synthetic F53 UI qualification; no deployment or native input."""
import argparse,io,json,os,re,socket,subprocess,sys,tarfile,tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True)
    parser.add_argument('--node',required=True)
    parser.add_argument('--browser',required=True)
    parser.add_argument('--evidence',required=True)
    args=parser.parse_args()
    if not re.fullmatch('[a-f0-9]{40}',args.source):parser.error('Exact source commit required')
    assert subprocess.check_output(['git','rev-parse',args.source+'^{commit}'],cwd=ROOT,text=True).strip()==args.source
    evidence=Path(args.evidence).resolve();assert not evidence.exists(),'Fresh evidence directory required';evidence.mkdir(parents=True)
    runtime=ROOT/'.runtime';runtime.mkdir(exist_ok=True)
    archive=Path(tempfile.mkdtemp(prefix='f53-ci-'+args.source[:12]+'-',dir=runtime))
    result={'source_sha':args.source,'passed':False,'sqlite':True,'postgresql':False,'redis':False,'hosted':False,'native_zoom':False}
    try:
        with tarfile.open(fileobj=io.BytesIO(subprocess.check_output(['git','archive',args.source],cwd=ROOT))) as bundle:bundle.extractall(archive,filter='data')
        (archive/'source.json').write_text(json.dumps({'sha':args.source})+'\n')
        (archive/'frontend/node_modules').symlink_to(ROOT/'frontend/node_modules',target_is_directory=True)
        assert not any((base/name).exists() for base in [archive,archive/'frontend'] for name in ['.env','.env.local','.env.production','.env.production.local'])
        env={key:value for key,value in os.environ.items() if key in {'PATH','HOME','TMPDIR','TMP','TEMP','SYSTEMROOT','RUNNER_TEMP'}}
        env.update(NEXT_TELEMETRY_DISABLED='1',NEXT_PUBLIC_UAT2='true',NEXT_PUBLIC_UAT2_COMMIT=args.source,NEXT_PUBLIC_DISABLE_AUTH='false',NEXT_PUBLIC_DISABLE_API_PROXY='false')
        with (evidence/'build.log').open('w') as log:
            subprocess.run([args.node,'node_modules/next/dist/bin/next','build','--webpack'],cwd=archive/'frontend',env=env,stdout=log,stderr=subprocess.STDOUT,timeout=300,check=True)
            subprocess.run([args.node,'../deploy/no-docker/repair-next-runtime-artifacts.mjs','.','.next'],cwd=archive/'frontend',env=env,stdout=log,stderr=subprocess.STDOUT,timeout=30,check=True)
        from scripts.public_launch.concept_f_build_receipt import write_receipt
        binding=write_receipt(archive);(evidence/'build-binding.json').write_text(json.dumps(binding,indent=2)+'\n');result['build_passed']=True
        env.update(ENVIRONMENT='test',STAGE01_PREVIEW='synthetic-only',CREDX_LOCAL_NATIVE_BROWSER='disposable-loopback-only',LOCAL_NATIVE_F53_BROWSER='read-only-reference-ui',LOCAL_NATIVE_NODE=args.node,LOCAL_NATIVE_NEXT_DIR='.next',CONCEPT_F_CHROMIUM_PATH=args.browser,LOCAL_NATIVE_BROWSER_EVIDENCE=str(evidence/'browser'),PYTHONPATH=str(archive/'backend')+os.pathsep+str(archive))
        for key in ['LOCAL_NATIVE_BACKEND_PORT','LOCAL_NATIVE_FRONTEND_PORT']:
            with socket.socket() as sock:sock.bind(('127.0.0.1',0));env[key]=str(sock.getsockname()[1])
        with (evidence/'pytest.log').open('w') as log:
            subprocess.run([sys.executable,'-m','pytest','-q','--junitxml='+str(evidence/'junit.xml'),'backend/tests/test_incremental_calculation_browser.py'],cwd=archive,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=240,check=True)
        receipt=json.loads((evidence/'browser/receipt.json').read_text())
        assert receipt['passed'] and receipt['source_binding_verified'] and receipt['browser_cleanup_completed']
        assert receipt['source_sha']==args.source and receipt['harness_sha']==args.source and len(receipt['checks'])==17
        assert receipt['sqlite'] and not any(receipt[key] for key in ['postgresql','redis','hosted','native_zoom'])
        result.update(passed=True,browser_checks=17,source_binding_verified=True,cleanup_verified=True)
    except Exception as error:
        result['error']=type(error).__name__+': '+str(error)
        raise
    finally:
        (evidence/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))

if __name__=='__main__':main()
