#!/usr/bin/env python3
"""One-shot private exact-order walkthrough. No listener, credentials or network.

Run with PYTHONPATH=backend and the existing backend development runtime.
The backend-only review uses real domain code and isolated disposable SQLite;
this is not a frontend, live broker acceptance, or a normal-runtime activation.
"""
import os
from pathlib import Path
if __name__=='__main__':
    backend=Path(__file__).resolve().parents[1]
    if any(p.exists() for p in [Path.cwd()/'.env',backend/'.env',backend.parent/'.env']):raise RuntimeError('Synthetic preview refuses dotenv files')
    os.environ.clear()
    os.environ.update({'PATH':os.defpath,'ENVIRONMENT':'test','AUTH_DISABLED':'false','CREDX_UAT2':'0',
                       'DATABASE_URL':'postgresql+asyncpg://synthetic:synthetic@127.0.0.1:1/unused_preview',
                       'REDIS_URL':'redis://127.0.0.1:1/15'})
import json,tempfile,subprocess
from pathlib import Path
from datetime import datetime,timezone,timedelta
from types import SimpleNamespace
from sqlalchemy import create_engine,select
from sqlalchemy.orm import Session
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB
from app.infrastructure.database.base import Base
import app.models
from app.domains.auth.models import User
from app.domains.modules.models import UserModulePreferences,UserModule
from app.domains.modules.lifecycle import WorkIdentity
from app.domains.connections.models import IntegrationConnection
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.order_intents.service import Orders,MODULE,TOPIC
from app.domains.order_intents.models import OrderIntent,OrderLeg
from app.domains.order_intents.authority import authenticated_confirmation
from app.domains.order_intents.contracts import OrderDenied,digest
from app.domains.order_intents.fake import FakeBroker

@compiles(JSONB,'sqlite')
def json_sqlite(type,compiler,**kw):return 'JSON'

def main():
    with tempfile.TemporaryDirectory(prefix='credx-stage14-synthetic-') as directory:
        engine=create_engine('sqlite:///'+str(Path(directory)/'preview.sqlite'))
        Base.metadata.create_all(engine,tables=[m.__table__ for m in [User,UserModulePreferences,UserModule,IntegrationConnection,OrderIntent,OrderLeg,OutboxMessage]])
        now=datetime.now(timezone.utc)
        with Session(engine,expire_on_commit=False) as db:
            user=User(email='owner@stage14.example.invalid',username='synthetic_owner',password_hash='unusable',is_active=True,is_verified=True);db.add(user);db.flush();db.add(UserModulePreferences(user_id=user.id,version=1));db.flush();db.add(UserModule(user_id=user.id,module_id=MODULE,version=1,enabled=True,config={}))
            db.add(IntegrationConnection(id='synthetic-connection',owner_id=user.id,provider='zerodha',provider_account_id='FAKEACCOUNT',app_ownership_mode='user_owned',version=1,is_current=True,status='active',token_expires_at=now+timedelta(hours=1)));db.commit()
            def policy(db,i):
                m=db.scalar(select(UserModule).where(UserModule.user_id==i.owner_id,UserModule.module_id==MODULE))
                if not m or not m.enabled or i.version!=m.version:raise OrderDenied('SYNTHETIC_POLICY_DENIED')
            def risk(db,i,p,c,now):return {'allowed':True,'source':'synthetic-only','account':c.provider_account_id,'payload_digest':digest(p),'version':1}
            service=Orders(db,policy=policy,risk=risk)
            order={'sequencing':'listed','legs':[{'exchange':'NSE','symbol':'SYNTHETIC','side':'BUY','quantity':10,'limit_price':'100.00','product':'CNC','order_type':'LIMIT'}]}
            row=service.create(WorkIdentity(user.id,MODULE,1),'synthetic-operation','synthetic-connection',order);db.commit();service.validate(user.id,row.id);review=service.review(user.id,row.id);db.commit()
            try:service.approve(user.id,row.id,review['review_digest'],action='confirm_exact_order_or_basket')
            except OrderDenied:worker_denied=True
            with authenticated_confirmation(user,row.id,review['review_digest']):service.approve(user.id,row.id,review['review_digest'],action='confirm_exact_order_or_basket')
            db.commit();event=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC));broker=FakeBroker(['filled']);service.dispatch(event.id,broker)
            try:service.dispatch(event.id,broker)
            except OrderDenied:replay_denied=True
            source=subprocess.check_output(['git','rev-parse','HEAD'],cwd=Path(__file__).resolve().parents[2],text=True).strip()
            print(json.dumps({'source':source,'synthetic_preview_only':True,'normal_runtime_enabled':False,'review':review,'final_state':row.state,'worker_self_approval_denied':worker_denied,'duplicate_dispatch_denied':replay_denied,'fake_calls':len(broker.calls),'financial_or_network_calls':0,'database_removed_on_exit':True},indent=2))
        engine.dispose()
if __name__=='__main__':main()
