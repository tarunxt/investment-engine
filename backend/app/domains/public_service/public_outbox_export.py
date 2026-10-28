"""Closed read-only projections for consent, privacy and local monitor records.

No authority is granted by these projections. Unknown/encrypted topic payloads
remain held; no raw request keys, tickets, recipients or ciphertext are returned.
"""
from datetime import datetime
from sqlalchemy import select,case,cast,Text,LargeBinary,func,or_
from app.domains.ai_limits.contracts import BoundaryDenied,digest,utc
from app.domains.auth.models import User
from app.domains.runs.models import Run
from app.domains.modules.dispatch import TOPIC as TASK,resource_locator
from app.domains.modules.lifecycle import ModuleLifecycleDenied
from app.domains.jobs.models import Job
from app.domains.order_intents.models import OrderIntent
from app.domains.order_intents.service import TOPIC as APPROVAL
from .dispatch import TOPIC as QUEUE,IMMUTABLE
from uuid import UUID
from app.domains.modules.models import UserModulePreferences
from app.domains.modules.registry import ModuleId
from app.domains.modules.lifecycle import TOPIC as SELECTION
from app.infrastructure.database.outbox.models import OutboxMessage
from .support import TOPIC as SUPPORT,SCOPES
from .privacy import TOPIC as PRIVACY
from .monitor_dispatch import TOPIC as MONITOR,MonitorDispatch
from .store import owner
from .sql_account import _json_value,_encode

JOB='job.created.v2'
RESUME='modules.schedules.resumed.v1'
USER_TOPICS=frozenset({JOB,SELECTION,RESUME,TASK})
TOPICS=frozenset({SUPPORT,PRIVACY,MONITOR,QUEUE})|USER_TOPICS


def require(value):
    if not value:raise BoundaryDenied('PUBLIC_ACCOUNT_EVIDENCE_INVALID')


def timestamp(value):
    try:
        require(type(value) is str and len(value)<=64)
        utc(datetime.fromisoformat(value))
    except (TypeError,ValueError):raise BoundaryDenied('PUBLIC_ACCOUNT_EVIDENCE_INVALID') from None
    return value


