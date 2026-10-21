"""Prepared exact-head gates: only existing acknowledged disposable PostgreSQL."""
import os
from concurrent.futures import ThreadPoolExecutor
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_stage09_connections_postgres import database
from test_stage14_postgres import setup
from app.domains.public_service.privacy import PrivacyRequests,TOPIC
from app.domains.auth.models import User,ActivityLog
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.ai_limits.contracts import BoundaryDenied
pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',reason='Only acknowledged disposable Docker PostgreSQL; exact CI must reject skips')
def test_pg_parallel_privacy_request_one_receipt(database):
    engine,owner=setup(database)
    def request(_):
        with Session(engine) as s:
            r=PrivacyRequests(s).request(owner,'same','delete',confirmed=True);id=r.id;s.commit();return id
    with ThreadPoolExecutor(2) as pool:ids=list(pool.map(request,range(2)))
    assert ids[0]==ids[1]
    with Session(engine) as s:
        assert len(list(s.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC))))==1
        assert len(list(s.scalars(select(ActivityLog).where(ActivityLog.action=='privacy_requested'))))==1

def test_pg_conflicting_privacy_request_has_one_binding(database):
    engine,owner=setup(database)
    def request(kind):
        with Session(engine) as s:
            try:PrivacyRequests(s).request(owner,'same',kind,confirmed=True);s.commit();return True
            except BoundaryDenied:s.rollback();return False
    with ThreadPoolExecutor(2) as pool:assert sum(pool.map(request,['export','delete']))==1

def test_pg_inactive_owner_fails_without_request(database):
    engine,owner=setup(database)
    with Session(engine) as s:s.get(User,owner).is_active=False;s.commit()
    with Session(engine) as s:
        with pytest.raises(BoundaryDenied):PrivacyRequests(s).request(owner,'same','delete',confirmed=True)
        s.rollback();assert not list(s.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC)))
