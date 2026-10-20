"""Stage04 full-history upgrade/downgrade/re-upgrade in a disposable Docker DB."""
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime
from uuid import uuid4

import sqlalchemy as sa
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

URL='postgresql+psycopg2://stage04:stage04@postgres:5432/credx_stage04_test'
assert Path('/.dockerenv').is_file(), 'Alembic must run inside the backend Docker container'
assert os.environ.get('CREDX_STAGE04_DATABASE_ACK')=='disposable-docker-only'
assert os.environ.get('CREDX_STAGE04_DATABASE_URL')==URL and os.environ.get('DATABASE_URL')==URL
assert not Path('.env').exists() and not Path('backend/.env').exists()
from verify_api_attempt_migration import baseline_snapshot
engine=sa.create_engine(URL)
assert not sa.inspect(engine).get_table_names(), 'Disposable database must be initially empty; never reset existing data'
backend=Path(__file__).resolve().parents[1]
def migrate(direction,target):
    subprocess.run([sys.executable,'-m','alembic',direction,target],cwd=backend,check=True,timeout=180)
subprocess.run([sys.executable,'-m','alembic','upgrade','recommendation_audit_001'],cwd=backend,check=True,timeout=180)
import app.models
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.shared.types import JobStatus
with Session(engine) as s:
    s.add(User(id=900001,email='migration-fixture@invalid.test',username='stage04-migration',password_hash='unusable',is_active=True));s.flush()
    s.add(Job(id=900001,user_id=900001,prompt='pre04 synthetic record preserved',provider='fake',model='offline',status=JobStatus.COMPLETED));s.commit()
with engine.begin() as connection:
    legacy=sa.Table('outbox',sa.MetaData(),autoload_with=connection)
    connection.execute(legacy.insert().values(id=uuid4(),topic='job.created',payload={'job_id':900001},created_at=datetime.utcnow(),attempts=0))
def preserved():
    snapshot=baseline_snapshot(engine,exclude_tables=frozenset({'idempotency_operations'}))
    added={'available_at','execution_attempts'}
    snapshot['outbox']['columns']=[column for column in snapshot['outbox']['columns'] if column[0] not in added]
    snapshot['outbox']['rows']=[json.dumps({k:v for k,v in json.loads(row).items() if k not in added},sort_keys=True) for row in snapshot['outbox']['rows']]
    return snapshot
before=preserved()
migrate('upgrade','head')
assert preserved()==before
from app.infrastructure.messaging.operation_models import IdempotencyOperation
from app.infrastructure.database.outbox.models import OutboxMessage
with Session(engine) as session:
    legacy=session.scalar(sa.select(OutboxMessage))
    assert legacy.execution_attempts==0 and legacy.available_at is None and legacy.topic=='job.created'
with Session(engine) as s:
    s.add(IdempotencyOperation(user_id=900001,operation='jobs.create',key_digest='a'*64,request_digest='b'*64,job_id=900001));s.commit()
    s.add(IdempotencyOperation(user_id=900001,operation='jobs.create',key_digest='a'*64,request_digest='c'*64,job_id=900001))
    try:s.commit();raise AssertionError('Scoped uniqueness not enforced')
    except IntegrityError:s.rollback()
migrate('downgrade','recommendation_audit_001')
assert not sa.inspect(engine).has_table('idempotency_operations')
assert preserved()==before
migrate('upgrade','head')
assert sa.inspect(engine).has_table('idempotency_operations')
assert preserved()==before
print('Stage04 migration upgrade/downgrade/re-upgrade PASS; existing schemas/data preserved; scoped uniqueness verified')
