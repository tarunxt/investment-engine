#!/usr/bin/env python3
"""One-shot backend preview: isolated in-memory SQL, fake AI/mail/export only.

No socket, environment URL, credentials, subprocess, provider SDK, broker,
storage path or background service is used. Optional output refuses overwrite.
"""
import argparse
import os
from pathlib import Path
if __name__=='__main__':
    backend=Path(__file__).resolve().parents[1]
    if any(p.exists() for p in [Path.cwd()/'.env',backend/'.env',backend.parent/'.env']):
        raise RuntimeError('Synthetic preview refuses dotenv files')
    # Only this one-shot process is changed. Inherited credentials and URLs
    # never enter settings; neither fixed import-only endpoint is contacted.
    os.environ.clear()
    os.environ.update({'PATH':os.defpath,'ENVIRONMENT':'test','AUTH_DISABLED':'false','CREDX_UAT2':'0',
                       'DATABASE_URL':'postgresql+asyncpg://synthetic:synthetic@127.0.0.1:1/unused_preview',
                       'REDIS_URL':'redis://127.0.0.1:1/15'})
from copy import deepcopy
from datetime import datetime,timezone,timedelta
import json
from sqlalchemy import create_engine,select
from sqlalchemy.orm import Session
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB
from app.infrastructure.database.base import Base
import app.infrastructure.database.all_models
from app.domains.auth.models import User
from app.domains.prompts.models import Prompt
from app.domains.jobs.models import Job
from app.domains.runs.models import Run,AutoRebalanceWorkflow as Workflow,AutoRebalanceWorkflowStage as Stage
from app.domains.modules.models import UserModulePreferences,UserModule
from app.domains.modules.lifecycle import WorkIdentity,current_sync,sync_owner_fence
from app.domains.modules.policy import ModuleFacts
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.recommendation_audit.models import SpendAccount,SpendAttempt
from app.domains.runs.analysis_workflows.contracts import Runtime,STAGES,TOPIC,digest,naive
from app.domains.runs.analysis_workflows.runtime import policy,configured_runtime
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.analysis_workflows.adapters import QueuedAI
from app.domains.ai_limits.jobs import SyntheticGovernance,execute_governed_job
from app.domains.ai_limits.contracts import Limits,BoundaryDenied
from app.domains.ai_limits.private_effects import PrivateEffects,LocalSink,Destination
from app.domains.ai_limits.runner import FakeProvider

@compiles(JSONB,'sqlite')
def json_sqlite(type,compiler,**kw):return 'JSON'


