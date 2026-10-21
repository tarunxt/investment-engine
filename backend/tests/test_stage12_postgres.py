"""Prepared disposable Docker PostgreSQL gates, never a live/local DB fallback."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
from copy import deepcopy
import os,subprocess,sys
from pathlib import Path
import pytest
from sqlalchemy import select,text,inspect
from sqlalchemy.orm import Session
from app.domains.modules.models import UserModulePreferences,UserModule
from app.domains.modules.policy import ModuleFacts
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow
from app.domains.runs.analysis_workflows.contracts import Runtime,TOPIC
from app.domains.runs.analysis_workflows.runtime import policy
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.analysis_workflows.adapters import DeterministicAnalysis
from app.infrastructure.database.outbox.models import OutboxMessage
from test_stage09_connections_postgres import database
pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',reason='Mandatory disposable backend Docker PostgreSQL only; CI must reject skips')

@pytest.fixture
def workflow_env(database):
    engine,factory,owner,schema,ring=database
    with Session(engine) as db:
        db.add(UserModulePreferences(user_id=owner,version=1))
        db.add(UserModule(user_id=owner,module_id='indmoney_us',enabled=True,version=1,schedules_paused=False,config={'schema_version':1}));db.commit()
    runtime=Runtime(lambda s,o,p,**kw:policy(s,o,p,facts=ModuleFacts(jurisdiction='allowed',plan='allowed',connection='not_required'),**kw),lambda s,o,p,i=None:{'owner_id':o,'snapshot_id':1,'version':1},lambda p:{'version':'fake-1'},DeterministicAnalysis(),lambda p,d,n:{'timezone':'Asia/Kolkata','calendar_version':'synthetic-1','market_open':True,'max_lateness_seconds':60,'missed_policy':'skip'})
    return engine,owner,runtime

@pytest.mark.parametrize('scheduled',[False,True])
def test_parallel_create_and_scheduler_tick_is_single_owned_workflow(workflow_env,scheduled):
    engine,owner,runtime=workflow_env;now=datetime.now(timezone.utc)
    def create():
        with Session(engine,autoflush=False) as db:
            row=Workflows(db,runtime).create(owner,'indmoney_us','same-parallel-key',scheduled_at=now if scheduled else None,schedule_id='fake-calendar' if scheduled else None,now=now);db.commit();return row.id
    with ThreadPoolExecutor(2) as pool:ids=list(pool.map(lambda _:create(),range(2)))
    assert ids[0]==ids[1]
    with Session(engine) as db:
        assert len(db.scalars(select(Workflow).where(Workflow.user_id==owner)).all())==1
        assert len(db.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC)).all())==1


def test_parallel_delivery_commits_one_stage_attempt(workflow_env):
    engine,owner,runtime=workflow_env
    with Session(engine) as db:
        row=Workflows(db,runtime).create(owner,'indmoney_us','parallel-delivery');db.commit();id=row.id
        message=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC)).id
    def consume():
        with Session(engine,autoflush=False) as db:
            result=Workflows(db,runtime).consume(message);db.commit();return result
    with ThreadPoolExecutor(2) as pool:results=list(pool.map(lambda _:consume(),range(2)))
    assert sorted(results)==['completed','duplicate']
    with Session(engine) as db:assert Workflows(db,runtime).detail(owner,id)['stages'][0]['attempts']==1


def test_real_stage12_migration_roundtrip_preserves_stage11_and_legacy_workflow(database):
    engine,_,_,schema,_=database
    assert Path('/.dockerenv').is_file()
    from app.infrastructure.database.base import Base
    Base.metadata.drop_all(engine)
    backend=Path(__file__).resolve().parents[1];env={**os.environ,'PGOPTIONS':f'-csearch_path={schema}'}
    def migrate(direction,target):subprocess.run([sys.executable,'-m','alembic',direction,target],cwd=backend,env=env,check=True,capture_output=True,text=True,timeout=90)
    migrate('upgrade','indmoney_integrity_001')
    with engine.begin() as db:
        db.execute(text("INSERT INTO users (email,username,password_hash,role,is_active,is_verified,created_at,updated_at) VALUES ('migration@stage12.example.invalid','synthetic12','unusable','USER',true,true,now(),now())"))
    def snapshot():
        with engine.connect() as db:return {name:[tuple(row) for row in db.execute(text('SELECT * FROM '+name+' ORDER BY id'))] for name in ['users','indmoney_us_portfolio_snapshots','integration_connections','connection_attempts','auto_rebalance_workflows','auto_rebalance_workflow_stages']}
    before=snapshot()
    for _ in range(2):
        migrate('upgrade','durable_analysis_001')
        assert {'execution_json','control_version','request_key'}<={c['name'] for c in inspect(engine).get_columns('auto_rebalance_workflows')}
        migrate('downgrade','indmoney_integrity_001');assert snapshot()==before
