"""Prepared actual PostgreSQL races; only the existing disposable Docker gate."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path
import os
import subprocess
import sys
import pytest
from sqlalchemy import create_engine, select, inspect
from sqlalchemy.orm import Session
from test_stage09_connections_postgres import database
from test_stage14_postgres import setup, approved, policy, risk
from test_stage15_execution import market
from app.domains.order_intents.service import Orders
from app.domains.order_intents.models import OrderIntent
from app.domains.order_intents.execution import ExecutionWorker, venue_binding
from app.domains.order_intents.execution_fake import VenueBase, ExecutionBrokerFake, MarketDataFake
from app.domains.order_intents.execution_models import ExecutionAttempt, ExecutionRun, ExecutionFence
from app.domains.order_intents.contracts import OrderDenied
from app.domains.modules.models import UserModule, UserModulePreferences

pytestmark = pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK') != 'disposable-docker-only', reason='Disposable Docker PostgreSQL required; future exact CI must reject skips')


def prepared(database, tmp_path, outcomes=()):
    engine, owner = setup(database)
    event = approved(engine, owner)
    venue = create_engine('sqlite:///' + str(tmp_path/'venue.sqlite'))
    VenueBase.metadata.create_all(venue)
    with Session(engine) as db:
        row = db.scalar(select(OrderIntent))
        binding, snapshot, intent = venue_binding(row), market(row, datetime.now(timezone.utc)), row.id
    broker = ExecutionBrokerFake(venue, binding, outcomes)
    return engine, owner, event, intent, broker, MarketDataFake(snapshot)


def worker(db, broker, source):
    return ExecutionWorker(Orders(db, policy=policy, risk=risk), broker, source)


def test_actual_pg_duplicate_delivery_one_effect(database, tmp_path):
    engine, owner, event, intent, broker, source = prepared(database, tmp_path)
    try:
        def call(_):
            with Session(engine) as db:
                try: worker(db,broker,source).dispatch(event);return True
                except OrderDenied:db.rollback();return False
        with ThreadPoolExecutor(2) as pool: assert sum(pool.map(call,range(2)))==1
        assert len(broker.calls)==1
        with Session(engine) as db:assert len(db.scalars(select(ExecutionAttempt)).all())==1
    finally:broker.engine.dispose()


@pytest.mark.parametrize('scope',['platform','owner','connection'])
def test_actual_pg_stop_commit_between_claim_and_effect(database,tmp_path,scope):
    engine,owner,event,intent,broker,source=prepared(database,tmp_path)
    def stop():
        with Session(engine) as db:
            args={} if scope=='platform' else {'owner_id':owner}
            if scope=='connection':args['connection_id']='fake'
            worker(db,broker,source).set_stop(scope,True,**args)
    try:
        with Session(engine) as db:
            with pytest.raises(OrderDenied,match='EMERGENCY_STOP'):worker(db,broker,source).dispatch(event,before_effect=stop)
        assert not broker.calls
    finally:broker.engine.dispose()


def test_actual_pg_disabled_module_fences_submission(database,tmp_path):
    engine,owner,event,intent,broker,source=prepared(database,tmp_path)
    def disable():
        with Session(engine) as db:
            db.scalar(select(UserModulePreferences).where(UserModulePreferences.user_id==owner).with_for_update())
            row=db.scalar(select(UserModule).where(UserModule.user_id==owner));row.enabled=False;row.version+=1;db.commit()
    try:
        with Session(engine) as db:
            with pytest.raises(OrderDenied):worker(db,broker,source).dispatch(event,before_effect=disable)
        assert not broker.calls
    finally:broker.engine.dispose()


def test_actual_pg_acceptance_timeout_restart_read_only(database,tmp_path):
    engine,owner,event,intent,broker,source=prepared(database,tmp_path,['after_acceptance'])
    try:
        with Session(engine) as db:
            with pytest.raises(TimeoutError):worker(db,broker,source).dispatch(event)
        restarted=ExecutionBrokerFake(broker.engine,broker.binding)
        with Session(engine) as db:
            assert worker(db,restarted,source).reconcile(owner,intent).state=='filled'
        assert not restarted.calls and len(broker.calls)==1
    finally:broker.engine.dispose()


def test_actual_pg_parallel_reconciliation_reserves_one_read(database,tmp_path):
    engine,owner,event,intent,broker,source=prepared(database,tmp_path,['before_acceptance'])
    try:
        with Session(engine) as db:
            with pytest.raises(TimeoutError):worker(db,broker,source).dispatch(event)
        def read(_):
            with Session(engine) as db:
                try:worker(db,broker,source).reconcile(owner,intent);return True
                except OrderDenied:db.rollback();return False
        with ThreadPoolExecutor(2) as pool: assert sum(pool.map(read,range(2)))==1
        with Session(engine) as db:assert db.scalar(select(ExecutionAttempt)).polls==1
        assert len(broker.calls)==1
    finally:broker.engine.dispose()


def test_actual_additive_execution_migration_roundtrip(database):
    engine,_,_,schema,_=database
    from app.infrastructure.database.base import Base
    Base.metadata.drop_all(engine)
    env={**os.environ,'PGOPTIONS':f'-csearch_path={schema}'}
    backend=Path(__file__).resolve().parents[1]
    def migrate(direction,target):subprocess.run([sys.executable,'-m','alembic',direction,target],cwd=backend,env=env,check=True,capture_output=True,text=True,timeout=90)
    migrate('upgrade','order_intents_001')
    assert 'order_execution_runs' not in inspect(engine).get_table_names()
    migrate('upgrade','order_execution_001')
    assert set(['order_execution_runs','order_execution_attempts','order_execution_fences']) <= set(inspect(engine).get_table_names())
    migrate('downgrade','order_intents_001')
    assert not set(['order_execution_runs','order_execution_attempts','order_execution_fences']) & set(inspect(engine).get_table_names())


def test_actual_pg_guarded_failed_downgrade_preserves_execution_rows(database,tmp_path,monkeypatch):
    import importlib.util
    import hashlib
    import sqlalchemy as sa
    engine,owner,event,intent,broker,source=prepared(database,tmp_path,['before_acceptance'])
    _,_,_,schema,_=database
    try:
        with Session(engine) as db:
            with pytest.raises(TimeoutError):worker(db,broker,source).dispatch(event)
        path=Path(__file__).resolve().parents[2]/'deploy/uat2/native/schema_service.py'
        spec=importlib.util.spec_from_file_location('stage15_pg_helper',path);helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        monkeypatch.setattr(helper,'ARTIFACTS',tmp_path)
        fingerprint='a'*64
        monkeypatch.setattr(helper,'capture',lambda _:dict(revision=helper.STAGE15,fingerprint=fingerprint))
        material=tmp_path/('1'*32+'-material.json');material.write_bytes(b'SYNTHETIC PRESERVATION RECEIPT');material.chmod(0o600)
        translated=engine.execution_options(schema_translate_map={'public':schema})
        def failed_ddl(target,*,connection):
            assert target==helper.STAGE14 and connection.in_transaction()
            for model in (ExecutionAttempt,ExecutionRun,ExecutionFence):
                assert connection.scalar(sa.select(sa.func.count()).select_from(model))==0
            raise RuntimeError('Synthetic DDL failure after transactional cleanup')
        with pytest.raises(RuntimeError,match='Synthetic DDL failure'):
            helper.execute(translated,'downgrade','2'*32,helper.STAGE15,fingerprint=fingerprint,material_request='1'*32,material_sha=hashlib.sha256(material.read_bytes()).hexdigest(),migrate=failed_ddl,target=helper.STAGE14)
        with Session(engine) as db:
            assert len(db.scalars(select(ExecutionAttempt)).all())==1
            assert len(db.scalars(select(ExecutionRun)).all())==1
            assert len(db.scalars(select(ExecutionFence)).all())==4
    finally:broker.engine.dispose()