def preview():
    now=datetime.now(timezone.utc);captured=now;engine=create_engine('sqlite://')
    tables=[User,Prompt,Job,Run,Workflow,Stage,UserModulePreferences,UserModule,OutboxMessage,SpendAccount,SpendAttempt]
    Base.metadata.create_all(engine,tables=[m.__table__ for m in tables])
    facts=ModuleFacts(jurisdiction='allowed',plan='allowed',connection='not_required')
    try:
        with Session(engine,expire_on_commit=False,autoflush=False) as db:
            for owner in [1,2]:
                db.add(User(id=owner,email=f'synthetic{owner}@stage13.example.invalid',username=f'synthetic{owner}',password_hash='unusable',is_active=True,is_verified=True))
                db.add(UserModulePreferences(user_id=owner,version=1));db.add(UserModule(user_id=owner,module_id='indmoney_us',enabled=True,version=1,schedules_paused=False,config={'schema_version':1}))
            db.commit()
            def recommendation_source(db,row,job,at):
                return {'owner_id':row.user_id,'module_id':row.module_id,'captured_at':captured,'content_hash':row.execution_json['source_hash'],'currency':'USD','holdings':{'US:SYNTHETIC':'10'},'provenance':{'provider':job.provider,'model':job.model,'prompt_hash':digest(job.prompt),'input_hash':row.execution_json['source_hash'],'prompt_version':job.request_context_json['prompt_version']}}
            def provider(source):
                return FakeProvider({'schema_version':1,'currency':'USD','recommendations':[{'instrument':'US:SYNTHETIC','action':'hold','current_units':'10','final_units':'10','allocation':'.1'}],'provenance':deepcopy(source['provenance'])})
            governance=SyntheticGovernance(Limits(),recommendation_source,lambda db,row,job:{'US:SYNTHETIC'},provider)
            plan={'version':'synthetic-preview-v1','guardrails_version':'stage13-v1','stages':{s:{'provider':'fake','model':'offline','prompt_version':'v1','template':'Synthetic advisory analysis only. No tools.'} for s in STAGES[1:]}}
            runtime=Runtime(lambda db,o,p,**kw:policy(db,o,p,facts=facts,**kw),lambda db,o,p,id=None:{'owner_id':o,'snapshot_id':1,'currency':'USD','captured_at':captured.isoformat(),'holdings':{'US:SYNTHETIC':'10'}},lambda p:plan,QueuedAI(governance),lambda p,d,n:{'timezone':'UTC','calendar_version':'synthetic','market_open':True,'max_lateness_seconds':60,'missed_policy':'skip'},governance)
            service=Workflows(db,runtime);workflow=service.create(1,'indmoney_us','stage13-preview',now=now);db.commit()
            for _ in range(20):
                message=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC,OutboxMessage.execution_attempts==0,OutboxMessage.available_at<=naive(now)).order_by(OutboxMessage.created_at,OutboxMessage.id))
                if message is None:break
                state=service.consume(message.id,now=now);db.commit()
                if state=='waiting':
                    job=db.scalar(select(Job).order_by(Job.id.desc()));execute_governed_job(db,job.id,runtime,now=now)
                now+=timedelta(seconds=6)
            detail=service.detail(1,workflow.id)
            if detail['status']!='completed':
                raise RuntimeError('Synthetic preview did not complete: '+json.dumps(detail,default=str))
            def owned_policy(session,identity):
                sync_owner_fence(session,identity.owner_id);return current_sync(session,identity,facts=facts)
            sink=LocalSink();effects=PrivateEffects(db,owned_policy,sink=sink,preferences=lambda db,i,k:True)
            identity=WorkIdentity(1,'indmoney_us',1)
            artifact=effects.enqueue(identity,'synthetic-export',{'synthetic':True,'result':'advisory only','orders_authorized':False},destination=Destination(1,'indmoney_us','local:synthetic'),now=now);db.commit()
            assert effects.dispatch(1,artifact.id,now=now)=='ready';download=effects.download(1,artifact.id,now=now)
            foreign_denied=False
            try:effects.download(2,artifact.id,now=now)
            except BoundaryDenied:foreign_denied=True
            assert foreign_denied
            selected=db.scalar(select(UserModule).where(UserModule.user_id==1));selected.enabled=False;selected.version+=1;db.commit()
            disabled_denied=False
            try:effects.download(1,artifact.id,now=now)
            except PermissionError:disabled_denied=True
            assert disabled_denied and configured_runtime() is None
            attempts=list(db.scalars(select(SpendAttempt)))
            return {'simulation':True,'workflow_status':detail['status'],'stages':len(detail['stages']),'attempts':len(attempts),'settled_actual_usd':str(sum(a.actual_usd for a in attempts)),'private_download_content_type':download['content_type'],'foreign_download_denied':foreign_denied,'disabled_module_download_denied':disabled_denied,'sink':'local in-memory only','normal_runtime_enabled':False,'live_india_acquisition_available':False,'orders_authorized':False,'provider_network_calls':0,'database':'ephemeral in-memory SQLite; not migration evidence','browser_verified':False}
    finally:engine.dispose()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output');args=parser.parse_args()
    result=preview();text=json.dumps(result,indent=2)+'\n'
    if args.output:
        with open(args.output,'x') as stream:stream.write(text)
    print(text,end='')
