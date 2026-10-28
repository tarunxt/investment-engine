#!/usr/bin/env python3
"""Disposable local Docker test. No AWS, host ports, real identities or credentials.

Test-only known signing/password strings below are not deployment material.
Only uniquely named test containers/networks are removed by cleanup.
"""
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

revision = sys.argv[1]
backend = 'credx-uat2-backend:' + revision
frontend = 'credx-uat2-frontend:' + revision
prefix = 'credx-uat2-test-' + uuid.uuid4().hex[:10]
private = prefix + '-private'
edge = prefix + '-edge'
containers = []
networks = []


def docker(*args, timeout=120):
    result = subprocess.run(['docker', *args], text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        # These containers use only public config and explicit test-only values.
        raise RuntimeError('Docker test failed: ' + ' '.join(args[:3]) + '\n' + result.stderr[-3000:])
    return result.stdout.strip()


def start(name, image, *args):
    containers.append(name)
    return docker('run', '-d', '--name', name, *args, image)


def wait_db():
    for _ in range(45):
        result = subprocess.run(['docker', 'exec', prefix+'-postgres', 'pg_isready', '-U', 'credx_uat2', '-d', 'credx_uat2'], capture_output=True)
        if result.returncode == 0:
            return
        time.sleep(2)
    raise RuntimeError('Disposable PostgreSQL did not initialize')


config = {
    'DATABASE_URL': 'postgresql+psycopg2://credx_uat2:synthetic-test-only@postgres:5432/credx_uat2',
    'REDIS_URL': 'redis://redis:6379/0', 'CREDX_UAT2': '1', 'ENVIRONMENT': 'uat2',
    'AUTH_DISABLED': 'false', 'UAT2_ADAPTERS': 'simulation',
    'UAT2_JWT_SIGNING_KEY': 'unit-test-only-jwt-material-never-deployed',
    'GOOGLE_SIGNIN_CLIENT_ID': 'independent-synthetic-test-client',
    'UAT2_SOURCE_COMMIT': revision, 'FRONTEND_URL':'https://uat2.example.invalid',
    'DEBUG':'false', 'UAT2_SIMULATION_SCENARIO':'after_acceptance',
    'CREDX_UAT2_SMOKE_CONTAINER':prefix+'-backend',
}
env_args = [arg for key,value in config.items() for arg in ('-e', f'{key}={value}')]
try:
    docker('network', 'create', '--internal', private); networks.append(private)
    docker('network', 'create', edge); networks.append(edge)
    start(prefix+'-postgres', 'postgres:16-bookworm', '--network', private, '--network-alias', 'postgres',
          '-e', 'POSTGRES_USER=credx_uat2', '-e', 'POSTGRES_DB=credx_uat2', '-e', 'POSTGRES_PASSWORD=synthetic-test-only')
    start(prefix+'-redis', 'redis:7-alpine', '--network', private, '--network-alias', 'redis')
    cert_config = str(Path(__file__).with_name('google-certs.conf').resolve())
    # Copy only this public test configuration; avoid slow Desktop host-directory sharing.
    containers.append(prefix+'-certs')
    docker('create', '--name', prefix+'-certs', '--network', private,
           '--network-alias', 'google-certs', 'nginx:stable-alpine')
    docker('cp', cert_config, prefix+'-certs:/etc/nginx/conf.d/default.conf')
    docker('start', prefix+'-certs')
    docker('network', 'connect', edge, prefix+'-certs')
    wait_db()
    docker('run', '--rm', '--network', private, *env_args, backend, 'alembic', 'upgrade', 'head', timeout=180)
    print('PASS migrations in disposable UAT2 backend container', flush=True)
    start(prefix+'-backend', backend, '--hostname',prefix+'-backend','--network', private, '--network-alias', 'backend', '--memory', '1g', *env_args)
    worker_name = prefix+'-worker'
    containers.append(worker_name)
    docker('run', '-d', '--name', worker_name, '--network', private, '--memory', '512m',
           *env_args, backend, 'python', '-m', 'app.uat2.runtime')
    check = '''import json, urllib.request, urllib.error, time
for _ in range(30):
 try:
  result=json.load(urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=2)); assert result['simulation']; break
 except (OSError,AssertionError): time.sleep(2)
else: raise AssertionError('Backend readiness timeout')
for path in ['/zerodha/portfolio','/uat2/export','/uat2/status']:
 try: urllib.request.urlopen('http://127.0.0.1:8000'+path,timeout=3); raise AssertionError('Anonymous API access')
 except urllib.error.HTTPError as e: assert e.code==401
try: urllib.request.urlopen('https://example.com',timeout=3); raise AssertionError('Unexpected application egress')
except (urllib.error.URLError,TimeoutError): pass
certs=json.load(urllib.request.urlopen('http://google-certs:8080/certs',timeout=8)); assert certs
try: urllib.request.urlopen('http://google-certs:8080/arbitrary',timeout=3); raise AssertionError('Generic proxy allowed')
except urllib.error.HTTPError as e: assert e.code==403
print('PASS backend readiness, API auth, no direct egress, bounded certificate-only proxy')
'''
    print(docker('exec', prefix+'-backend', 'python', '-c', check, timeout=90), flush=True)
    print(docker('exec', prefix+'-backend', 'python', '-c',
                 "from app.uat2.worker import celery; r=celery.control.inspect(timeout=5).registered(); names={name for tasks in (r or {}).values() for name in tasks}; assert {'uat2.analysis.stage.v1','uat2.analysis.job.v1','uat2.orders.dispatch.v1','uat2.orders.reconcile.v1'} <= names; print('PASS dedicated simulation task registration; no job or approval created')", timeout=45), flush=True)
    # Exercise existing auth/portfolio DB models without manufacturing a live login.
    fixture_check = '''import asyncio
from sqlalchemy import select
from app.domains.auth.models import User, UserProfile, UserRole
from app.domains.jobs.models import Job
from app.domains.prompts.models import Prompt
from app.infrastructure.database.session import AsyncSessionLocal
from app.uat2.fixtures import seed_portfolio
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.domains.indmoney_us.service import IndMoneyUsPortfolioService
from app.domains.indmoney_us.schemas import IndMoneyUsPortfolioSnapshotDetailResponse
async def run():
 async with AsyncSessionLocal() as db:
  user=User(email='synthetic-fixture@example.test',username='synthetic-fixture',password_hash='not-a-login-hash',role=UserRole.USER,is_active=False,is_verified=False,profile=UserProfile())
  db.add(user); await db.flush()
  await seed_portfolio(db,user.id); await db.commit()
  snapshot=(await db.execute(select(IndMoneyUsPortfolioSnapshot).where(IndMoneyUsPortfolioSnapshot.user_id==user.id))).scalar_one()
  detail=IndMoneyUsPortfolioSnapshotDetailResponse(**IndMoneyUsPortfolioService().serialize_detail(snapshot))
  assert detail.holdings_count==2
  await seed_portfolio(db,user.id,reset=True,state='empty'); await db.commit()
  assert (await db.execute(select(IndMoneyUsPortfolioSnapshot).where(IndMoneyUsPortfolioSnapshot.user_id==user.id))).scalar_one_or_none() is None
asyncio.run(run())
print('PASS synthetic SQLAlchemy fixture populated/empty reset and real response schema')
'''
    print(docker('exec', prefix+'-backend', 'python', '-c', fixture_check), flush=True)
    workflow_probe=Path(__file__).with_name('workflow_probe.py').read_text()
    print(docker('exec',prefix+'-backend','python','-c',workflow_probe,'start',timeout=300),flush=True)
    # Quiesce both consumer and embedded Beat, then verify uncertainty survived.
    # Otherwise Beat could reconcile before restart and produce a false claim.
    docker('stop',worker_name)
    print(docker('exec',prefix+'-backend','python','-c',workflow_probe,'before-restart',timeout=30),flush=True)
    docker('start',worker_name)
    # The same PostgreSQL/Redis volumes and immutable venue receipts survive.
    print(docker('exec',prefix+'-backend','python','-c',workflow_probe,'recover',timeout=360),flush=True)
    if '--backend-only' not in sys.argv:
        start(prefix+'-frontend', frontend, '--network', private, '-e', 'CREDX_UAT2=1',
              '-e', 'NEXTAUTH_URL=https://uat2.cred-x.in', '-e', 'BACKEND_API_URL=http://backend:8000',
              '-e', 'NEXTAUTH_SECRET=unit-test-only-authjs-material-never-deployed',
              '-e', 'NEXT_PUBLIC_DISABLE_AUTH=false')
        frontend_check = '''(async()=>{for(let n=0;n<30;n++){try{const r=await fetch('http://127.0.0.1:3000/login',{signal:AbortSignal.timeout(2000)});if(r.ok){const text=await r.text();if(!text.includes('Google'))throw Error('Actual login missing');console.log('PASS actual frontend login runtime');return;}}catch{}await new Promise(r=>setTimeout(r,2000));}process.exit(1);})()'''
        print(docker('exec', prefix+'-frontend', 'node', '-e', frontend_check, timeout=90), flush=True)
    backup = subprocess.run(['docker', 'exec', prefix+'-postgres', 'pg_dump', '-U', 'credx_uat2', '-d', 'credx_uat2', '-Fc'], capture_output=True, timeout=60)
    assert backup.returncode == 0 and backup.stdout.startswith(b'PGDMP')
    restored = subprocess.run(['docker','exec','-i',prefix+'-postgres','pg_restore','-U','credx_uat2','-d','credx_uat2','--clean','--if-exists','--exit-on-error'], input=backup.stdout, capture_output=True, timeout=60)
    assert restored.returncode == 0, restored.stderr[-2000:]
    print('PASS UAT2-only backup and schema/data restore', flush=True)
finally:
    for name in reversed(containers):
        subprocess.run(['docker','rm','-f','-v',name], capture_output=True, timeout=30)
    for name in reversed(networks):
        subprocess.run(['docker','network','rm',name], capture_output=True, timeout=30)
