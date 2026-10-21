"""Prepared disposable PostgreSQL gates; never run against a live database."""
import os
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_stage09_connections_postgres import database
from test_stage14_postgres import setup, prepared, policy, risk
from test_stage14_order_intents import confirm
from app.domains.order_intents.presentation import owned_reviews
from app.domains.order_intents.service import Orders, TOPIC
from app.domains.order_intents.contracts import OrderDenied
from app.domains.modules.models import UserModule, UserModulePreferences
from app.domains.connections.models import IntegrationConnection
from app.infrastructure.database.outbox.models import OutboxMessage
pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',reason='Only acknowledged disposable Docker PostgreSQL; CI rejects skips')
RUNTIME=SimpleNamespace(policy=policy,risk=risk)


def test_pg_read_only_ownership_and_no_dispatch(database):
    engine,owner=setup(database);id,_=prepared(engine,owner)
    with Session(engine) as db:
        assert owned_reviews(db,owner)['intents'][0]['id']==id
        assert owned_reviews(db,owner+999,intent_id=id)['intents']==[]
        assert list(db.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC)))==[]


def test_pg_two_tabs_confirm_exactly_once_and_reload_status(database):
    engine,owner=setup(database);id,review=prepared(engine,owner)
    def click(_):
        with Session(engine) as db:
            try:
                confirm(Orders(db,policy=policy,risk=risk),owner,id,review['review_digest'],action='confirm_exact_order_or_basket');db.commit();return True
            except OrderDenied:db.rollback();return False
    with ThreadPoolExecutor(2) as pool:assert sum(pool.map(click,range(2)))==1
    with Session(engine) as db:
        view=owned_reviews(db,owner,runtime=RUNTIME)['intents'][0]
        assert view['state']=='approved' and not view['actions']['confirm']
        assert len(list(db.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC))))==1


def test_pg_disable_commit_keeps_history_but_invalidates_stale_tab(database):
    engine,owner=setup(database);id,review=prepared(engine,owner)
    with Session(engine) as db:assert owned_reviews(db,owner,runtime=RUNTIME)['intents'][0]['actions']['confirm']
    with Session(engine) as db:
        db.scalar(select(UserModulePreferences).where(UserModulePreferences.user_id==owner).with_for_update())
        module=db.scalar(select(UserModule).where(UserModule.user_id==owner));module.enabled=False;module.version+=1;db.commit()
    with Session(engine) as db:
        view=owned_reviews(db,owner,runtime=RUNTIME)['intents'][0]
        assert view['id']==id and not view['actions']['confirm']
        with pytest.raises(OrderDenied):confirm(Orders(db,policy=policy,risk=risk),owner,id,review['review_digest'],action='confirm_exact_order_or_basket')
        db.rollback();assert not list(db.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC)))


def test_pg_account_version_change_invalidates_review_without_hiding_it(database):
    engine,owner=setup(database);id,review=prepared(engine,owner)
    with Session(engine) as db:
        connection=db.get(IntegrationConnection,'fake');connection.version+=1;db.commit()
    with Session(engine) as db:
        view=owned_reviews(db,owner,runtime=RUNTIME)['intents'][0]
        assert view['id']==id and not view['actions']['confirm']
        with pytest.raises(OrderDenied):confirm(Orders(db,policy=policy,risk=risk),owner,id,review['review_digest'],action='confirm_exact_order_or_basket')
