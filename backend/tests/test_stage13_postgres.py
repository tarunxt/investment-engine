"""Prepared real PostgreSQL gates; run only in acknowledged disposable Docker."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime,timezone
from decimal import Decimal
from pathlib import Path
import os,sys,subprocess
import pytest
from sqlalchemy import select,text,inspect,Table,MetaData
from sqlalchemy.orm import Session
from app.domains.recommendation_audit.models import SpendAccount,SpendAttempt
from app.domains.modules.lifecycle import WorkIdentity
from app.domains.ai_limits.budget import Budgets
from app.domains.ai_limits.contracts import Limits,BoundaryDenied
from test_stage09_connections_postgres import database

pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',reason='Mandatory disposable backend Docker PostgreSQL; CI rejects skips')
NOW=datetime.now(timezone.utc)

def policy(db,identity):
    # Real row fence using the existing User identity; no provider entitlements.
    from app.domains.auth.models import User
    user=db.scalar(select(User).where(User.id==identity.owner_id).with_for_update().execution_options(populate_existing=True))
    if not user or not user.is_active or identity.module_id!='indmoney_us' or identity.version!=1:raise BoundaryDenied('SYNTHETIC_POLICY_DENIED')

def enqueue(db,owner,key,limits):
    row=Budgets(db,limits,policy).enqueue(WorkIdentity(owner,'indmoney_us',1),key,'attempt',{},input_tokens=100,output_tokens=100,fanout=1,now=NOW);db.commit();return row.id

def test_atomic_global_cap_under_parallel_actual_pg_claims(database):
    engine,_,owner,_,_=database;limits=replace(Limits(),platform_daily_usd='.05')
    with Session(engine) as db:
        from app.domains.auth.models import User
        others=[User(email=f'neighbor{i}@stage13.example.invalid',username=f'neighbor{i}',password_hash='unusable',is_active=True,is_verified=True) for i in range(2)]
        db.add_all(others);db.commit()
        for i,id in enumerate([owner,*[u.id for u in others]]):enqueue(db,id,str(i),limits)
    def claim(_):
        with Session(engine,expire_on_commit=False) as db:
            r=Budgets(db,limits,policy).claim_next(now=NOW);return r.id if r else None
    with ThreadPoolExecutor(3) as pool:result=list(pool.map(claim,range(3)))
    assert sum(x is not None for x in result)==1
    with Session(engine) as db:assert sum(a.reserved_usd for a in db.scalars(select(SpendAccount)))==Decimal('.05')

def test_parallel_same_attempt_enqueue_is_one_receipt(database):
    engine,_,owner,_,_=database
    def make(_):
        with Session(engine,expire_on_commit=False) as db:return enqueue(db,owner,'same',Limits())
    with ThreadPoolExecutor(2) as pool:ids=list(pool.map(make,range(2)))
    assert ids[0]==ids[1]
    with Session(engine) as db:assert len(db.scalars(select(SpendAttempt)).all())==1

def test_parallel_actual_pg_settlement_is_exactly_once(database):
    engine,_,owner,_,_=database
    with Session(engine) as db:
        id=enqueue(db,owner,'once',Limits());Budgets(db,Limits(),policy).claim_next(now=NOW)
    def settle(_):
        with Session(engine) as db:return Budgets(db,Limits(),policy).settle(owner,id,'.01',now=NOW).status
    with ThreadPoolExecutor(2) as pool:assert list(pool.map(settle,range(2)))==['settled','settled']
    with Session(engine) as db:
        account=db.scalar(select(SpendAccount).where(SpendAccount.user_id==owner));assert account.spent_usd==Decimal('.01') and account.reserved_usd==0

def test_disabled_owner_before_dispatch_leaves_no_started_attempt(database):
    engine,_,owner,_,_=database
    from app.domains.auth.models import User
    with Session(engine) as db:
        id=enqueue(db,owner,'disabled',Limits());db.get(User,owner).is_active=False;db.commit()
        assert Budgets(db,Limits(),policy).claim_next(now=NOW) is None
        assert db.get(SpendAttempt,id).status=='cancelled'

def test_actual_pg_noisy_neighbor_leaves_other_owner_slot(database):
    engine,_,owner,_,_=database
    from app.domains.auth.models import User
    with Session(engine) as db:
        neighbor=User(email='fair@stage13.example.invalid',username='fair_neighbor',password_hash='unusable',is_active=True,is_verified=True);db.add(neighbor);db.commit();other=neighbor.id
        for key in ['a','b','c']:enqueue(db,owner,key,Limits())
        enqueue(db,other,'neighbor',Limits())
        budget=Budgets(db,Limits(),policy);first=budget.claim_next(now=NOW);second=budget.claim_next(now=NOW)
        assert {first.user_id,second.user_id}=={owner,other}
        assert budget.claim_next(now=NOW) is None

def test_actual_pg_disable_serializes_with_already_started_local_export(database):
    from threading import Event
    from sqlalchemy import update
    from app.domains.auth.models import User
    from app.domains.ai_limits.private_effects import PrivateEffects,LocalSink,Destination
    engine,_,owner,_,_=database;entered=Event();release=Event();sink=LocalSink();deliver=sink.deliver
    def paused(key,payload):entered.set();assert release.wait(3);return deliver(key,payload)
    sink.deliver=paused
    with Session(engine) as db:
        r=PrivateEffects(db,policy,sink=sink,preferences=lambda *a:True).enqueue(WorkIdentity(owner,'indmoney_us',1),'export',{'synthetic':True},destination=Destination(owner,'indmoney_us','local:synthetic'));id=r.id;db.commit()
    def dispatch():
        with Session(engine) as db:return PrivateEffects(db,policy,sink=sink,preferences=lambda *a:True).dispatch(owner,id)
    def disable():
        with Session(engine) as db:
            db.execute(update(User).where(User.id==owner).values(is_active=False));db.commit()
    with ThreadPoolExecutor(2) as pool:
        effect=pool.submit(dispatch);assert entered.wait(3);disabled=pool.submit(disable)
        try:
            from concurrent.futures import TimeoutError
            with pytest.raises(TimeoutError):disabled.result(timeout=.1)
        finally:release.set()
        assert effect.result(timeout=5)=='ready';disabled.result(timeout=5)
    with Session(engine) as db:
        with pytest.raises(BoundaryDenied):PrivateEffects(db,policy).download(owner,id)

def test_real_stage13_migration_preserves_legacy_and_refuses_lossy_downgrade(database):
    engine,_,_,schema,_=database;assert Path('/.dockerenv').is_file()
    from app.infrastructure.database.base import Base
    Base.metadata.drop_all(engine)
    backend=Path(__file__).resolve().parents[1];env={**os.environ,'PGOPTIONS':f'-csearch_path={schema}'}
    def migrate(direction,target,check=True):return subprocess.run([sys.executable,'-m','alembic',direction,target],cwd=backend,env=env,check=check,capture_output=True,text=True,timeout=90)
    migrate('upgrade','durable_analysis_001')
    with engine.begin() as db:
        db.execute(text("INSERT INTO recommendation_spend_accounts (id,user_id,day,cap_usd,spent_usd,reserved_usd) VALUES ('legacy',1,'2026-10-21',1,.01,0)"))
        db.execute(text("INSERT INTO recommendation_spend_attempts (id,verification_id,user_id,account_id,attempt_key,adapter,tariff_version,upper_bound_usd,status,created_at) VALUES ('legacy','verification-legacy',1,'legacy','old','fake','synthetic-v1',.01,'settled',now())"))
    def snapshot():
        with engine.connect() as db:return {name:[tuple(row) for row in db.execute(text('SELECT * FROM '+name+' ORDER BY id'))] for name in ['recommendation_spend_accounts','recommendation_spend_attempts']}
    before=snapshot()
    for _ in range(2):
        migrate('upgrade','ai_limits_001');assert {'operation_key','request_hash','limits_json'}<={c['name'] for c in inspect(engine).get_columns('recommendation_spend_attempts')}
        migrate('downgrade','durable_analysis_001');assert snapshot()==before
    migrate('upgrade','ai_limits_001')
    with engine.begin() as db:
        db.execute(text("INSERT INTO recommendation_spend_attempts (id,user_id,account_id,attempt_key,adapter,tariff_version,upper_bound_usd,status,created_at,operation_key) VALUES ('new',1,'legacy','new','fake','synthetic-v1',.01,'uncertain',now(),'new-op')"))
    assert migrate('downgrade','durable_analysis_001',check=False).returncode!=0
    with engine.connect() as db:
        assert db.scalar(text("SELECT version_num FROM alembic_version"))=='ai_limits_001'
        assert db.scalar(text("SELECT count(*) FROM recommendation_spend_attempts"))==2
