"""Local composition only. Background progress does not depend on a browser."""
import os,re
from copy import deepcopy
from datetime import datetime,timezone
from sqlalchemy import select
if os.environ.get('STAGE01_PREVIEW')!='synthetic-only':raise RuntimeError('Local synthetic preview only')
from app.domains.runs.analysis_router import router,optional_analysis_runtime
from app.domains.runs.analysis_workflows.contracts import Runtime,TOPIC,naive
from app.domains.runs.analysis_workflows.runtime import policy
from app.domains.runs.analysis_workflows.adapters import DeterministicAnalysis
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.modules.policy import ModuleFacts
from app.infrastructure.database.outbox.models import OutboxMessage

def source(db,owner,portfolio,snapshot_id=None):
    # Public fixture, never a real import/account. This binding exists ONLY here.
    return {'owner_id':owner,'snapshot_id':owner,'version':'stage12-fixture-1','portfolio':portfolio,'currency':'USD' if portfolio=='indmoney_us' else 'INR','holdings':[{'symbol':'SYNTHETIC','quantity':2,'value':110}],'connection':{'version':1,'synthetic':True}}

runtime=Runtime(lambda db,o,p,**kw:policy(db,o,p,facts=ModuleFacts(jurisdiction='allowed',plan='allowed',connection='not_required'),**kw),source,lambda p:{'version':'synthetic-plan-1','stages':{s:{'provider':'synthetic','model':'offline','prompt_version':'synthetic-1','template':'Synthetic analysis only'} for s in ('threats','swing','rebalance','technical','actionables')}},DeterministicAnalysis(),lambda p,d,n:{'timezone':'Asia/Kolkata','calendar_version':'synthetic-all-open-1','market_open':True,'max_lateness_seconds':60,'missed_policy':'skip'})

def allowed(method,path):
    return (method=='GET' and re.fullmatch(r'/runs/analysis-workflows(?:/config|/[1-9][0-9]*)?',path) is not None or method=='POST' and re.fullmatch(r'/runs/analysis-workflows(?:/[1-9][0-9]*/controls)?',path) is not None)

def install(app):
    app.dependency_overrides[optional_analysis_runtime]=lambda:runtime
    app.include_router(router)

async def tick(db):
    def advance(session):
        now=datetime.now(timezone.utc)
        row=session.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC,OutboxMessage.execution_attempts==0,OutboxMessage.available_at<=naive(now)).order_by(OutboxMessage.created_at).limit(1))
        if row:Workflows(session,runtime).consume(row.id,now=now)
    await db.run_sync(advance)
    await db.commit()
