"""Actual complete-model PG relationship gates, never SQLite acceptance."""
import os
import pytest
from sqlalchemy.orm import Session
from app.infrastructure.database.base import Base
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.public_service.canonical_privacy_inventory import assert_owned_relationships
from test_stage09_connections_postgres import database

pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',
    reason='Actual acknowledged disposable PostgreSQL required; CI must reject skips')

@pytest.fixture
def canonical_db(database):
    original,_,owner,_,_=database
    engine=original.execution_options(isolation_level="REPEATABLE READ")
    with Session(engine) as db:
        users=Base.metadata.tables['users']
        other=db.execute(users.insert().values(email='canonical-foreign@example.invalid',username='canonical_foreign',
            password_hash='unusable-synthetic',is_active=True,is_verified=True).returning(users.c.id)).scalar_one()
        jobs=Base.metadata.tables['jobs'];runs=Base.metadata.tables['runs'];links=Base.metadata.tables['run_jobs']
        for id in (owner,other):
            db.execute(jobs.insert().values(id=id,user_id=id,prompt='synthetic',provider='fake',model='fake'))
            db.execute(runs.insert().values(id=id,user_id=id,prompt='synthetic',prompt_preview='synthetic'))
        db.execute(links.insert().values(id=1,run_id=owner,job_id=owner));db.commit()
        yield db,owner,other


def test_actual_pg_canonical_relationships_accept_consistent_source_rows(canonical_db):
    db,owner,_=canonical_db
    assert assert_owned_relationships(db,Base.metadata,owner).inventory.schema_digest


def test_actual_pg_secondary_foreign_parent_blocks_before_projection(canonical_db):
    db,owner,other=canonical_db;table=Base.metadata.tables['run_jobs']
    db.execute(table.update().where(table.c.id==1).values(run_id=other));db.commit()
    with pytest.raises(BoundaryDenied,match='RELATIONSHIP_HELD'):
        assert_owned_relationships(db,Base.metadata,owner)


def test_actual_pg_system_prompt_allowed_but_foreign_private_parent_held(canonical_db):
    db,owner,other=canonical_db;table=Base.metadata.tables['prompts']
    system=db.execute(table.insert().values(user_id=None,name='synthetic system',body='synthetic',is_system=True).returning(table.c.id)).scalar_one()
    clone=db.execute(table.insert().values(user_id=owner,name='synthetic clone',body='synthetic',is_system=False,source_prompt_id=system).returning(table.c.id)).scalar_one()
    foreign=db.execute(table.insert().values(user_id=other,name='synthetic private',body='synthetic',is_system=False).returning(table.c.id)).scalar_one();db.commit()
    assert_owned_relationships(db,Base.metadata,owner)
    db.execute(table.update().where(table.c.id==clone).values(source_prompt_id=foreign));db.commit()
    with pytest.raises(BoundaryDenied,match='RELATIONSHIP_HELD'):
        assert_owned_relationships(db,Base.metadata,owner)


def test_actual_pg_fences_do_not_adopt_platform_foreign_or_unknown_keys(canonical_db):
    from app.domains.public_service.canonical_privacy_resolvers import owned_execution_fences
    db,owner,other=canonical_db;table=Base.metadata.tables['order_execution_fences']
    connection='00000000-0000-0000-0000-000000000001';foreign='00000000-0000-0000-0000-000000000002'
    connections=Base.metadata.tables['integration_connections']
    db.execute(connections.insert(),[{'id':connection,'owner_id':owner,'app_ownership_mode':'user_owned'},
        {'id':foreign,'owner_id':other,'app_ownership_mode':'user_owned'}])
    keys=[f'owner:{owner}',f'owner:{other}','platform','account:unproven','connection:'+connection,'connection:'+foreign]
    db.execute(table.insert(),[{'key':key,'stopped':True} for key in keys]);db.commit()
    result=owned_execution_fences(db,Base.metadata,owner)
    assert result['items']==[{'key':'connection:'+connection,'stopped':True},{'key':f'owner:{owner}','stopped':True}]
    assert result['deletable'] is False and result['platform_retained'] is True


def test_actual_pg_read_committed_cannot_claim_stable_canonical_integrity(database):
    engine,_,owner,_,_=database
    with Session(engine.execution_options(isolation_level='READ COMMITTED')) as db:
        with pytest.raises(BoundaryDenied,match='SNAPSHOT_REQUIRED'):
            assert_owned_relationships(db,Base.metadata,owner)
