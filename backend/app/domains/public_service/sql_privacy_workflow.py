"""Executable SQL privacy workflow for explicitly disposable synthetic databases.

No runtime route/activation, no production deletion capability. The existing
request, owner fence, inventory, encrypted plan and retention policy arbitrate.
Identity/audit/outbox anchors and external/backup erasure remain held explicitly.
"""
from dataclasses import dataclass,asdict
from datetime import datetime, timezone
from pathlib import Path
import os,re,tempfile
from uuid import UUID,uuid5,NAMESPACE_URL
from sqlalchemy import select,delete,update,func,exists,and_
from app.domains.ai_limits.contracts import BoundaryDenied,digest,utc
from app.domains.auth.models import User,ActivityLog
from app.domains.connections.crypto import ConnectionKeyring,ConnectionFault
from app.infrastructure.database.outbox.models import OutboxMessage
from .privacy import PrivacyRequests
from .privacy_relations import relationships,relationship_hash
from .sql_account import SQLAccountReader
from .sql_privacy_plan import SQLPrivacyPlanner,RetentionSchedule,ANCHORS

TOPIC='public_service.privacy.sql_fixture_effect.v1'

@dataclass(frozen=True)
class DisposablePrivacyScope:
    reference:str=''
    def validate(self,db):
        if os.getenv('ENVIRONMENT')!='test' or type(self.reference)is not str or not self.reference.startswith('synthetic:') or not 12<=len(self.reference)<=120:
            raise BoundaryDenied('DISPOSABLE_PRIVACY_SCOPE_REQUIRED')
        url=db.get_bind().url
        if url.get_backend_name()=='sqlite':
            if not url.database or url.database==':memory:':raise BoundaryDenied('DISPOSABLE_PRIVACY_SCOPE_REQUIRED')
            path=Path(url.database).resolve();root=Path(tempfile.gettempdir()).resolve()
            if root not in path.parents or not any(re.fullmatch(r'pytest-of-[^/]+',part) for part in path.parts):
                raise BoundaryDenied('DISPOSABLE_PRIVACY_SCOPE_REQUIRED')
            database_scope=str(path)
        elif url.get_backend_name()=='postgresql':
            if (not Path('/.dockerenv').is_file() or os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only'
                or (url.host,url.port or 5432,url.username,url.database)!=('postgres',5432,'stage09','credx_stage09_test')):
                raise BoundaryDenied('DISPOSABLE_PRIVACY_SCOPE_REQUIRED')
            schema=db.scalar(select(func.current_schema()))
            if not re.fullmatch(r'stage(?:09|17_privacy)_[0-9a-f]{32}',schema or ''):
                raise BoundaryDenied('DISPOSABLE_PRIVACY_SCOPE_REQUIRED')
            database_scope='credx_stage09_test:'+schema
        else:raise BoundaryDenied('DISPOSABLE_PRIVACY_SCOPE_REQUIRED')
        return digest({'reference':self.reference,'backend':url.get_backend_name(),'database_scope':database_scope})

