"""Private local effects in the existing outbox, with policy at every boundary.

No remote Sheets/mail/storage adapter is installed. Content is owned, bounded
JSON/text in a private database receipt; URLs, OAuth grants and arbitrary paths
are never delivery destinations. Replay of an uncertain dispatch cannot resend.
"""
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from uuid import UUID
from sqlalchemy import select
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.modules.lifecycle import WorkIdentity
from .contracts import BoundaryDenied, digest, utc
from .untrusted import safe_text

TOPIC='analysis.private.effect.v1'
SAFETY=frozenset({'password_reset','stage2_position_warning'})


@dataclass(frozen=True)
class Destination:
    """Resolved from server-owned preferences, never from model output."""
    owner_id:int
    module_id:str
    key:str
    kind:str='local_sink'


class LocalSink:
    """Explicit no-network fixture. No environment-driven real fallback."""
    def __init__(self):self.receipts={}
    def deliver(self, key, payload):
        self.receipts.setdefault(key,digest(payload))
        return self.receipts[key]


class PrivateEffects:
    def __init__(self, db, policy, *, sink=None, preferences=lambda db,identity,kind:False):
        self.db,self.policy,self.sink,self.preferences=db,policy,sink,preferences

    def owned(self, owner, id, *, lock=False):
        try:id=UUID(str(id))
        except (ValueError,TypeError):raise BoundaryDenied('OWNED_ARTIFACT_REQUIRED') from None
        q=select(OutboxMessage).where(OutboxMessage.id==id,OutboxMessage.topic==TOPIC)
        if lock:q=q.with_for_update()
        row=self.db.scalar(q.execution_options(populate_existing=True))
        if row is None or row.payload.get('owner_id')!=owner:raise BoundaryDenied('OWNED_ARTIFACT_REQUIRED')
        return row

    def identity(self,p):return WorkIdentity(p['owner_id'],p['module_id'],p['module_version'])

    def fenced(self,owner,id):
        row=self.owned(owner,id);identity=self.identity(row.payload)
        self.policy(self.db,identity) # same owner -> resource lock order as enqueue
        row=self.owned(owner,id,lock=True)
        if self.identity(row.payload)!=identity:raise BoundaryDenied('ARTIFACT_BINDING_CHANGED')
        p=row.payload
        bound=digest({k:v for k,v in p.items() if k not in {'state','expires_at','request_hash','sink_receipt','receipt_hash'}})
        seal=digest({k:v for k,v in p.items() if k not in {'state','sink_receipt','receipt_hash'}})
        if bound!=p.get('request_hash') or seal!=p.get('receipt_hash') or digest(p['content'])!=p['content_hash']:
            raise BoundaryDenied('ARTIFACT_INTEGRITY')
        return row

    def enqueue(self, identity, key, content, *, destination, kind='export', preference=True, now=None):
        now=utc(now or datetime.now(timezone.utc))
        if not isinstance(destination,Destination) or destination.owner_id!=identity.owner_id or destination.module_id!=identity.module_id or destination.kind!='local_sink' or not destination.key.startswith('local:') or len(destination.key)>128:
            raise BoundaryDenied('DESTINATION_SCOPE')
        if kind not in {'export','notification'} or type(preference)is not bool or not preference:
            raise BoundaryDenied('ORDINARY_EFFECT_DISABLED')
        if not isinstance(key,str) or not 1<=len(key)<=128:raise BoundaryDenied('IDEMPOTENCY_KEY')
        self.policy(self.db,identity)
        if self.preferences(self.db,identity,kind) is not True:
            raise BoundaryDenied('ORDINARY_EFFECT_DISABLED')
        # JSON removes spreadsheet-formula execution and executable HTML. Any
        # future CSV exporter needs its own formula escaping, not this receipt.
        content_hash=digest(content)
        p={'schema_version':1,'owner_id':identity.owner_id,'module_id':identity.module_id,'module_version':identity.version,
           'request_key':key,'kind':kind,'destination':destination.key,'content':content,'content_hash':content_hash,
           'state':'queued','expires_at':(now+timedelta(hours=24)).isoformat(),'preference':True}
        bound=digest({k:v for k,v in p.items() if k not in {'state','expires_at'}})
        # The existing owner selection fence serializes idempotency with disable.
        old=self.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC,OutboxMessage.payload['owner_id'].as_integer()==identity.owner_id,OutboxMessage.payload['request_key'].as_string()==key).with_for_update())
        if old:
            if old.payload.get('request_hash')!=bound:raise BoundaryDenied('IDEMPOTENCY_CONFLICT')
            return old
        immutable={**p,'request_hash':bound}
        row=OutboxMessage(topic=TOPIC,payload={**immutable,'receipt_hash':digest({k:v for k,v in immutable.items() if k!='state'})})
        self.db.add(row);self.db.flush();return row

    def dispatch(self, owner, id, *, preference=True, now=None):
        # Caller owns the current module fence across the sink call. The
        # supported default policy below takes that same existing SQL lock.
        row=self.owned(owner,id);p=dict(row.payload)
        if p['state']!='queued':return p['state']
        try:
            row=self.fenced(owner,id);p=dict(row.payload)
            if p['state']!='queued':return p['state']
            if self.preferences(self.db,self.identity(p),p['kind']) is not True or not preference or not p['preference'] or utc(datetime.fromisoformat(p['expires_at']))<=utc(now or datetime.now(timezone.utc)):
                raise BoundaryDenied('ORDINARY_EFFECT_DISABLED_OR_EXPIRED')
        except PermissionError:
            row.payload={**p,'state':'cancelled'};self.db.commit();return 'cancelled'
        except BoundaryDenied:
            row.payload={**p,'state':'cancelled'};self.db.commit();return 'cancelled'
        if type(self.sink) is not LocalSink:raise BoundaryDenied('LOCAL_SINK_REQUIRED')
        # Local sink is deterministic/idempotent by immutable outbox ID and
        # cannot make a real send. Transaction rollback permits the same key.
        result=self.sink.deliver(str(row.id),p['content'])
        row.payload={**p,'state':'ready','sink_receipt':result};row.execution_attempts+=1
        self.db.commit();return 'ready'

    def download(self, owner, id, *, now=None):
        row=self.fenced(owner,id);p=row.payload
        if p['state']!='ready' or p['kind']!='export' or utc(datetime.fromisoformat(p['expires_at']))<=utc(now or datetime.now(timezone.utc)):
            raise BoundaryDenied('ARTIFACT_UNAVAILABLE')
        if digest(p['content'])!=p['content_hash']:raise BoundaryDenied('ARTIFACT_INTEGRITY')
        return {'content':p['content'],'content_type':'application/json','cache_control':'no-store','content_disposition':'attachment; filename="analysis.json"'}

    def cancel(self, owner, id):
        row=self.owned(owner,id,lock=True)
        row.payload={**row.payload,'state':'cancelled'};self.db.commit()


def current_policy(db,identity):
    """Default server policy; synthetic tests explicitly inject their facts."""
    from app.domains.modules.lifecycle import sync_owner_fence,current_sync
    sync_owner_fence(db,identity.owner_id)
    return current_sync(db,identity,capability='view')


def notification_allowed(kind, *, module_enabled, preference):
    # Class is determined by the server callsite, never model/browser labels.
    return kind in SAFETY or bool(module_enabled and preference)
