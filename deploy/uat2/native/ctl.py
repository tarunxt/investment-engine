#!/usr/bin/env python3
"""Dedicated native UAT2 lifecycle. No provisioning or production commands.

Mutating commands require root on the separately approved EC2 host, a matching
IMDSv2 identity and a root-owned UAT2 marker. Validation/package tests run locally.
"""
import argparse
import fcntl
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.request
from uuid import uuid4

from package import verify, extract, digest
from validate import validate

ROOT = Path('/opt/credx-uat2')
CONFIG = Path('/etc/credx-uat2')
DATA = Path('/var/lib/credx-uat2')
SERVICES = ['network','postgres','redis','certs','backend','worker','frontend','proxy']
APPS = ['proxy','frontend','worker','backend']
EXCLUDED = {'i-0b8ad0aebce8510cb','i-0dea5617814f8b351','i-0cb5d69e6b140b2da'}


def acquire_lock():
    lock = open('/run/credx-uat2-control.lock','a')
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise RuntimeError('Another native UAT2 lifecycle operation is in progress') from None
    return lock


def run(args, *, env=None, capture=False, timeout=120, cwd=None):
    result = subprocess.run([str(item) for item in args], env=env, check=False,
                            stdout=subprocess.PIPE if capture else None, cwd=cwd,
                            stderr=subprocess.PIPE, text=True, timeout=timeout)
    if result.returncode:
        # Child stderr can contain resolved URLs. Never include it in errors.
        raise RuntimeError(f'UAT2 command failed: {Path(str(args[0])).name} (exit {result.returncode}); inspect private UAT2 logs')
    return result.stdout.strip() if capture else None


def systemctl(action, names):
    run(['systemctl',action,*[f'credx-uat2-{name}.service' for name in names]])