class DisposableSQLPrivacyWorkflow:
    def __init__(self,db,reader,keyring,*,retention=None,scope=None):
        if type(reader)is not SQLAccountReader or reader.db is not db or type(keyring)is not ConnectionKeyring:
            raise BoundaryDenied('SAME_PRIVACY_TRANSACTION_REQUIRED')
        self.db,self.reader,self.keyring=db,reader,keyring
        self.retention=retention;self.scope=scope
    def _fence(self,owner,key,now):
        if type(owner)is not int or owner<=0:raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
        if type(self.scope)is not DisposablePrivacyScope:raise BoundaryDenied('DISPOSABLE_PRIVACY_SCOPE_REQUIRED')
        binding=self.scope.validate(self.db)
        if self.db.get_bind().dialect.name=='sqlite':
            # A no-op writer fence must also suppress SQLAlchemy onupdate
            # defaults, otherwise it changes the reviewed user snapshot.
            unchanged={User.__table__.c.id:User.__table__.c.id}
            unchanged.update({column:column for column in User.__table__.columns if column.onupdate is not None})
            self.db.execute(update(User).where(User.id==owner).values(unchanged))
        service=PrivacyRequests(self.db);person=service.fence(owner)
        if not person.is_verified:raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
        row=service.owned(owner,key,True);p=row.payload
        if (digest({k:v for k,v in p.items() if k not in {'state','result','result_hash','receipt_hash'}})!=p.get('receipt_hash')
            or digest({k:p[k] for k in ('owner_id','kind','key')})!=p.get('binding')):
            raise BoundaryDenied('PRIVACY_BINDING_CHANGED')
        if not utc(datetime.fromisoformat(p['created_at']))<=now<utc(datetime.fromisoformat(p['expires_at'])):
            raise BoundaryDenied('PRIVACY_REQUEST_EXPIRED')
        if p.get('state')=='cancelled':raise BoundaryDenied('PRIVACY_REQUEST_CANCELLED')
        return row,binding
    def _claims(self,row,owner,binding):
        try:claims=self.keyring.open(row.payload['ciphertext'],row.payload['key_version'])
        except (ConnectionFault,KeyError,TypeError):raise BoundaryDenied('PRIVACY_SQL_RECEIPT_INVALID') from None
        if (row.topic!=TOPIC or row.payload.get('owner_id')!=owner or claims.get('owner_id')!=owner
            or claims.get('scope_hash')!=binding or digest(claims)!=row.payload.get('claims_hash')):
            raise BoundaryDenied('PRIVACY_SQL_RECEIPT_INVALID')
        return claims
    def execute(self,owner,request_id,*,now=None):
        now=utc(now or datetime.now(timezone.utc));request,binding=self._fence(owner,request_id,now)
        key=uuid5(NAMESPACE_URL,'credx:disposable-sql-privacy:'+str(request.id));p=dict(request.payload)
        old=self.db.scalar(select(OutboxMessage).where(OutboxMessage.id==key).with_for_update())
        if old is not None:
            result=self._claims(old,owner,binding)
            if (result.get('request_hash')!=p['receipt_hash'] or result.get('kind')!=p['kind']
                or result.get('request_id')!=str(request.id) or p.get('result_hash')!=digest(result)
                or p.get('result',{}).get('receipt_id')!=str(key)):
                raise BoundaryDenied('PRIVACY_SQL_RECEIPT_INVALID')
            if p.get('state')!='synthetic_sql_complete':raise BoundaryDenied('PRIVACY_SQL_RECEIPT_INVALID')
            return result
        if p.get('state')!='retention_review_required':raise BoundaryDenied('PRIVACY_NOT_PENDING')
        # Savepoint makes data/effect/request/audit atomic even if a caller
        # catches an error and attempts to commit the surrounding transaction.
        with self.db.begin_nested():
            reviewed_edges=relationships(self.reader.metadata)
            if p['kind']=='export':
                if type(self.retention)is not RetentionSchedule:raise BoundaryDenied('COMPLETE_RETENTION_REVIEW_REQUIRED')
                retention_hash=self.retention.fingerprint(set(self.reader.metadata.tables),now)
                content=self.reader.export(owner);result={'datasets':content['datasets'],'snapshot_hash':content['content_hash'],
                    'row_counts':{name:len(rows) for name,rows in content['datasets'].items()},
                    'declared_inventory_complete':True,'complete_account_export':False,'excluded_tables':content['excluded_tables'],'inventory_hash':self.reader.inventory.schema_digest,
                    'inventory_policy_hash':digest(asdict(self.reader.inventory)),'retention_hash':retention_hash,
                    'relationship_hash':relationship_hash(reviewed_edges)}
            elif p['kind']=='delete':
                if self.db.get_bind().dialect.name=='postgresql' and self.db.connection().get_isolation_level()!='SERIALIZABLE':
                    raise BoundaryDenied('PRIVACY_SQL_SERIALIZABLE_REQUIRED')
                planner=SQLPrivacyPlanner(self.db,self.reader,self.keyring,self.retention)
                planner.draft(owner,request.id,now=now);plan=planner.inspect(owner,request.id,now=now)
                if plan['blocked_relationships']:raise BoundaryDenied('PRIVACY_SQL_RELATIONSHIP_CYCLE')
                edges=relationships(self.reader.metadata)
                if plan['relationship_hash']!=relationship_hash(edges):raise BoundaryDenied('PRIVACY_SQL_PLAN_INVALID')
                removed={};rules={rule.table:rule for rule in self.reader.inventory.rules}
                for name in plan['child_first_order']:
                    if name in ANCHORS or rules[name].excluded_reason or plan['actions'][name]['disposition']!='DELETE_CANDIDATE':
                        raise BoundaryDenied('PRIVACY_SQL_PLAN_INVALID')
                    table=self.reader.metadata.tables[name];predicate=self.reader._predicate(table,rules[name],owner)
                    # Lock reviewed targets, then reject any dependent row left
                    # after child-first deletion. A foreign/mixed child must not
                    # disappear through FK CASCADE or SET NULL. PostgreSQL
                    # serializable isolation also fences concurrent phantoms;
                    # SQLite already owns its writer fence for this transaction.
                    locked=self.db.execute(select(*table.primary_key.columns).where(predicate)
                        .limit(self.reader.MAX_ROWS_PER_TABLE+1).with_for_update()).all()
                    if len(locked)!=plan['actions'][name]['owned_rows']:raise BoundaryDenied('PRIVACY_SQL_SNAPSHOT_CHANGED')
                    for edge in edges:
                        if edge.parent!=name:continue
                        child=self.reader.metadata.tables[edge.child]
                        referenced=exists(select(1).select_from(table).where(predicate,
                            and_(*(child.c[local]==table.c[parent] for local,parent in zip(edge.child_columns,edge.parent_columns)))))
                        if self.db.execute(select(1).select_from(child).where(referenced).limit(1)).first() is not None:
                            raise BoundaryDenied('PRIVACY_SQL_RETAINED_DEPENDENT')
                    count=self.db.execute(delete(table).where(predicate)).rowcount
                    if count!=plan['actions'][name]['owned_rows']:raise BoundaryDenied('PRIVACY_SQL_SNAPSHOT_CHANGED')
                    removed[name]=count
                result={'removed_counts':removed,'retained':{name:value for name,value in plan['actions'].items() if value['disposition']!='DELETE_CANDIDATE'},
                    'before_snapshot_hash':plan['account_hash'],'inventory_hash':plan['inventory_hash'],
                    'inventory_policy_hash':plan['inventory_policy_hash'],'retention_hash':plan['retention_hash'],
                    'relationship_hash':plan['relationship_hash'],
                    'identity_erased':False,'backup_erased':False,'complete_account_erasure':False,'status':'partial_retained',
                    'unfinished':plan['unfinished']}
            else:raise BoundaryDenied('PRIVACY_KIND_INVALID')
            claims={**result,'owner_id':owner,'request_id':str(request.id),'request_hash':p['receipt_hash'],'kind':p['kind'],
                'scope_hash':binding,'synthetic':True,'legal_approval':False,'runtime_binding':False,'completed_at':now.isoformat()}
            ciphertext,version=self.keyring.seal(claims)
            row=OutboxMessage(id=key,topic=TOPIC,payload={'owner_id':owner,'ciphertext':ciphertext,'key_version':version,'claims_hash':digest(claims)})
            self.db.add(row);request.payload={**p,'state':'synthetic_sql_complete','result':{'receipt_id':str(key)},'result_hash':digest(claims)}
            self.db.add(ActivityLog(user_id=owner,action='privacy_sql_fixture_complete',resource_type=p['kind'],details=str(request.id)))
            self.db.flush()
        return claims  # caller commits the shared account/request transaction
    def result(self,owner,request_id,*,now=None):
        now=utc(now or datetime.now(timezone.utc));request,binding=self._fence(owner,request_id,now)
        if request.payload.get('state')!='synthetic_sql_complete':raise BoundaryDenied('OWNED_EXPORT_UNAVAILABLE')
        key=uuid5(NAMESPACE_URL,'credx:disposable-sql-privacy:'+str(request.id))
        row=self.db.scalar(select(OutboxMessage).where(OutboxMessage.id==key,OutboxMessage.topic==TOPIC).with_for_update())
        if row is None:raise BoundaryDenied('OWNED_EXPORT_UNAVAILABLE')
        claims=self._claims(row,owner,binding)
        if (claims.get('request_hash')!=request.payload['receipt_hash'] or digest(claims)!=request.payload.get('result_hash')
            or claims.get('request_id')!=str(request.id) or request.payload.get('result',{}).get('receipt_id')!=str(key)):
            raise BoundaryDenied('PRIVACY_SQL_RECEIPT_INVALID')
        return claims
