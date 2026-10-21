#!/usr/bin/env python3
"""Disposable GitHub Linux VM integration; no live host or provider operations.

Runs exact candidate controller/helper and exact migration-unit confinement. App, Redis,
certificate and proxy commands are synthetic service fixtures, not CredX/UI/login.
Only host identity checks are substituted when testing the pending-marker CLI gate;
no identity marker or metadata endpoint is created. Application/controller/helper source files are never edited; declared service fixtures replace app processes only.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import threading
import time
from unittest.mock import patch

CANDIDATE=os.environ.get('CREDX_STAGE13_SOURCE','')
BASE='367173d5891ad7a8da77c7628f47915248f489c9'
REPO=Path(__file__).resolve().parents[2]
ROOT=Path('/opt/credx-uat2');CONFIG=Path('/etc/credx-uat2');DATA=Path('/var/lib/credx-uat2')
FIXTURE=Path('/opt/stage13-controller-ci')
OUT=Path('/tmp/stage13-controller-ci')
URL='postgresql+psycopg2://credx_uat2:synthetic-ci-only@127.0.0.1:5542/credx_uat2'
SAFE_ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','PYTHONDONTWRITEBYTECODE':'1','CI':'true','GITHUB_ACTIONS':'true','CREDX_STAGE13_CONTROLLER_ACK':'disposable-linux-ci-only','CREDX_STAGE13_SOURCE':CANDIDATE}
REAL_RUN=subprocess.run


def command(args,*,check=True,**kwargs):
    result=REAL_RUN([str(a) for a in args],env=SAFE_ENV,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180,**kwargs)
    if check and result.returncode:
        raise RuntimeError('CI fixture command failed: '+str(args[0])+'; '+result.stderr.decode(errors='replace')[-1500:])
    return result


def git(*args):return command(['git','-c','safe.directory='+str(REPO),'-C',REPO,*args]).stdout


def guard():
    if os.geteuid()!=0 or sys.platform!='linux' or not Path('/run/systemd/system').is_dir():raise RuntimeError('Disposable Linux systemd VM required')
    for key,value in {'CI':'true','GITHUB_ACTIONS':'true','CREDX_STAGE13_CONTROLLER_ACK':'disposable-linux-ci-only'}.items():
        if os.environ.get(key)!=value:raise RuntimeError('Exact synthetic CI acknowledgement required')
    if not str(REPO).startswith('/home/runner/work/') or any(p.exists() for p in [Path('/etc/investor'),Path('/srv/investor')]):raise RuntimeError('Refuse non-runner or existing application host')
    if not re.fullmatch(r'[0-9a-f]{40}',CANDIDATE) or git('rev-parse','HEAD').decode().strip()!=CANDIDATE:raise RuntimeError('Exact Stage13 candidate checkout required')
    git('merge-base','--is-ancestor',BASE,CANDIDATE)
    if git('status','--porcelain').strip():raise RuntimeError('Clean committed checkout required')
    return git('rev-parse','HEAD').decode().strip()


READINESS_FAILURE_MESSAGE='Bounded UAT2 readiness failed; inspect private logs'

class ObservedReadinessFailure(RuntimeError):
    """Only emitted after positive503 evidence and the actual controller error."""


def observe_readiness_failure(readiness, statuses, case, *, timeout=10, interval=.1):
    deadline=time.monotonic()+timeout
    while True:
        try:observed=statuses()
        except (RuntimeError,OSError,ValueError):observed=None
        if observed==[503,503]:break
        if time.monotonic()>=deadline:
            raise AssertionError('Both application503 responses were not observed')
        time.sleep(interval)
    case['injected_http_statuses']=observed
    started=time.monotonic()
    try:readiness()
    except RuntimeError as exc:
        if str(exc)!=READINESS_FAILURE_MESSAGE:
            raise AssertionError('Unexpected controller error, not bounded readiness failure') from exc
        case['controller_readiness_failure_observed']=True
        case['controller_readiness_error']=str(exc)
        case['controller_readiness_elapsed_seconds']=round(time.monotonic()-started,3)
        raise ObservedReadinessFailure('Observed503 and actual bounded controller readiness failure') from exc
    raise AssertionError('Injected readiness fault did not fail the actual controller check')


def write(path,text,mode=0o600):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text);path.chmod(mode)


def state_json(path,value):write(path,json.dumps(value,indent=2,default=str)+'\n')


def load_module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def install_fixture(python):
    for directory in [ROOT,CONFIG,DATA,FIXTURE,OUT]:
        if directory.exists():raise RuntimeError('Fresh runner paths required: '+str(directory))
    for directory in [ROOT,CONFIG,DATA,FIXTURE,OUT]:directory.mkdir(parents=True)
    for name in ['app','web','db','redis','certs','proxy']:
        command(['useradd','--system','--no-create-home','--shell','/usr/sbin/nologin','credx-uat2-'+name])
    command([python,'-m','venv',FIXTURE/'venv'])
    command([FIXTURE/'venv/bin/pip','install','--disable-pip-version-check','-r',REPO/'backend/requirements.txt'])
    shutil.copyfile(REPO/'backend/scripts/stage10_fixtures/service.py',FIXTURE/'service.py');(FIXTURE/'service.py').chmod(0o644)
    assert (FIXTURE/'service.py').read_bytes()==git('show',CANDIDATE+':backend/scripts/stage10_fixtures/service.py')
    for source in [BASE,CANDIDATE]:
        release=ROOT/'releases'/source;release.mkdir(parents=True)
        archive=git('archive',source,'backend','deploy/uat2')
        import io
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:tar.extractall(release,filter='data')
        (release/'frontend-runtime').mkdir()
        (release/'.venv').symlink_to(FIXTURE/'venv',target_is_directory=True)
        write(release/'native-manifest.json',json.dumps({'source_commit':source,'synthetic_ci_install':True}),0o644)
        units=release/'deploy/uat2/native/systemd'
        for name,port in [('backend',8002),('frontend',3002),('worker',0),('proxy',0),('certs',18082),('redis',0)]:
            path=units/('credx-uat2-'+name+'.service');text=path.read_text()
            text=re.sub(r'^ExecStart=.*$',f'ExecStart=/usr/bin/python3 {FIXTURE}/service.py {port}',text,flags=re.M)
            write(path,text,0o644)
        # Exact original migrate, network and postgres units and network policy;
        # only non-migration application/dependency commands are CI stand-ins.
        for relative in ['deploy/uat2/native/ctl.py','deploy/uat2/native/systemd/credx-uat2-migrate.service','deploy/uat2/native/schema_service.py','backend/alembic/versions/indmoney_integrity_001.py','backend/alembic/versions/durable_analysis_001.py','backend/alembic/versions/ai_limits_001.py','backend/alembic/versions/connection_attempts_001.py']:
            if source==CANDIDATE:assert (release/relative).read_bytes()==git('show',source+':'+relative)
    (ROOT/'current').symlink_to(ROOT/'releases'/BASE,target_is_directory=True)
    app=pwd.getpwnam('credx-uat2-app');db=pwd.getpwnam('credx-uat2-db')
    for directory,user in [(DATA/'postgres',db),(DATA/'artifacts',app),(DATA/'redis',pwd.getpwnam('credx-uat2-redis')),(DATA/'proxy',pwd.getpwnam('credx-uat2-proxy'))]:
        directory.mkdir(mode=0o700);os.chown(directory,user.pw_uid,user.pw_gid)
    command(['runuser','-u','credx-uat2-db','--','/usr/lib/postgresql/16/bin/initdb','-D',DATA/'postgres','--auth-local=peer','--auth-host=scram-sha-256'])
    write(CONFIG/'postgresql.conf',"listen_addresses='127.0.0.1'\nport=5542\nunix_socket_directories='/run/credx-uat2-postgres'\nshared_buffers='64MB'\nmax_connections=30\n",0o644)
    write(CONFIG/'pg_hba.conf','local all all peer\nhost all all 127.0.0.1/32 scram-sha-256\n',0o644)
    write(CONFIG/'backend.env','CREDX_UAT2=1\nENVIRONMENT=uat2\nAUTH_DISABLED=false\nUAT2_RUNTIME=native\nUAT2_ADAPTERS=simulation\nDATABASE_URL='+URL+'\nREDIS_URL=redis://127.0.0.1:6479/0\nGOOGLE_SIGNIN_CLIENT_ID=synthetic-ci-only\nUAT2_JWT_SIGNING_KEY='+('a'*40)+'\n')
    write(CONFIG/'frontend.env','CREDX_UAT2=1\nBACKEND_API_URL=http://127.0.0.1:8002\nNEXTAUTH_URL=https://uat2.cred-x.in\nNEXT_PUBLIC_DISABLE_AUTH=false\nNEXTAUTH_SECRET='+('b'*40)+'\n')
    write(CONFIG/'barrier.env','UAT2_BARRIER_USER=synthetic\nUAT2_BARRIER_HASH=$2synthetic-only\n')
    write(CONFIG/'release.env','UAT2_SOURCE_COMMIT='+BASE+'\n')


def sql_admin(sql, database='postgres'):
    return command(['runuser','-u','credx-uat2-db','--','/usr/lib/postgresql/16/bin/psql','-X','-v','ON_ERROR_STOP=1','-h','/run/credx-uat2-postgres','-p','5542','-d',database,'-At','-c',sql]).stdout.decode().strip()


def assert_stopped(ctl):
    ctl.require_apps_stopped()
    assert all(command(['systemctl','is-active','--quiet','credx-uat2-'+n+'.service'],check=False).returncode==3 for n in ctl.APPS)


def assert_start_blocked(ctl):
    # CI is intentionally not an AWS host. Substitute ONLY the IMDS host guard;
    # config validation, pending-file check and actual lock are unchanged.
    with patch.object(ctl,'host_guard'),patch.object(sys,'argv',['ctl.py','start']):
        try:ctl.main()
        except RuntimeError as exc:assert 'Unfinished deployment' in str(exc)
        else:raise AssertionError('Pending operation allowed a start')
    assert_stopped(ctl)


def wait_inactive(unit,timeout=130):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if command(['systemctl','show',unit,'--property=ActiveState','--value']).stdout.strip() in {b'inactive',b'failed'}:return
        time.sleep(.1)
    raise RuntimeError('Fixture unit did not settle')


def child_rollback(argument, kill_after_commit=False):
    sys.path.insert(0,str(ROOT/'releases'/CANDIDATE/'deploy/uat2/native'))
    import ctl
    if kill_after_commit:
        original=ctl.schema_operation
        def terminate(release,action,**kwargs):
            if action=='verify':os.kill(os.getpid(),signal.SIGKILL)
            return original(release,action,**kwargs)
        with patch.object(ctl,'schema_operation',side_effect=terminate):ctl.rollback(argument)
    else:ctl.rollback(argument)


def run_suite(python,group):
    import sqlalchemy as sa
    sys.path.insert(0,str(ROOT/'releases'/CANDIDATE/'deploy/uat2/native'))
    import ctl
    helper=load_module('candidate_schema',ROOT/'releases'/CANDIDATE/'deploy/uat2/native/schema_service.py')
    candidate=ROOT/'releases'/CANDIDATE;previous=ROOT/'releases'/BASE
    ctl.configure_units(candidate)
    ctl.systemctl('start',['network','postgres','redis','certs'])
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        if command(['/usr/lib/postgresql/16/bin/pg_isready','-h','/run/credx-uat2-postgres','-p','5542'],check=False).returncode==0:break
        time.sleep(.2)
    else:raise RuntimeError('Fresh fixture PostgreSQL did not become ready within20s')
    sql_admin("CREATE ROLE credx_uat2 LOGIN PASSWORD 'synthetic-ci-only';")
    engine=sa.create_engine(URL,hide_parameters=True,connect_args={'options':'-c statement_timeout=10000 -c lock_timeout=3000'})
    cases=[]
    def sequences():
        with engine.connect() as conn:
            return {n:list(conn.execute(sa.text('SELECT last_value,is_called FROM public.'+conn.dialect.identifier_preparer.quote_identifier(n))).one()) for n in sorted(sa.inspect(conn).get_sequence_names(schema='public'))}
    def detailed_capture(label):
        # Diagnostics only on the guarded synthetic runner. Capture the exact
        # fingerprint input without changing hash bytes or the confined helper.
        payloads=[];original_sha=helper.sha
        def observe(payload):
            value=json.loads(payload)
            if isinstance(value,dict) and {'tables','sequences','catalog'}<=value.keys():payloads.append(value)
            return original_sha(payload)
        with patch.object(helper,'sha',side_effect=observe):state=helper.capture(engine)
        assert len(payloads)==1
        state_json(OUT/(label+'-snapshot.json'),payloads[0])
        return state
    def prepare(name):
        ctl.systemctl('stop',ctl.APPS);wait_inactive('credx-uat2-migrate.service')
        engine.dispose()
        sql_admin('DROP DATABASE IF EXISTS credx_uat2 WITH (FORCE);');sql_admin('CREATE DATABASE credx_uat2 OWNER credx_uat2;')
        # Discard/reset only this synthetic fixture between independent cases.
        for path in [ctl.pending(),CONFIG/'schema-operation.env',ROOT/'current.new',FIXTURE/'readiness-fail']:
            path.unlink(missing_ok=True)
        ctl.promote(previous);ctl.configure_units(previous)
        ctl.systemctl('start',['migrate'])  # real Stage09 baseline migration, existing confined service
        with engine.begin() as conn:
            conn.execute(sa.text("CREATE SEQUENCE public.ci_explicit_sequence START 37"))
            conn.execute(sa.text("SELECT setval('public.ci_explicit_sequence',91,true)"))
            conn.execute(sa.text("CREATE TABLE public.ci_payload (id integer PRIMARY KEY, value text NOT NULL)"))
            conn.execute(sa.text("INSERT INTO public.ci_payload VALUES (1,'original synthetic row')"))
        # Seed existing Stage09 private rows BEFORE the backup. Their opaque
        # ciphertext and all other baseline data must survive Stage13 recovery.
        with engine.begin() as conn:
            # Synthetic binding owned by synthetic user; no provider calls/secret tooling.
            from sqlalchemy import MetaData,Table
            users=Table('users',MetaData(),autoload_with=conn)
            conn.execute(users.insert().values(email='owner@controller.example.invalid',username='controller_fixture',password_hash='unusable',full_name='Synthetic controller owner',role=('USER' if 'USER' in users.c.role.type.enums else 'user'),is_active=True,is_verified=True,created_at=datetime.now(timezone.utc).replace(tzinfo=None),updated_at=datetime.now(timezone.utc).replace(tzinfo=None)))
            owner=conn.scalar(sa.text("SELECT id FROM users WHERE username='controller_fixture'"))
            conn.execute(sa.text("INSERT INTO integration_connections (id,owner_id,provider,app_ownership_mode,provider_account_id,credential_ref,status,version,is_current) VALUES ('ci-binding',:owner,'zerodha','user_owned','FAKEBASE','ci-private','configured',1,true)"),{'owner':owner})
            conn.execute(sa.text("INSERT INTO connection_credentials (id,connection_id,owner_id,ciphertext,key_version) VALUES ('ci-private','ci-binding',:owner,'opaque-synthetic-only',1)"),{'owner':owner})
        with engine.begin() as conn:
            conn.execute(sa.text("INSERT INTO indmoney_us_portfolio_snapshots (id,user_id,snapshot_date,captured_at,source,raw_text,parse_status,parse_warnings,holdings_count,indices_count,market_indices,dashboard_top_holdings,holdings,created_at,updated_at) VALUES (9001,:owner,CURRENT_DATE,now(),'synthetic_ci','SYNTHETIC LEGACY PORTFOLIO','parsed','[]',0,0,'[]','[]','[]',now(),now())"),{'owner':owner})
        before=detailed_capture(name+'-baseline');before_sequences=sequences()
        assert before['revision']=='durable_analysis_001' and not before['stage13_columns'] and bool(before['stage12_columns']) and set(before['stage10_tables'])=={'connection_attempts','connection_binding_history'}
        saved=ctl.backup(candidate);receipt=ctl.private_json(saved.with_suffix('.json'))
        assert receipt['source_commit']==BASE and receipt['fingerprint']==before['fingerprint']
        assert receipt['schema_revision']=='durable_analysis_001'
        ctl.configure_units(candidate);ctl.write_release_environment(candidate)
        ctl.systemctl('start',['migrate'])
        with engine.begin() as conn:
            conn.execute(sa.text("INSERT INTO connection_attempts (id,owner_id,connection_id,connection_version,app_mode,app_fingerprint,session_digest,state_digest,expires_at,candidate_ciphertext,candidate_key_version) VALUES ('ci-attempt',:owner,'ci-binding',1,'user_owned',:fingerprint,:session,:state,now()+interval '5 minutes','opaque-synthetic-candidate-only',1)"),{'owner':owner,'fingerprint':'a'*64,'session':'b'*64,'state':'c'*64})
            conn.execute(sa.text("INSERT INTO connection_binding_history (id,connection_id,owner_id,connection_version,app_mode,provider_account_id,ciphertext,key_version) VALUES ('ci-history','ci-binding',:owner,1,'user_owned','FAKEBASE','opaque-synthetic-only',1)"),{'owner':owner})
            conn.execute(sa.text("UPDATE integration_connections SET provider_account_id='FAKENEXT',version=2 WHERE id='ci-binding'"))
            conn.execute(sa.text("UPDATE connection_credentials SET ciphertext='opaque-synthetic-new' WHERE id='ci-private'"))
            conn.execute(sa.text("INSERT INTO indmoney_us_portfolio_snapshots (id,user_id,snapshot_date,captured_at,source,raw_text,parse_status,parse_warnings,holdings_count,indices_count,market_indices,dashboard_top_holdings,holdings,created_at,updated_at,acceptance_state,import_key,content_hash,import_provenance,accepted_at) VALUES (9002,:owner,CURRENT_DATE,now(),'synthetic_ci','SYNTHETIC ACCEPTED PORTFOLIO','parsed','[]',0,0,'[]','[]','[]',now(),now(),'accepted',:key,:hash,:provenance,now())").bindparams(sa.bindparam('provenance',type_=sa.JSON)),{'owner':owner,'key':'1'*64,'hash':'2'*64,'provenance':{'parser_version':'synthetic-controller-only','source_hash':'3'*64,'currency':'USD'}})
            conn.execute(sa.text("INSERT INTO auto_rebalance_workflows (id,user_id,portfolio,sequence,label,status,current_stage,orchestration_kind,request_key,execution_json,control_version,created_at,updated_at) VALUES (9001,:owner,'indmoney_us',1,'Synthetic durable workflow','partial','threats','analysis_v1','synthetic-controller-key',:inputs,0,now(),now())").bindparams(sa.bindparam('inputs',type_=sa.JSON)),{'owner':owner,'inputs':{'synthetic':True,'orders_authorized':False}})
            conn.execute(sa.text("INSERT INTO auto_rebalance_workflow_stages (workflow_id,stage,status,checkpoint_json,attempt_count,created_at,updated_at) VALUES (9001,'sync','completed',:checkpoint,1,now(),now())").bindparams(sa.bindparam('checkpoint',type_=sa.JSON)),{'checkpoint':{'attempts':[{'number':1,'cost_usd':'0'}],'synthetic':True}})
            conn.execute(sa.text("INSERT INTO zerodha_portfolio_snapshots (user_id,snapshot_date,captured_at,source,holdings_count,net_positions_count,day_positions_count,holdings_market_value,holdings_pnl,holdings_day_change_value,available_margin,positions_pnl,positions_m2m,dashboard_top_holdings,holdings,net_positions,day_positions,acquisition_json,created_at,updated_at) VALUES (:owner,CURRENT_DATE,now(),'synthetic_ci',0,0,0,0,0,0,0,0,0,'[]','[]','[]','[]',:receipt,now(),now())").bindparams(sa.bindparam('receipt',type_=sa.JSON)),{'owner':owner,'receipt':{'synthetic':True,'provider_calls':False}})
            conn.execute(sa.text("INSERT INTO recommendation_spend_accounts (id,user_id,day,cap_usd,spent_usd,reserved_usd,last_admitted_owner) VALUES ('ci-account',:owner,'2026-10-21',1,0,.05,NULL)"),{'owner':owner})
            conn.execute(sa.text("INSERT INTO recommendation_spend_attempts (id,user_id,account_id,attempt_key,adapter,tariff_version,upper_bound_usd,status,created_at,operation_key,module_id,module_version,request_hash,limits_json,input_tokens,output_tokens) VALUES ('ci-budget',:owner,'ci-account','attempt-1','stage13-bound-analysis','synthetic-v1',.05,'uncertain',now(),'ci-op','indmoney_us',1,:hash,'{}',100,100)"),{'owner':owner,'hash':'a'*64})
            conn.execute(sa.text("UPDATE ci_payload SET value='post-backup mutation' WHERE id=1"))
            conn.execute(sa.text("SELECT setval('public.ci_explicit_sequence',177,false)"))
        ctl.promote(candidate)
        recovery_source=BASE
        if name=='same_revision':
            # A repeat deploy at Stage13 must recover its own complete Stage13
            # snapshot without crossing a schema boundary.
            before=detailed_capture(name+'-baseline');before_sequences=sequences()
            saved=ctl.backup(candidate);receipt=ctl.private_json(saved.with_suffix('.json'))
            assert receipt['source_commit']==CANDIDATE and receipt['schema_revision']=='ai_limits_001'
            recovery_source=CANDIDATE
            with engine.begin() as conn:conn.execute(sa.text("UPDATE ci_payload SET value='same-revision post-backup mutation' WHERE id=1"))
        ctl.durable_json(ROOT/'deployment-receipt.json',{'schema_version':2,'operation':'deploy','candidate':CANDIDATE,'previous_source':recovery_source,'backup':ctl.backup_reference(saved,receipt)})
        return saved,before,before_sequences
    def capture_results(case):
        case['final_database_state']=detailed_capture(case['name']+'-final')
        case['pending']=ctl.pending().exists();case['source']=ctl.current().name
        case['operation_environment_cleaned']=not (CONFIG/'schema-operation.env').exists()
        if ctl.pending().exists():case['marker']=ctl.private_json(ctl.pending())
        case['sequences']=sequences()
        state_json(OUT/(case['name']+'.json'),case)
    def preservation():
        record=ctl.private_json(ctl.pending());material=record['material'];path=DATA/'artifacts/native-schema'/(material['request']+'-material.json')
        assert stat.S_IMODE(path.stat().st_mode)==0o600 and path.stat().st_uid==pwd.getpwnam('credx-uat2-app').pw_uid
        assert hashlib.sha256(path.read_bytes()).hexdigest()==material['sha256']
        assert command(['runuser','-u','credx-uat2-web','--','test','-r',path],check=False).returncode!=0
        payload=json.loads(path.read_text())
        assert payload['revision']=='ai_limits_001'
        assert set(payload['tables'])=={'integration_connections','connection_credentials','connection_attempts','connection_binding_history','indmoney_us_portfolio_snapshots','auto_rebalance_workflows','auto_rebalance_workflow_stages','jobs','outbox','zerodha_portfolio_snapshots','recommendation_spend_accounts','recommendation_spend_attempts'}
        assert payload['tables']['auto_rebalance_workflows'][0]['execution_json']['synthetic'] is True
        assert payload['tables']['auto_rebalance_workflow_stages'][0]['checkpoint_json']['attempts'][0]['cost_usd']=='0'
        assert payload['tables']['zerodha_portfolio_snapshots'][0]['acquisition_json']=={'synthetic':True,'provider_calls':False}
        assert payload['tables']['recommendation_spend_attempts'][0]['operation_key']=='ci-op'
        assert payload['tables']['recommendation_spend_attempts'][0]['status']=='uncertain'
        imports=payload['tables']['indmoney_us_portfolio_snapshots']
        assert {row['id'] for row in imports}=={9001,9002}
        accepted=next(row for row in imports if row['id']==9002)
        assert accepted['import_provenance']['source_hash']=='3'*64 and accepted['acceptance_state']=='accepted'
        assert accepted['content_hash']=='2'*64
        assert len(payload['tables']['connection_attempts'])==1
        assert payload['tables']['connection_credentials'][0]['ciphertext']=='opaque-synthetic-new'
        assert payload['tables']['connection_binding_history'][0]['ciphertext']=='opaque-synthetic-only'
        assert payload['tables']['connection_binding_history'][0]['provider_account_id']=='FAKEBASE'
        return {'rows':material['rows'],'sha256':material['sha256'],'owner_uid':path.stat().st_uid,'mode':'0600','other_fixture_user_read_denied':True}
    def recover(saved,before,before_sequences):
        ctl.rollback(str(saved),recover_only=True)
        assert helper.capture(engine)==before and sequences()==before_sequences
        assert ctl.current()==previous and not ctl.pending().exists()
        assert not (CONFIG/'schema-operation.env').exists()
    def fail_trigger(body):
        # CI cluster superuser only, no live role or permission change.
        sql_admin("CREATE OR REPLACE FUNCTION public.ci_restore_fault() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN "+body+" END $$; CREATE EVENT TRIGGER ci_restore_fault ON ddl_command_end WHEN TAG IN ('CREATE INDEX') EXECUTE FUNCTION public.ci_restore_fault();",database='credx_uat2')
    groups={
        'core':['positive','same_revision','downgrade_failure','late_restore_error','restore_disconnect'],
        'interruptions':['restore_timeout','interrupted_before_commit','interrupted_after_commit','schema_interruption'],
        'finalization':['configure_failure','promotion_failure','partial_start_failure','readiness_failure'],
        'provenance':[],
    }
    scenarios=groups[group]
    for scenario in scenarios:
        case={'name':scenario,'status':'running','runtime_source':CANDIDATE,'synthetic_services':True};cases.append(case)
        print('CASE_START '+scenario,flush=True)
        try:
            saved,before,before_seq=prepare(scenario);case['baseline_sequences']=before_seq;case['mutated_sequences']=sequences()
            if scenario in {'positive','same_revision'}:
                actual_clear=ctl.clear_pending;actual_schema=ctl.schema_operation;actions=[]
                def record_clear():
                    case['preserved_material']=preservation()
                    actual_clear()
                def record_schema(*args,**kwargs):
                    actions.append(args[1]);return actual_schema(*args,**kwargs)
                with patch.object(ctl,'clear_pending',side_effect=record_clear),patch.object(ctl,'schema_operation',side_effect=record_schema):ctl.rollback(str(saved))
                assert helper.capture(engine)==before and sequences()==before_seq
                assert not ctl.pending().exists() and ctl.current()==(candidate if scenario=='same_revision' else previous)
                if scenario=='same_revision':assert 'downgrade' not in actions
                case['schema_actions']=actions
                case['backup_revision']=before['revision']
                case['real_controller_helper_postgresql_systemd_positive']=True
            elif scenario=='downgrade_failure':
                with engine.begin() as conn:conn.execute(sa.text('CREATE VIEW ci_binding_dependency AS SELECT operation_key FROM recommendation_spend_attempts'))
                original=helper.capture(engine)
                try:ctl.rollback(str(saved))
                except RuntimeError:pass
                else:raise AssertionError('Real downgrade unexpectedly succeeded')
                assert helper.capture(engine)==original;assert_start_blocked(ctl);case['preserved_material']=preservation()
                assert ctl.private_json(ctl.pending())['phase']=='downgrade_started'
                case['real_downgrade_failure_retains_original_state']=True
            elif scenario in {'late_restore_error','restore_disconnect','restore_timeout','interrupted_before_commit'}:
                if scenario=='late_restore_error':fail_trigger("RAISE EXCEPTION 'synthetic late restore fault';")
                else:fail_trigger('PERFORM pg_sleep(180);')
                before_restore={};connection_killer=None
                def process(args,**kwargs):
                    nonlocal connection_killer
                    if any(str(a).endswith('/pg_restore') for a in args):
                        assert '--single-transaction' in args;before_restore.update(state=helper.capture(engine),sequences=sequences())
                        if scenario=='restore_disconnect':
                            def kill_backend():
                                end=time.monotonic()+15
                                while time.monotonic()<end:
                                    # Match only this fixture's pg_restore, never arbitrary sessions.
                                    found=sql_admin("SELECT pid FROM pg_stat_activity WHERE datname='credx_uat2' AND usename='credx-uat2-db' AND application_name='pg_restore' AND wait_event='PgSleep'")
                                    if found:sql_admin('SELECT pg_terminate_backend('+str(int(found))+')');return
                                    time.sleep(.1)
                                raise RuntimeError('Restore fault did not reach sleeping backend')
                            connection_killer=threading.Thread(target=kill_backend);connection_killer.start()
                    result=REAL_RUN(args,**kwargs)
                    if any(str(a).endswith('/pg_restore') for a in args):
                        write(OUT/(scenario+'-restore.stderr.log'),result.stderr.decode(errors='replace'))
                    return result
                if scenario=='interrupted_before_commit':
                    # Real separate controller process; kill its process group while
                    # PostgreSQL is in the post-data transaction, then terminate only
                    # that orphan fixture backend to bound statement cleanup.
                    child=subprocess.Popen([python,__file__,'--worker',str(saved)],env={**SAFE_ENV,'PYTHONPATH':str(FIXTURE/'venv/lib/python3.12/site-packages')},start_new_session=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                    end=time.monotonic()+30
                    while time.monotonic()<end:
                        found=sql_admin("SELECT pid FROM pg_stat_activity WHERE datname='credx_uat2' AND application_name='pg_restore' AND wait_event='PgSleep'")
                        if found:break
                        if child.poll() is not None:raise RuntimeError('Controller exited before interruption: '+child.communicate()[1].decode()[-1200:])
                        time.sleep(.1)
                    else:child.kill();raise RuntimeError('Restore never reached interruption boundary')
                    os.killpg(child.pid,signal.SIGKILL)
                    sql_admin('SELECT pg_terminate_backend('+str(int(found))+')')
                    child.communicate(timeout=10)
                    assert child.returncode<0;case['controller_process_sigkill']=True
                    case['phase_at_interruption']=ctl.private_json(ctl.pending())['phase'];assert case['phase_at_interruption']=='restore_started'
                else:
                    try:
                        with patch.object(ctl.subprocess,'run',side_effect=process):ctl.rollback(str(saved))
                    except (RuntimeError,subprocess.TimeoutExpired) as exc:case['failure_type']=type(exc).__name__
                    else:raise AssertionError('Real restore fault unexpectedly succeeded')
                    if connection_killer:connection_killer.join(timeout=20);assert not connection_killer.is_alive()
                sleeping=sql_admin("SELECT pid FROM pg_stat_activity WHERE datname='credx_uat2' AND application_name='pg_restore' AND wait_event='PgSleep'")
                if sleeping:sql_admin('SELECT pg_terminate_backend('+str(int(sleeping))+')')
                assert_start_blocked(ctl);case['preserved_material']=preservation()
                assert ctl.current()==candidate
                # Sequences can change independently of transactional DDL; record
                # both explicitly and never infer equality from return status.
                case['before_restore']=before_restore;case['post_failure']=helper.capture(engine)
                try:ctl.rollback(str(saved),recover_only=True)
                except RuntimeError:pass
                else:raise AssertionError('Mismatching failed database was finalized')
                assert_start_blocked(ctl)
                case['mismatch_recovery_rejected']=True
            elif scenario=='interrupted_after_commit':
                child=subprocess.Popen([python,__file__,'--worker-after-commit',str(saved)],env=SAFE_ENV,start_new_session=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                stdout,stderr=child.communicate(timeout=180)
                assert child.returncode==-signal.SIGKILL, stderr.decode(errors='replace')[-1000:]
                case['controller_process_sigkill_after_commit']=True
                assert_start_blocked(ctl);assert helper.capture(engine)==before and sequences()==before_seq
                case['preserved_material']=preservation();recover(saved,before,before_seq)
                case['verification_only_recovery_after_real_committed_restore']=True
            elif scenario=='schema_interruption':
                # Hold a real table lock so inspection remains in the exact
                # confined service while its parent controller is killed.
                with engine.connect() as lock:
                    transaction=lock.begin();lock.execute(sa.text('LOCK TABLE users IN ACCESS EXCLUSIVE MODE'))
                    child=subprocess.Popen([python,__file__,'--worker',str(saved)],env=SAFE_ENV,start_new_session=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                    end=time.monotonic()+10
                    while time.monotonic()<end:
                        if (CONFIG/'schema-operation.env').exists() and command(['systemctl','show','credx-uat2-migrate.service','--property=ActiveState','--value']).stdout.strip() in {b'activating',b'active'}:break
                        time.sleep(.05)
                    else:child.kill();raise RuntimeError('Schema operation not observed')
                    os.killpg(child.pid,signal.SIGKILL);child.communicate(timeout=10);transaction.rollback()
                wait_inactive('credx-uat2-migrate.service')
                assert ctl.pending().exists();assert_start_blocked(ctl)
                try:ctl.rollback(str(saved),recover_only=True)
                except RuntimeError:pass
                else:raise AssertionError('Unrestored database finalized')
                assert not (CONFIG/'schema-operation.env').exists();case['interrupted_environment_cleaned_by_failed_verified_recovery']=True
            else:
                original_configure=ctl.configure_units;original_replace=ctl.os.replace;original_readiness=ctl.readiness
                unit=previous/'deploy/uat2/native/systemd/credx-uat2-worker.service';unit_original=unit.read_text()
                def configure(release):
                    original_configure(release)
                    if scenario=='configure_failure':raise RuntimeError('synthetic after real unit configuration')
                def replace(src,dst):
                    if scenario=='promotion_failure' and Path(dst)==ROOT/'current':raise OSError('synthetic rename failure')
                    return original_replace(src,dst)
                def app_statuses():
                    return [int(command(['/usr/bin/curl','--silent','--show-error','--max-time','1','--output','/dev/null','--write-out','%{http_code}',f'http://127.0.0.1:{port}/']).stdout) for port in (8002,3002)]
                def readiness():
                    if scenario=='readiness_failure':
                        return observe_readiness_failure(original_readiness,app_statuses,case)
                    return original_readiness()
                if scenario=='partial_start_failure':write(unit,re.sub(r'^ExecStartPre=.*$', 'ExecStartPre=/bin/false',unit_original,flags=re.M),0o644)
                if scenario=='readiness_failure':write(FIXTURE/'readiness-fail','synthetic',0o644)
                try:
                    with patch.object(ctl,'configure_units',side_effect=configure),patch.object(ctl.os,'replace',side_effect=replace),patch.object(ctl,'readiness',side_effect=readiness):ctl.rollback(str(saved))
                except ObservedReadinessFailure:
                    assert scenario=='readiness_failure' and case.get('controller_readiness_failure_observed') is True
                except (RuntimeError,OSError) as exc:
                    if scenario=='readiness_failure':raise AssertionError('Unrelated setup/controller error cannot satisfy readiness failure') from exc
                else:raise AssertionError('Finalization failure not reached')
                assert_start_blocked(ctl);assert helper.capture(engine)==before
                write(unit,unit_original,0o644);(FIXTURE/'readiness-fail').unlink(missing_ok=True)
                recover(saved,before,before_seq)  # Must succeed with unchanged runtime or case fails.
                if scenario=='readiness_failure':
                    case['cleared_http_statuses']=app_statuses()
                    assert case['cleared_http_statuses']==[200,200]
                case['verified_recovery_after_finalization_failure']=True
            case['status']='passed'
        except BaseException as exc:
            case['status']='failed';case['failure_type']=type(exc).__name__;case['failure']=str(exc)[-1500:]
        finally:
            try:capture_results(case)
            except Exception as exc:case['capture_failure']=type(exc).__name__
            state_json(OUT/'cases.json',cases)
            print('CASE_END '+scenario+' '+case['status']+' '+case.get('failure_type',''),flush=True)
    # Exercise real schema-operation response validation after actual confined
    # unit execution, with controlled file corruption only at the result boundary.
    variants=['valid','source','request','action','owner','mode','material_digest'] if group=='provenance' else []
    for variant in variants:
        case={'name':'provenance_'+variant,'status':'running'};cases.append(case)
        print('CASE_START '+case['name'],flush=True)
        try:
            saved,_,_=prepare(case['name']);ctl.systemctl('stop',ctl.APPS)
            real_systemctl=ctl.systemctl
            def mutate(action,names):
                real_systemctl(action,names)
                if action=='start' and names==['migrate']:
                    operation=dict(line.split('=',1) for line in (CONFIG/'schema-operation.env').read_text().splitlines())
                    assert stat.S_IMODE((CONFIG/'schema-operation.env').stat().st_mode)==0o600 and (CONFIG/'schema-operation.env').stat().st_uid==0
                    request=operation['CREDX_UAT2_SCHEMA_REQUEST'];path=DATA/'artifacts/native-schema'/(request+'-result.json');value=json.loads(path.read_text())
                    assert path.stat().st_uid==pwd.getpwnam('credx-uat2-app').pw_uid and stat.S_IMODE(path.stat().st_mode)==0o600
                    assert (value['request'],value['source'],value['action'])==(request,CANDIDATE,operation['CREDX_UAT2_SCHEMA_ACTION'])
                    if variant in {'source','request','action'}:value[variant]='mismatch';path.write_text(json.dumps(value))
                    elif variant=='owner':os.chown(path,0,0)
                    elif variant=='mode':path.chmod(0o644)
                    elif variant=='material_digest':
                        material=DATA/'artifacts/native-schema'/(value['material']['request']+'-material.json');material.write_text('tampered synthetic material')
            try:
                with patch.object(ctl,'systemctl',side_effect=mutate):ctl.schema_operation(candidate,'preserve' if variant in {'valid','material_digest'} else 'inspect')
            except RuntimeError:
                if variant=='valid':raise
            else:
                if variant!='valid':raise AssertionError('Mismatched result accepted')
            assert not (CONFIG/'schema-operation.env').exists();case['status']='passed'
        except BaseException as exc:case.update(status='failed',failure_type=type(exc).__name__,failure=str(exc)[-1500:])
        state_json(OUT/'cases.json',cases)
        print('CASE_END '+case['name']+' '+case['status']+' '+case.get('failure_type',''),flush=True)
    ctl.systemctl('stop',ctl.APPS)
    ctl.schema_operation(candidate,'inspect')  # leave the exact candidate helper unit installed for confinement audit
    properties=command(['systemctl','show','credx-uat2-migrate.service','--property=User,Group,NoNewPrivileges,ProtectSystem,ProtectHome,PrivateTmp,RestrictAddressFamilies,IPAddressDeny,IPAddressAllow,MemoryMax,TasksMax,CapabilityBoundingSet,ReadWritePaths']).stdout.decode()
    write(OUT/'confined-unit-properties.txt',properties)
    assert 'User=credx-uat2-app' in properties and 'NoNewPrivileges=yes' in properties and 'ProtectSystem=strict' in properties
    journal=command(['journalctl','--namespace=credx-uat2','-u','credx-uat2-migrate.service','--no-pager'],check=False).stdout.decode()
    write(OUT/'migration-journal.log',journal)
    assert 'UAT2 process network confinement verified' in journal
    assert 'CapabilityBoundingSet=\n' in properties
    assert (Path('/etc/systemd/system')/'credx-uat2-migrate.service').read_text()==(candidate/'deploy/uat2/native/systemd/credx-uat2-migrate.service').read_text().replace('/opt/credx-uat2/current',str(candidate))
    receipt={'group':group,'verification_commit':git('rev-parse','HEAD').decode().strip(),'runtime_source':CANDIDATE,'baseline_source':BASE,'baseline_revision':'durable_analysis_001','candidate_revision':'ai_limits_001','postgres_version':command(['/usr/lib/postgresql/16/bin/pg_restore','--version']).stdout.decode().strip(),'cases':cases,'passed':sum(c['status']=='passed' for c in cases),'failed':sum(c['status']!='passed' for c in cases),'skipped':0,'actual_controller_and_helper':True,'actual_confined_migration_service':True,'actual_credx_application_services':False,'fixture_unit_replacements':['backend','frontend','worker','proxy','certs','redis'],'live_data_credentials_or_hosts':False}
    state_json(OUT/'receipt.json',receipt)
    if receipt['failed']:raise RuntimeError('CI controller integration failures: '+str([c['name'] for c in cases if c['status']!='passed']))


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--python');parser.add_argument('--worker');parser.add_argument('--worker-after-commit');parser.add_argument('--group',choices=['core','interruptions','finalization','provenance'],default='core');args=parser.parse_args()
    guard()
    if args.worker or args.worker_after_commit:child_rollback(args.worker or args.worker_after_commit,bool(args.worker_after_commit));return
    install_fixture(args.python)
    # Re-exec with private dedicated dependencies, not runner user site packages.
    env={**SAFE_ENV,'PYTHONPATH':str(FIXTURE/'venv/lib/python3.12/site-packages')}
    os.execve(str(FIXTURE/'venv/bin/python'),[str(FIXTURE/'venv/bin/python'),str(Path(__file__).resolve()),'--run-suite',args.group],env)


if __name__=='__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--run-suite':
        guard();run_suite(str(FIXTURE/'venv/bin/python'),sys.argv[2])
    else:main()