def host_guard():
    if os.geteuid() != 0 or platform.system() != 'Linux':
        raise RuntimeError('Run only as root on the approved dedicated Linux UAT2 host')
    marker = CONFIG/'identity.json'
    info = marker.stat()
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode)&0o077 or marker.is_symlink():
        raise RuntimeError('Root-owned mode0600 identity marker required')
    expected = json.loads(marker.read_text())
    request = urllib.request.Request('http://169.254.169.254/latest/api/token',
                                    method='PUT', headers={'X-aws-ec2-metadata-token-ttl-seconds':'60'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    token = opener.open(request, timeout=3).read().decode()
    request = urllib.request.Request('http://169.254.169.254/latest/dynamic/instance-identity/document',
                                    headers={'X-aws-ec2-metadata-token':token})
    actual = json.load(opener.open(request, timeout=3))
    validate_identity(expected,actual)
    if Path('/etc/investor').exists() or Path('/srv/investor').exists():
        raise RuntimeError('Refusing production co-location')


def validate_identity(expected, actual):
    if expected.get('purpose') != 'credx-uat2' or expected.get('account') != '457945009677' or expected.get('region') != 'ap-south-1':
        raise RuntimeError('Invalid dedicated UAT2 identity marker')
    if actual.get('accountId') != expected['account'] or actual.get('region') != expected['region'] or actual.get('instanceId') != expected.get('instance_id') or actual.get('instanceId') in EXCLUDED:
        raise RuntimeError('Instance/account mismatch or excluded existing resource')


def env_for(release):
    backend, _, _ = validate(CONFIG)
    env = {'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1', **backend,
           'UAT2_SOURCE_COMMIT':json.loads((release/'native-manifest.json').read_text())['source_commit']}
    return env


def current():
    value = (ROOT/'current').resolve(strict=True)
    if value.parent != ROOT/'releases' or not re.fullmatch(r'[0-9a-f]{40}',value.name):
        raise RuntimeError('Invalid native UAT2 release pointer')
    return value


def install_release(bundle):
    manifest = verify(bundle)
    if sys.version_info[:2] != (3,12) or platform.machine() != 'x86_64':
        raise RuntimeError('Native bundle requires Linux x86_64 and Python3.12')
    if run(['/usr/bin/node','--version'],capture=True).split('.')[0] != 'v22':
        raise RuntimeError('Native frontend requires Node22')
    target = ROOT/'releases'/manifest['source_commit']
    target.mkdir(parents=True,exist_ok=True)
    receipt = target/'native-manifest.json'
    if receipt.exists() and json.loads(receipt.read_text()) != manifest:
        raise RuntimeError('Existing release has different manifest; refusing overwrite')
    extract(bundle/'application.tar.gz',target)
    web = target/'frontend-runtime'; web.mkdir(exist_ok=True)
    extract(bundle/'frontend.tar.gz',web)
    front = json.loads((web/'deployment-manifest.json').read_text())
    public = front.get('public_environment',{})
    if front.get('build_sha') != manifest['source_commit'] or front.get('platform') != 'linux' or front.get('arch') != 'x64' or public.get('NEXT_PUBLIC_FRONTEND_URL') != 'https://uat2.cred-x.in':
        raise RuntimeError('Frontend artifact platform/source/origin mismatch')
    run(['/usr/bin/node',target/'deploy/uat2/native/verify-frontend.mjs',web,manifest['source_commit']])
    run(['/usr/bin/python3','-m','venv',target/'.venv'])
    run([target/'.venv/bin/pip','install','--no-index','--find-links',bundle/'wheels','-r',target/'backend/requirements.txt'],timeout=300)
    receipt.write_text(json.dumps(manifest,indent=2)+'\n')
    cache = web/'.next/cache'
    if not cache.exists() and not cache.is_symlink():
        cache.symlink_to('/var/cache/credx-uat2-next',target_is_directory=True)
    return target


def time_check():
    deadline = time.monotonic()+60
    while time.monotonic()<deadline:
        active = lambda unit: subprocess.run(
            ['systemctl','is-active','--quiet',unit], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=10).returncode == 0
        if active('chrony.service'):
            tracking = run(['chronyc','tracking'],capture=True)
            sources = run(['chronyc','sources','-n'],capture=True)
            normal = re.search(r'^Leap status\s*:\s*Normal\s*$',tracking,re.M)
            stratum = re.search(r'^Stratum\s*:\s*([1-9][0-9]*)\s*$',tracking,re.M)
            selected = re.search(r'^\^\*\s+\S+',sources,re.M)
            if normal and stratum and selected:
                return
        elif active('systemd-timesyncd.service'):
            if run(['timedatectl','show','--property=NTPSynchronized','--value'],capture=True)=='yes':
                run(['timedatectl','timesync-status','--no-pager'],capture=True)
                return
        time.sleep(2)
    raise RuntimeError('Time synchronization not established in bounded initialization interval')


BASE_REVISION = 'module_lifecycle_001'
STAGE09_REVISION = 'integration_connections_001'
STAGE10_REVISION = 'connection_attempts_001'
STAGE11_REVISION = 'indmoney_integrity_001'
SCHEMA_ARTIFACTS = DATA/'artifacts/native-schema'


def durable_write(path, payload):
    temporary=path.with_name(path.name+'.'+uuid4().hex+'.tmp')
    descriptor=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(descriptor,'wb') as output:
        output.write(payload);output.flush();os.fsync(output.fileno())
    os.replace(temporary,path)
    sync_directory(path.parent)


def sync_directory(path):
    descriptor=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)


def durable_json(path, value):
    durable_write(path,(json.dumps(value,sort_keys=True)+'\n').encode())


def private_file(path, owner=None):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=(os.geteuid() if owner is None else owner) or stat.S_IMODE(info.st_mode)&0o077:
        raise RuntimeError('Private regular UAT2 recovery file required')
    return path


def private_json(path):return json.loads(private_file(path).read_text())


def release_manifest(release):
    path=release/'native-manifest.json';info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)&0o022:
        raise RuntimeError('Trusted installed release manifest required')
    value=json.loads(path.read_text())
    if value.get('source_commit')!=release.name:raise RuntimeError('Release manifest source mismatch')
    return digest(path)


