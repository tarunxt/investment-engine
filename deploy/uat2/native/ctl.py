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
    run(['systemctl','is-active','systemd-timesyncd.service'],capture=True)
    deadline = time.monotonic()+60
    while time.monotonic()<deadline:
        if run(['timedatectl','show','--property=NTPSynchronized','--value'],capture=True)=='yes':
            run(['timedatectl','timesync-status','--no-pager'],capture=True)
            return
        time.sleep(2)
    raise RuntimeError('Time synchronization not established in bounded initialization interval')


def backup():
    directory = DATA/'backups'; directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    path = directory/('uat2-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.dump')
    with path.open('wb') as output:
        result = subprocess.run(['runuser','-u','credx-uat2-db','--','/usr/lib/postgresql/16/bin/pg_dump',
                                 '-h','/run/credx-uat2-postgres','-p','5542','-d','credx_uat2','-Fc'],
                                stdout=output,stderr=subprocess.PIPE,timeout=60)
    if result.returncode or path.stat().st_size<5:
        raise RuntimeError('UAT2 backup failed; application state not promoted')
    path.chmod(0o600)
    old = current().name if (ROOT/'current').exists() else None
    path.with_suffix('.json').write_text(json.dumps({'source_commit':old,'sha256':digest(path)})+'\n')
    path.with_suffix('.json').chmod(0o600)
    return path


def configure_units(release):
    for unit in (release/'deploy/uat2/native/systemd').glob('credx-uat2-*.service'):
        destination=Path('/etc/systemd/system')/unit.name
        destination.write_text(unit.read_text().replace('/opt/credx-uat2/current',str(release)))
    shutil.copyfile(release/'deploy/uat2/native/journald.conf','/etc/systemd/journald@credx-uat2.conf')
    run(['systemd-analyze','verify',*[Path('/etc/systemd/system')/f'credx-uat2-{name}.service' for name in SERVICES+['migrate']]])
    run(['systemctl','daemon-reload'])


def promote(release):
    pointer = ROOT/'current.new'
    pointer.symlink_to(release,target_is_directory=True)
    os.replace(pointer,ROOT/'current')
    write_release_environment(release)


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
    parser.add_argument('action',choices=['validate','inspect-bundle','deploy','start','stop','status','backup','rollback','reset','initialize'])
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
    if args.action=='backup': print(backup()); return
    if args.action=='deploy':
        time_check()
        if shutil.disk_usage(ROOT).free<2*1024**3: raise RuntimeError('At least2GiB free required')
        release=install_release(Path(args.argument).resolve())
        (ROOT/'pending-deployment.json').write_text(json.dumps({'candidate':release.name})+'\n')
        configure_units(release)
        systemctl('start',['network','postgres','redis','certs'])
        systemctl('stop',APPS)
        saved=backup()
        # Native migration uses the same network confinement and private runtime env as the app.
        write_release_environment(release)
        systemctl('start',['migrate'])
        promote(release)
        systemctl('restart',['backend','worker','frontend','proxy'])
        readiness(); (ROOT/'pending-deployment.json').unlink(missing_ok=True); print(f'UAT2 source {release.name} ready; pre-migration backup {saved.name}'); return
    if args.action=='initialize':
        release=install_release(Path(args.argument).resolve())
        configure_units(release)
        systemctl('start',['network','postgres','redis','certs'])
        run(['runuser','-u','credx-uat2-db','--',release/'.venv/bin/python',release/'deploy/uat2/native/initialize_database.py'],env=env_for(release))
        print('UAT2 database initialized; run deploy after reviewing config'); return
    if args.action=='start':
        current()
        if (ROOT/'pending-deployment.json').exists(): raise RuntimeError('Unfinished deployment: complete deploy or rollback before start')
        time_check(); systemctl('start',SERVICES); readiness(); print('UAT2 source '+current().name+' started'); return
    if args.action=='reset':
        if args.argument not in {'empty','populated'}: raise RuntimeError('reset requires empty or populated')
        release=current()
        run(['runuser','-u','credx-uat2-app','--',release/'.venv/bin/python','-m','app.uat2.reset',args.argument],env={**env_for(release),'PYTHONPATH':str(release/'backend')})
        print('US synthetic fixture reset. Match UAT2_FIXTURE_STATE and restart backend for India/dashboard.'); return
    if args.action=='rollback':
        path=Path(args.argument).resolve()
        if path.parent != DATA/'backups' or path.is_symlink() or not re.fullmatch(r'uat2-[0-9TZ]+\.dump',path.name): raise RuntimeError('Use UAT2 backup only')
        receipt=json.loads(path.with_suffix('.json').read_text())
        if digest(path)!=receipt['sha256'] or not re.fullmatch(r'[0-9a-f]{40}',receipt.get('source_commit') or ''): raise RuntimeError('Verified prior-source backup required')
        release=ROOT/'releases'/receipt['source_commit']
        if not (release/'native-manifest.json').is_file(): raise RuntimeError('Prior release missing')
        systemctl('stop',APPS)
        with path.open('rb') as stream:
            result=subprocess.run(['runuser','-u','credx-uat2-db','--','/usr/lib/postgresql/16/bin/pg_restore','-h','/run/credx-uat2-postgres','-p','5542','-d','credx_uat2','--clean','--if-exists','--exit-on-error'],stdin=stream,stderr=subprocess.PIPE,timeout=120)
        if result.returncode: raise RuntimeError('Restore failed; app remains stopped')
        configure_units(release); promote(release)
        systemctl('start',['backend','worker','frontend','proxy']); readiness()
        (ROOT/'pending-deployment.json').unlink(missing_ok=True)
        print('Schema/data and application restored to '+release.name)


if __name__=='__main__':
    try: main()
    except Exception as exc:
        # Do not include underlying connection exceptions or resolved env values.
        if isinstance(exc,(ValueError,RuntimeError)): print(str(exc),file=sys.stderr)
        else: print('Native UAT2 operation failed; inspect private local logs',file=sys.stderr)
        sys.exit(1)
