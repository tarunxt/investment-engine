"""Prepared mandatory PostgreSQL contracts. Run only in named disposable Docker.

Local SQLite is not a substitute. This file was not executed in the local phase;
future CI must assert zero skips and retain receipts. No live database allowed.
"""
import asyncio,os,subprocess,sys
from datetime import datetime,timezone
from pathlib import Path
import pytest
from sqlalchemy import select,inspect,text
from sqlalchemy.exc import IntegrityError
from app.domains.indmoney_us.import_service import ManualImportService
from app.domains.indmoney_us.schemas import IndMoneyUsPortfolioSnapshotCreateRequest as Request
from app.domains.indmoney_us.import_validation import CSV_TEMPLATE,require_recommendation_snapshot
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot as Snapshot
from test_stage09_connections_postgres import database

pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',reason='Named disposable backend Docker PostgreSQL only; future Stage11 CI must reject skips')

@pytest.mark.asyncio
async def test_parallel_duplicate_previews_one_reference(database):
    _,factory,owner,_,_=database
    r=Request(raw_text=CSV_TEMPLATE,captured_at=datetime.now(timezone.utc),format='csv')
    async def preview():
        async with factory() as db:
            row=await ManualImportService(db).preview(owner,r);await db.commit();return row.id
    ids=await asyncio.gather(preview(),preview());assert ids[0]==ids[1]
    async with factory() as db:
        rows=(await db.scalars(select(Snapshot).where(Snapshot.user_id==owner))).all();assert len(rows)==1 and rows[0].acceptance_state=='preview'

@pytest.mark.asyncio
async def test_parallel_explicit_acceptance_preserves_payload(database):
    _,factory,owner,_,_=database
    async with factory() as db:
        row=await ManualImportService(db).preview(owner,Request(raw_text=CSV_TEMPLATE,captured_at=datetime.now(timezone.utc),format='csv'));await db.commit();row_id,hash_=row.id,row.content_hash
    async def accept():
        async with factory() as db:
            try:
                result=await ManualImportService(db).accept(owner,row_id,hash_);await db.commit();return result.content_hash
            except Exception as exc:
                await db.rollback();return exc
    from app.shared.exceptions import ConflictException
    values=await asyncio.gather(accept(),accept());assert all(value==hash_ or isinstance(value,ConflictException) for value in values) and hash_ in values
    async with factory() as db:
        stored=await db.get(Snapshot,row_id);require_recommendation_snapshot(stored);assert stored.content_hash==hash_


def test_actual_stage11_upgrade_downgrade_preserves_stage10_state(database):
    engine,_,_,schema,_=database
    assert Path('/.dockerenv').is_file()
    from app.infrastructure.database.base import Base
    Base.metadata.drop_all(engine)
    backend=Path(__file__).resolve().parents[1];env={**os.environ,'PGOPTIONS':f'-csearch_path={schema}'}
    def migrate(direction,target):subprocess.run([sys.executable,'-m','alembic',direction,target],cwd=backend,env=env,check=True,capture_output=True,text=True,timeout=90)
    migrate('upgrade','connection_attempts_001')
    with engine.begin() as db:
        db.execute(text("INSERT INTO users (email,username,password_hash,role,is_active,is_verified,created_at,updated_at) VALUES ('migration@stage11.example.invalid','synthetic11','unusable','USER',true,true,now(),now())"))
        owner=db.scalar(text('SELECT id FROM users LIMIT1'.replace('LIMIT1','LIMIT 1')))
        db.execute(text("INSERT INTO indmoney_us_portfolio_snapshots (user_id,snapshot_date,captured_at,source,raw_text,parse_status,parse_warnings,holdings_count,indices_count,market_indices,dashboard_top_holdings,holdings,created_at,updated_at) VALUES (:owner,CURRENT_DATE,now(),'manual_paste','SYNTHETIC LEGACY','parsed','[]',0,0,'[]','[]','[]',now(),now())"),{'owner':owner})
    from sqlalchemy.orm import Session
    def legacy():
        with engine.connect() as db:return [tuple(row) for row in db.execute(text('SELECT id,user_id,raw_text,holdings FROM indmoney_us_portfolio_snapshots'))]
    before=legacy()
    from app.domains.connections.models import ConnectionAttempt,IntegrationConnection,ConnectionCredential,ConnectionBindingHistory
    def connections():
        with engine.connect() as db:return {table:[dict(row) for row in db.execute(text('SELECT * FROM '+table)).mappings()] for table in ['connection_attempts','integration_connections','connection_credentials','connection_binding_history']}
    prior=connections()
    for _ in range(2):
        migrate('upgrade','indmoney_integrity_001');columns={x['name'] for x in inspect(engine).get_columns(Snapshot.__tablename__)};assert {'import_provenance','acceptance_state','content_hash','supersedes_id'}<=columns
        assert legacy()==before and connections()==prior
        with engine.connect() as db:assert db.scalar(text('SELECT acceptance_state FROM indmoney_us_portfolio_snapshots LIMIT 1'))=='legacy_unverified'
        migrate('downgrade','connection_attempts_001');assert legacy()==before and connections()==prior
        assert 'import_provenance' not in {x['name'] for x in inspect(engine).get_columns(Snapshot.__tablename__)}