def require_apps_stopped():
    for name in APPS:
        result=subprocess.run(['systemctl','is-active','--quiet',f'credx-uat2-{name}.service'],
                              stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
        if result.returncode!=3:raise RuntimeError('All UAT2 applications must be verifiably stopped')


def schema_operation(release, action, *, expected=None, fingerprint=None, material=None, target=None):
    # Reuse exactly the existing migration identity/cgroup/network sandbox.
    require_apps_stopped()
    active=subprocess.run(['systemctl','is-active','--quiet','credx-uat2-migrate.service'],
                          stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
    if active.returncode not in {3,4}:raise RuntimeError('Schema operation already active or uncertain')
    release_manifest(release)
    if not (release/'deploy/uat2/native/schema_service.py').is_file():raise RuntimeError('Installed schema recovery helper required')
    request=uuid4().hex
    values={'ACTION':action,'REQUEST':request,'SOURCE':release.name}
    if expected:values['EXPECTED']=expected
    if target:values['TARGET']=target
    if fingerprint:values['FINGERPRINT']=fingerprint
    if material:values.update(MATERIAL_REQUEST=material['request'],MATERIAL_SHA=material['sha256'])
    if action not in {'inspect','preserve','downgrade','verify'}:raise RuntimeError('Unknown schema operation')
    for value in values.values():
        if not re.fullmatch(r'[A-Za-z0-9_]+',value):raise RuntimeError('Invalid schema operation value')
    unit=release/'deploy/uat2/native/systemd/credx-uat2-migrate.service'
    content=unit.read_text()
    if 'native/schema_service.py' not in content:raise RuntimeError('Confined schema unit required')
    destination=Path('/etc/systemd/system/credx-uat2-migrate.service')
    destination.write_text(content.replace('/opt/credx-uat2/current',str(release)))
    run(['systemd-analyze','verify',destination]);run(['systemctl','daemon-reload'])
    operation=CONFIG/'schema-operation.env'
    durable_write(operation,''.join('CREDX_UAT2_SCHEMA_'+k+'='+v+'\n' for k,v in values.items()).encode())
    try:
        systemctl('start',['migrate'])
        path=DATA/'artifacts/native-schema'/(request+'-result.json')
        owner=pwd.getpwnam('credx-uat2-app').pw_uid
        value=json.loads(private_file(path,owner).read_text())
        if (value.get('request'),value.get('source'),value.get('action'))!=(request,release.name,action):raise RuntimeError('Schema response mismatch')
        if material_result:=value.get('material'):
            saved=DATA/'artifacts/native-schema'/(material_result['request']+'-material.json')
            if not re.fullmatch(r'[0-9a-f]{32}',material_result['request']) or digest(private_file(saved,owner))!=material_result['sha256']:
                raise RuntimeError('Material preservation verification failed')
        return value
    finally:
        operation.unlink(missing_ok=True);sync_directory(CONFIG)


def backup(release=None):
    require_apps_stopped();release=release or current()
    before=schema_operation(release,'inspect')['state']
    source=current();manifest_sha=release_manifest(source)
    directory=DATA/'backups';directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    path=directory/('uat2-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.dump')
    descriptor=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(descriptor,'wb') as output:
        result=subprocess.run(['runuser','-u','credx-uat2-db','--','/usr/lib/postgresql/16/bin/pg_dump',
                               '-h','/run/credx-uat2-postgres','-p','5542','-d','credx_uat2','-Fc'],
                              stdout=output,stderr=subprocess.PIPE,timeout=60)
        output.flush();os.fsync(output.fileno())
    if result.returncode or path.stat().st_size<5:raise RuntimeError('UAT2 backup failed; application state not promoted')
    after=schema_operation(release,'inspect')['state']
    if before!=after:raise RuntimeError('Database changed during backup; recovery point not verified')
    durable_json(path.with_suffix('.json'),{'schema_version':2,'source_commit':source.name,'manifest_sha256':manifest_sha,
                 'sha256':digest(path),'schema_revision':before['revision'],'fingerprint':before['fingerprint'],
                 'created_at':datetime.now(timezone.utc).isoformat()})
    return path


def backup_reference(path, receipt):
    return {key:receipt[key] for key in ('sha256','source_commit','schema_revision','fingerprint')}|{'name':path.name}


def checked_backup(argument):
    raw=Path(argument)
    if raw.is_symlink():raise RuntimeError('Symlinked backup refused')
    path=raw.resolve()
    if path.parent!=(DATA/'backups').resolve() or not re.fullmatch(r'uat2-[0-9TZ]+\.dump',path.name):raise RuntimeError('Use UAT2 backup only')
    private_file(path);receipt=private_json(path.with_suffix('.json'))
    if receipt.get('schema_version')!=2 or receipt.get('schema_revision') not in {BASE_REVISION,STAGE09_REVISION,STAGE10_REVISION,STAGE11_REVISION}:
        raise RuntimeError('Fresh supported UAT2 backup with schema provenance required')
    if not re.fullmatch(r'[0-9a-f]{40}',receipt.get('source_commit','')) or not re.fullmatch(r'[0-9a-f]{64}',receipt.get('fingerprint','')):
        raise RuntimeError('Invalid backup provenance')
    timestamp=datetime.fromisoformat(receipt['created_at'])
    if timestamp.tzinfo is None or timestamp.timestamp()>time.time()+60:raise RuntimeError('Invalid backup timestamp')
    if digest(path)!=receipt.get('sha256'):raise RuntimeError('Backup checksum mismatch')
    release=ROOT/'releases'/receipt['source_commit']
    if release_manifest(release)!=receipt.get('manifest_sha256'):raise RuntimeError('Rollback release provenance mismatch')
    return path,receipt,release


def pending():return ROOT/'pending-deployment.json'


def clear_pending():
    pending().unlink();sync_directory(ROOT)


def mark(record, phase, **extra):
    record.update(phase=phase,**extra);durable_json(pending(),record)


def rollback(argument, *, recover_only=False):
    path,receipt,target=checked_backup(argument)
    reference=backup_reference(path,receipt)
    baseline=receipt['schema_revision']
    successor={BASE_REVISION:STAGE09_REVISION,STAGE09_REVISION:STAGE10_REVISION,STAGE10_REVISION:STAGE11_REVISION,STAGE11_REVISION:None}[baseline]
    old=private_json(pending()) if pending().exists() else None
    if recover_only:
        if not old or old.get('operation')!='rollback' or old.get('backup')!=reference:
            raise RuntimeError('Matching interrupted rollback required')
        record=old
    else:
        if old and old.get('operation')=='rollback':raise RuntimeError('Interrupted rollback: use verify-only recover-rollback; no blind retry')
        context=old or private_json(ROOT/'deployment-receipt.json')
        if context.get('schema_version')!=2 or context.get('operation')!='deploy' or not re.fullmatch(r'[0-9a-f]{40}',context.get('candidate','')):
            raise RuntimeError('Verified deployment provenance required')
        if context.get('backup')!=reference or context.get('previous_source')!=target.name:
            raise RuntimeError('Backup is not the recorded pre-deployment recovery point')
        if not old and current().name!=context.get('candidate'):raise RuntimeError('Current source changed')
        record={'schema_version':2,'operation':'rollback','id':uuid4().hex,'candidate':context['candidate'],
                'previous_source':target.name,'backup':reference}
        mark(record,'validated')  # durable BEFORE stop, downgrade, restore or promotion
    if record.get('schema_version')!=2 or not re.fullmatch(r'[0-9a-f]{40}',record.get('candidate','')):
        raise RuntimeError('Invalid recovery marker; review required')
    operator=ROOT/'releases'/record['candidate']
    try:
        systemctl('stop',APPS);require_apps_stopped()
        if recover_only:
            # Never repeat a possibly completed restore after interruption.
            schema_operation(operator,'verify',expected=baseline,fingerprint=receipt['fingerprint'])
        else:
            state=schema_operation(operator,'inspect')['state']
            if state['revision']==successor:
                saved=schema_operation(operator,'preserve',expected=successor)
                mark(record,'material_preserved',material=saved['material'])
                mark(record,'downgrade_started')
                schema_operation(operator,'downgrade',expected=successor,
                                 fingerprint=saved['state']['fingerprint'],material=saved['material'],
                                 **({'target':baseline} if baseline in {STAGE09_REVISION,STAGE10_REVISION} else {}))
            elif (state['revision']!=baseline or (baseline not in {STAGE10_REVISION,STAGE11_REVISION} and state.get('stage10_tables'))
                  or (baseline!=STAGE11_REVISION and state.get('stage11_columns'))
                  or (baseline==BASE_REVISION and state.get('stage09_tables'))):
                raise RuntimeError('Unexpected revision or partial schema; rollback stopped')
            elif baseline in {STAGE09_REVISION,STAGE10_REVISION,STAGE11_REVISION}:
                saved=schema_operation(operator,'preserve',expected=baseline)
                mark(record,'material_preserved',material=saved['material'])
            mark(record,'restore_started')
            with path.open('rb') as stream:
                result=subprocess.run(['runuser','-u','credx-uat2-db','--','/usr/lib/postgresql/16/bin/pg_restore',
                                       '-h','/run/credx-uat2-postgres','-p','5542','-d','credx_uat2',
                                       '--clean','--if-exists','--exit-on-error','--single-transaction'],
                                      stdin=stream,stderr=subprocess.PIPE,timeout=120)
            if result.returncode:raise RuntimeError('Restore failed; apps remain stopped and recovery marker retained')
            schema_operation(operator,'verify',expected=baseline,fingerprint=receipt['fingerprint'])
        mark(record,'database_verified')
        configure_units(target);promote(target)
        mark(record,'finalizing')
        systemctl('start',['backend','worker','frontend','proxy']);readiness()
        clear_pending()
        print('Verified schema/data and application restored to '+target.name)
    except BaseException:
        # A killed controller cannot clean up, but its fsynced marker still blocks
        # every later start. Normal failures also stop any partially started apps.
        try:systemctl('stop',APPS)
        except Exception:pass
        raise


def configure_units(release):
    for unit in (release/'deploy/uat2/native/systemd').glob('credx-uat2-*.service'):
        destination=Path('/etc/systemd/system')/unit.name
        destination.write_text(unit.read_text().replace('/opt/credx-uat2/current',str(release)))
    shutil.copyfile(release/'deploy/uat2/native/journald.conf','/etc/systemd/journald@credx-uat2.conf')
    run(['systemd-analyze','verify',*[Path('/etc/systemd/system')/f'credx-uat2-{name}.service' for name in SERVICES+['migrate']]])
    run(['systemctl','daemon-reload'])


def promote(release):
    # Each attempt owns its temporary pointer; a killed/failed prior attempt
    # cannot collide with a verified recovery attempt.
    pointer = ROOT/('current.'+uuid4().hex+'.new')
    created = False
    try:
        pointer.symlink_to(release,target_is_directory=True)
        created = True
        sync_directory(ROOT)
        os.replace(pointer,ROOT/'current')
        sync_directory(ROOT)
        write_release_environment(release)
    finally:
        if created:
            pointer.unlink(missing_ok=True)
            sync_directory(ROOT)


def write_release_environment(release):
    env = CONFIG/'release.env'
    env.write_text('UAT2_SOURCE_COMMIT='+release.name+'\n')
    env.chmod(0o600)


def readiness():
    for url in ['http://127.0.0.1:8002/health','http://127.0.0.1:3002/login']:
        for attempt in range(30):
            try:
                with urllib.request.urlopen(url,timeout=2) as response:
                    if response.status==200: break
            except OSError: pass
            if attempt==29: raise RuntimeError('Bounded UAT2 readiness failed; inspect private logs')
            time.sleep(2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action',choices=['validate','inspect-bundle','deploy','start','stop','status','backup','rollback','recover-rollback','reset','initialize'])
    parser.add_argument('argument',nargs='?')
    args = parser.parse_args()
    if args.action=='inspect-bundle':
        manifest=verify(Path(args.argument)); print('Verified native bundle source '+manifest['source_commit']); return
    if args.action=='validate':
        validate(Path(args.argument or CONFIG)); print('Native UAT2 config valid; values withheld'); return
    host_guard()
    operation_lock = acquire_lock()  # held until this command returns/exits
    if args.action=='status':
        for name in SERVICES:
            result=subprocess.run(['systemctl','is-active',f'credx-uat2-{name}.service'],capture_output=True,text=True)
            print(f'{name}: {result.stdout.strip()}')
        usage=shutil.disk_usage(DATA); print(f'Disk used {100*(usage.total-usage.free)/usage.total:.0f}%')
        if (ROOT/'pending-deployment.json').exists(): print('Pending deployment: app must remain stopped until deploy/rollback completes')
        print('Source '+current().name); return
    if args.action=='stop':
        systemctl('stop',list(reversed(SERVICES)))
        print('UAT2 services stopped; EC2/storage/IPv4 billing continues'); return
    validate(CONFIG)
    if pending().exists() and args.action in {'deploy','backup','reset','initialize'}:
        raise RuntimeError('Pending operation must be verified/recovered first')
    if args.action=='backup': print(backup()); return
    if args.action=='deploy':
        time_check()
        if shutil.disk_usage(ROOT).free<2*1024**3: raise RuntimeError('At least2GiB free required')
        release=install_release(Path(args.argument).resolve())
        previous=current().name
        record={'schema_version':2,'operation':'deploy','id':uuid4().hex,'candidate':release.name,'previous_source':previous}
        mark(record,'prepared')
        configure_units(release)
        systemctl('start',['network','postgres','redis','certs'])
        systemctl('stop',APPS)
        saved=backup(release)
        saved_receipt=private_json(saved.with_suffix('.json'))
        mark(record,'backup_verified',backup=backup_reference(saved,saved_receipt))
        # Native migration uses the same network confinement and private runtime env as the app.
        write_release_environment(release)
        mark(record,'migration_started')
        systemctl('start',['migrate'])
        promote(release)
        systemctl('restart',['backend','worker','frontend','proxy'])
        readiness();durable_json(ROOT/'deployment-receipt.json',record);clear_pending()
        print(f'UAT2 source {release.name} ready; pre-migration backup {saved.name}');return
    if args.action=='initialize':
        release=install_release(Path(args.argument).resolve())
        configure_units(release)
        systemctl('start',['network','postgres','redis','certs'])
        run(['/usr/sbin/runuser','-u','credx-uat2-db','--',release/'.venv/bin/python',release/'deploy/uat2/native/initialize_database.py'],env=env_for(release))
        print('UAT2 database initialized; run deploy after reviewing config'); return
    if args.action=='start':
        current()
        if (ROOT/'pending-deployment.json').exists(): raise RuntimeError('Unfinished deployment: complete deploy or rollback before start')
        time_check(); systemctl('start',SERVICES); readiness(); print('UAT2 source '+current().name+' started'); return
    if args.action=='reset':
        if args.argument not in {'empty','populated'}: raise RuntimeError('reset requires empty or populated')
        release=current()
        # Load the same model registry as the serving app, and leave the SSH
        # operator's private home before the unprivileged process checks .env.
        bootstrap = "import runpy; import app.uat2.main; runpy.run_module('app.uat2.reset', run_name='__main__')"
        run(['/usr/sbin/runuser','-u','credx-uat2-app','--',release/'.venv/bin/python','-c',bootstrap,args.argument],
            env={**env_for(release),'PYTHONPATH':str(release/'backend')},cwd=release/'backend')
        print('US synthetic fixture reset. Match UAT2_FIXTURE_STATE and restart backend for India/dashboard.'); return
    if args.action in {'rollback','recover-rollback'}:
        rollback(args.argument,recover_only=args.action=='recover-rollback');return


if __name__=='__main__':
    try: main()
    except Exception as exc:
        # Do not include underlying connection exceptions or resolved env values.
        if isinstance(exc,(ValueError,RuntimeError)): print(str(exc),file=sys.stderr)
        else: print('Native UAT2 operation failed; inspect private local logs',file=sys.stderr)
        sys.exit(1)
