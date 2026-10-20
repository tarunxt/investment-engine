"""Explicit standalone private fake-work proof for the existing UAT2 executor.

No HTTP route imports this module. No live DB, broker, credentials, provider or
owner record is used. The only database is an automatically removed local file.
Positive cases use process-local fake eligibility, never a service flag change.
"""
import asyncio
import json
import os
from pathlib import Path
import socket
import tempfile
from unittest.mock import patch


def main():
    if os.getenv('CREDX_UAT2')!='1' or os.getenv('CREDX_STAGE07_SMOKE_ACK')!='private-synthetic-only':
        raise SystemExit('Explicit UAT2/private-synthetic-only acknowledgement required')
    # Satisfy import-time settings without requiring any live connection.
    os.environ.setdefault('DATABASE_URL','postgresql+psycopg2://synthetic:unused@127.0.0.1:1/private_smoke_unused')
    os.environ.setdefault('REDIS_URL','redis://127.0.0.1:1/15')
    def no_network(*args,**kwargs):raise RuntimeError('Private lifecycle smoke forbids all network connections')
    with patch.object(socket.socket,'connect',no_network),patch.object(socket.socket,'connect_ex',no_network),patch.object(socket,'create_connection',no_network):
        import app.models
        from sqlalchemy import create_engine,select,func
        from sqlalchemy.orm import Session,sessionmaker
        from sqlalchemy.dialects.postgresql import JSONB
        from sqlalchemy.ext.compiler import compiles
        @compiles(JSONB,'sqlite')
        def json_type(*args,**kwargs):return 'JSON'
        from app.domains.auth.models import User,UserProfile,ActivityLog
        from app.domains.prompts.models import Prompt
        from app.domains.jobs.models import Job
        from app.domains.runs.models import Run,RunJob,AutoRebalanceWorkflow,AutoRebalanceWorkflowStage
        from app.domains.modules.models import UserModule,UserModulePreferences
        from app.infrastructure.database.outbox.models import OutboxMessage
        from app.domains.modules import policy,service
        from app.domains.modules.policy import ModuleFacts,DefaultFactsResolver
        from app.domains.modules.schemas import ModulePatch
        from app.domains.modules.lifecycle import WorkIdentity,current_sync,ModuleLifecycleDenied
        from app.domains.modules.execution import execution_scope,guarded_effect
        from app.shared.types import JobStatus
        from app.core import uat2
        class AsyncFacade:
            def __init__(self,session):self.session=session
            def get_bind(self):return self.session.get_bind()
            def add(self,row):return self.session.add(row)
            async def execute(self,*args,**kw):return self.session.execute(*args,**kw)
            async def scalar(self,*args,**kw):return self.session.scalar(*args,**kw)
            async def flush(self):return self.session.flush()
            async def commit(self):return self.session.commit()
            async def rollback(self):return self.session.rollback()
        with tempfile.TemporaryDirectory(prefix='credx-stage07-private-') as directory:
            engine=create_engine('sqlite:///'+str(Path(directory)/'synthetic.sqlite3'))
            for model in (User,UserProfile,ActivityLog,Prompt,Job,Run,RunJob,AutoRebalanceWorkflow,AutoRebalanceWorkflowStage,UserModulePreferences,UserModule,OutboxMessage):
                model.__table__.create(engine)
            factory=sessionmaker(engine,expire_on_commit=False)
            with factory() as db:
                users=[User(email=f'{name}@example.invalid',username=f'synthetic_{name}',password_hash='unusable',is_active=True,is_verified=True,profile=UserProfile()) for name in ('a','b')]
                db.add_all(users);db.commit();owner,foreign=[u.id for u in users]
            def eligible(self,user,module):
                return ModuleFacts(jurisdiction='allowed',plan='allowed',connection='ready',execution_capability=True)
            # These patches exist only inside this standalone no-egress process
            # and file fixture. Actual UAT2 service availability remains closed.
            with patch.object(uat2,'uat2_mode',lambda:False),patch.object(policy,'uat2_mode',lambda:False),patch.object(service,'uat2_mode',lambda:False),patch.object(DefaultFactsResolver,'resolve_sync',eligible):
                def selection(version,enabled):
                    with factory() as db:
                        return asyncio.run(service.patch_modules(AsyncFacade(db),owner,ModulePatch.model_validate({'expected_version':version,'updates':[{'module_id':'ai_studio','enabled':enabled}]})))
                selection(0,True)
                with factory() as db:
                    records=[Job(user_id=user,prompt='Private fake work',provider='synthetic',model='offline',status=status,module_id='ai_studio',module_version=1)
                        for user,status in [(owner,JobStatus.PENDING),(owner,JobStatus.PROCESSING),(owner,JobStatus.COMPLETED),(foreign,JobStatus.PENDING)]]
                    db.add_all(records);db.commit();ids=[r.id for r in records]
                effects=[];identity=WorkIdentity(owner,'ai_studio',1)
                with execution_scope(identity,factory):guarded_effect(lambda:effects.append('fake-before-disable'))()
                selection(1,False)
                with factory() as db:
                    assert db.get(Job,ids[0]).status==JobStatus.FAILED
                    assert db.get(Job,ids[1]).module_cancel_requested
                    assert db.get(Job,ids[2]).status==JobStatus.COMPLETED
                    assert not db.get(Job,ids[3]).module_cancel_requested
                    try:current_sync(db,identity)
                    except ModuleLifecycleDenied:pass
                    else:raise AssertionError('Stale running work allowed after disable')
                selection(2,True)
                with factory() as db:
                    row=db.scalar(select(UserModule).where(UserModule.user_id==owner))
                    assert row.enabled and row.schedules_paused
                    assert db.get(Job,ids[0]).status==JobStatus.FAILED
                    try:current_sync(db,identity)
                    except ModuleLifecycleDenied:pass
                    else:raise AssertionError('Reenable revived stale work')
                    assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic=='modules.selection.changed.v1'))==3
                assert effects==['fake-before-disable']
            engine.dispose()
    print(json.dumps({'result':'passed','checks':['fake effect before disable','queued cancellation','running cooperative stop flag and fresh denial','foreign owner unchanged','completed history retained','reenable does not resume schedules or old work','transactional selection events'],
        'network':'all socket connections forbidden','database':'private temporary SQLite file removed','live_owner_or_database_changed':False,
        'limits':'No PostgreSQL concurrency or live service policy claim; positive eligibility is process-local fake data only'},sort_keys=True))

if __name__=='__main__':main()