class PublicOutboxExport:
    def __init__(self,db):self.db=db

    def project(self,topic,p,subject,identifier):
        principal='user_id' if topic in USER_TOPICS else 'owner_id'
        require(type(p) is dict and type(p.get(principal)) is int and p[principal]==subject)
        if topic==TASK:
            import re
            fields={'schema_version','task','request_digest','user_id','module_id','module_version','state','cancel_requested'}
            require(fields<=set(p) and set(p)<=fields|{'resource'} and p['schema_version']==1)
            require(type(p['module_version']) is int and p['module_version']>0 and type(p['cancel_requested']) is bool)
            require(type(p['task']) is str and type(p['request_digest']) is str and re.fullmatch('[0-9a-f]{64}',p['request_digest']) is not None)
            require(p['state'] in {'queued','running','failed','completed','cancelled'} and p['module_id'] in {module.value for module in ModuleId})
            if 'resource' not in p:
                return {'kind':'historical_task_locator','state':p['state'],
                    'resource_status':'held: original arguments were not persisted; digest cannot reconstruct them',
                    'authority_granted':False}
            resource=p['resource']
            require(type(resource) is dict and set(resource)=={'kind','id'} and type(resource['id']) is int and resource['id']>0)
            require(resource==resource_locator(p['task'],[subject,resource['id']],{}))
            model,column={'job':(Job,Job.user_id),'run':(Run,Run.user_id),'user':(User,User.id)}[resource['kind']]
            require(self.db.scalar(select(model.id).where(model.id==resource['id'],column==subject)) is not None)
            return {'kind':'typed_task_locator','resource':resource,'state':p['state'],'authority_granted':False}
        if topic==JOB:
            require(set(p) in ({'job_id','user_id'},{'job_id','user_id','operation'}))
            require(type(p['job_id']) is int and p['job_id']>0 and self.db.scalar(
                select(Job.id).where(Job.id==p['job_id'],Job.user_id==subject)) is not None)
            if 'operation' in p:
                import re
                require(type(p['operation']) is str and re.fullmatch('[a-z][a-z0-9_.:-]{0,99}',p['operation']) is not None)
            return {'kind':'owned_job_dispatch','job_id':p['job_id']}
        if topic in {SELECTION,RESUME}:
            header=self.db.scalar(select(UserModulePreferences.version).where(UserModulePreferences.user_id==subject))
            require(type(p.get('version')) is int and p['version']>0 and type(header) is int and header>=p['version'] and p.get('schema_version')==1)
            known={module.value for module in ModuleId}
            if topic==RESUME:
                require(set(p)=={'schema_version','user_id','module_id','version'} and p['module_id'] in known)
                return {'kind':'schedule_resume_history','module_id':p['module_id'],'version':p['version'],'authority_granted':False}
            require(set(p)=={'schema_version','user_id','version','disabled','changed'})
            for field in ('disabled','changed'):
                require(type(p[field]) is list and len(p[field])<=len(known) and
                    all(type(item) is str and item in known for item in p[field]) and len(set(p[field]))==len(p[field]))
            return {'kind':'module_selection_history','version':p['version'],'disabled':p['disabled'],'changed':p['changed']}
        if topic==QUEUE:
            require(all(key in p for key in IMMUTABLE) and digest({key:p[key] for key in IMMUTABLE})==p.get('seal'))
            require(type(p.get('resource')) is str and 1<=len(p['resource'])<=128)
            require(p.get('state') in {'queued','running','uncertain','completed','failed','cancelled','blocked','reconciled'} and
                type(p.get('attempts')) is int and 0<=p['attempts']<=100)
            if p['lane']=='analysis':
                try:job_id=int(p['resource'])
                except ValueError:raise BoundaryDenied('PUBLIC_ACCOUNT_EVIDENCE_INVALID') from None
                require(str(job_id)==p['resource'])
                job=self.db.scalar(select(Job).where(Job.id==job_id,Job.user_id==subject))
                require(job is not None)
                value={'owner':subject,'job':job.id,'module':job.module_id,'version':job.module_version,
                    'context':job.request_context_json,'prompt':job.prompt,'provider':job.provider,'model':job.model}
            else:
                require(p['lane'] in {'execution','reconciliation'})
                intent=p['resource']
                if p['lane']=='execution':
                    try:event=self.db.get(OutboxMessage,UUID(p['resource']))
                    except ValueError:raise BoundaryDenied('PUBLIC_ACCOUNT_EVIDENCE_INVALID') from None
                    require(event is not None and event.topic==APPROVAL and event.payload.get('owner_id')==subject)
                    intent=event.payload.get('intent_id')
                row=self.db.scalar(select(OrderIntent).where(OrderIntent.id==intent,OrderIntent.owner_id==subject))
                require(row is not None)
                value={'owner':subject,'intent':row.id,'module':row.module_id,'version':row.module_version,
                    'account':row.account_id,'connection':row.connection_id,'connection_version':row.connection_version,
                    'payload':row.request_digest,'approval':row.approval_digest}
            require(digest(value)==p['binding'])
            return {'kind':'owned_operational_queue','lane':p['lane'],'state':p['state'],
                'attempts':p['attempts'],'created_at':timestamp(p['created_at']),'authority_granted':False}
        if topic==SUPPORT:
            fields={'owner_id','actor_id','scopes','ticket_hash','expires_at'}
            require(set(p)==fields|{'seal','state'})
            require(type(p['actor_id']) is int and p['actor_id']!=subject and
                self.db.scalar(select(User.id).where(User.id==p['actor_id'])) is not None)
            require(type(p['scopes']) is list and p['scopes'] and
                all(type(scope) is str and scope in SCOPES for scope in p['scopes']) and
                p['scopes']==sorted(set(p['scopes'])))
            require(type(p['ticket_hash']) is str and len(p['ticket_hash'])==64 and
                digest({key:p[key] for key in fields})==p['seal'] and p['state'] in {'granted','revoked'})
            return {'kind':'support_consent','actor_id':p['actor_id'],'scopes':p['scopes'],
                'expires_at':timestamp(p['expires_at']),'state':p['state']}
        if topic==PRIVACY:
            fields={'owner_id','kind','key','binding','created_at','expires_at','legal_approval'}
            require(fields|{'receipt_hash','state'}<=set(p) and
                set(p)<=fields|{'receipt_hash','state','result','result_hash'})
            require(p['kind'] in {'export','delete'} and type(p['key']) is str and 1<=len(p['key'])<=100)
            require(p['binding']==digest({key:p[key] for key in ('owner_id','kind','key')}) and
                p['receipt_hash']==digest({key:p[key] for key in fields}) and p['legal_approval'] is False)
            require(p['state'] in {'retention_review_required','cancelled','synthetic_drill_complete','synthetic_sql_complete'})
            return {'kind':'privacy_request','request_kind':p['kind'],'state':p['state'],
                'created_at':timestamp(p['created_at']),'expires_at':timestamp(p['expires_at']),
                'legal_approval':False,'result_withheld':True}
        if topic==MONITOR:
            report=MonitorDispatch._report(subject,p.get('report'))
            # Existing typed resolver verifies content hash and deterministic ID;
            # it performs no dispatch, sink call, policy activation or commit.
            row=MonitorDispatch(self.db)._row(subject,identifier)
            require(row.payload==p and p.get('state') in {'queued','dispatching','uncertain',
                'recorded','acknowledged','escalated'})
            return {'kind':'local_monitor_delivery','report':report,'state':p['state'],
                'created_at':timestamp(p['created_at']),'external_delivery':False}
        raise BoundaryDenied('PUBLIC_ACCOUNT_TOPIC_UNSUPPORTED')

    def export(self,subject):
        owner(self.db,subject,verified=True)
        dialect=self.db.get_bind().dialect.name
        if dialect=='postgresql' and self.db.connection().get_isolation_level() not in {'REPEATABLE READ','SERIALIZABLE'}:
            raise BoundaryDenied('ACCOUNT_SNAPSHOT_ISOLATION_REQUIRED')
        if dialect not in {'sqlite','postgresql'}:raise BoundaryDenied('ACCOUNT_DATABASE_UNSUPPORTED')
        size=func.octet_length(cast(OutboxMessage.payload,Text)) if dialect=='postgresql' else func.length(cast(OutboxMessage.payload,LargeBinary))
        statement=select(OutboxMessage.id,OutboxMessage.topic,
            case((size>65536,None),else_=cast(OutboxMessage.payload,Text))).where(
                or_((OutboxMessage.topic.in_(TOPICS-USER_TOPICS)) & (OutboxMessage.payload['owner_id'].as_integer()==subject),
                    (OutboxMessage.topic.in_(USER_TOPICS)) & (OutboxMessage.payload['user_id'].as_integer()==subject)))
        items=[]
        with self.db.execute(statement.order_by(OutboxMessage.id).limit(1001)
                .execution_options(stream_results=True,yield_per=1)).yield_per(1) as rows:
            for identifier,topic,raw in rows:
                require(raw is not None and len(items)<1000)
                p=_json_value(raw,65536)
                try:data=self.project(topic,p,subject,identifier)
                except (TypeError,KeyError,ValueError,AttributeError,ModuleLifecycleDenied):
                    raise BoundaryDenied('PUBLIC_ACCOUNT_EVIDENCE_INVALID') from None
                items.append({'id':str(identifier),'topic':topic,'data':data})
                require(len(_encode(items))<=8*1024*1024)
        return {'owner_id':subject,'items':items,'covered_topics':sorted(TOPICS),
            'complete_account_export':False,'complete_account_erasure':False,'raw_payload_dump':False}
