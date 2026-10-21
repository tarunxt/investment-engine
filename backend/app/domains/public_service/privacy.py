"""Owner-fenced privacy requests in the existing outbox; no generic data eraser.

Real retention/legal approval is unresolved. Runtime records requests and holds
all deletion effects. Only the explicit synthetic adapter can run drill effects.
"""
from datetime import datetime,timezone,timedelta
from uuid import UUID
from sqlalchemy import select
from app.domains.auth.models import User,ActivityLog
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.ai_limits.contracts import BoundaryDenied,digest,utc

TOPIC='public_service.privacy.v1'


class SyntheticPrivacyStore:
    def __init__(self,records):
        self.records=records;self.effects={}
    def apply(self,owner,kind,key):
        if key in self.effects:return self.effects[key]
        record=self.records.get(owner,{})
        # Test-only owned synthetic data, never files, credentials or adapters.
        if record.get('synthetic') is not True:raise BoundaryDenied('SYNTHETIC_DATA_REQUIRED')
        result={'owner_id':owner,'synthetic':True,'kind':kind}
        if kind=='export':result['profile']={k:record.get(k) for k in ('display_name','country')}
        else:self.records[owner]={'synthetic':True,'deleted':True}
        self.effects[key]=result;return result


class PrivacyRequests:
    def __init__(self,db):self.db=db
    def fence(self,owner):
        user=self.db.scalar(select(User).where(User.id==owner).with_for_update().execution_options(populate_existing=True))
        if user is None or not user.is_active:raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
        return user
    def owned(self,owner,id,lock=False):
        try:id=UUID(str(id))
        except (ValueError,TypeError):raise BoundaryDenied('OWNED_REQUEST_REQUIRED') from None
        q=select(OutboxMessage).where(OutboxMessage.id==id,OutboxMessage.topic==TOPIC)
        if lock:q=q.with_for_update()
        row=self.db.scalar(q.execution_options(populate_existing=True))
        if row is None or row.payload.get('owner_id')!=owner:raise BoundaryDenied('OWNED_REQUEST_REQUIRED')
        return row
    def request(self,owner,key,kind,*,confirmed,now=None):
        now=utc(now or datetime.now(timezone.utc));self.fence(owner)
        if kind not in {'export','delete'} or confirmed is not True or not isinstance(key,str) or not 1<=len(key)<=100:raise BoundaryDenied('EXACT_PRIVACY_REQUEST_REQUIRED')
        bound={'owner_id':owner,'kind':kind,'key':key};seal=digest(bound)
        old=self.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC,OutboxMessage.payload['owner_id'].as_integer()==owner,OutboxMessage.payload['key'].as_string()==key).with_for_update())
        if old:
            if old.payload.get('binding')!=seal:raise BoundaryDenied('PRIVACY_REPLAY_CONFLICT')
            return old
        row=OutboxMessage(topic=TOPIC,payload={**bound,'binding':seal,'state':'retention_review_required','created_at':now.isoformat(),'expires_at':(now+timedelta(days=7)).isoformat(),'legal_approval':False})
        row.payload={**row.payload,'receipt_hash':digest({k:v for k,v in row.payload.items() if k!='state'})}
        self.db.add(row);self.db.flush();self.db.add(ActivityLog(user_id=owner,action='privacy_requested',resource_type=kind,details=str(row.id)));return row
    def cancel(self,owner,id):
        self.fence(owner);row=self.owned(owner,id,True)
        if row.payload['state']=='retention_review_required':row.payload={**row.payload,'state':'cancelled'}
        return row
    def drill(self,owner,id,*,store,now=None):
        self.fence(owner);row=self.owned(owner,id,True);p=row.payload
        if digest({k:v for k,v in p.items() if k not in {'state','result','receipt_hash'}})!=p.get('receipt_hash') or digest({k:p[k] for k in ('owner_id','kind','key')})!=p.get('binding'):raise BoundaryDenied('PRIVACY_BINDING_CHANGED')
        if p['state']!='retention_review_required':raise BoundaryDenied('PRIVACY_NOT_PENDING')
        if utc(datetime.fromisoformat(p['expires_at']))<=utc(now or datetime.now(timezone.utc)):raise BoundaryDenied('PRIVACY_REQUEST_EXPIRED')
        from .account_data import SyntheticAccountDataAdapter
        if type(store)is SyntheticAccountDataAdapter:
            if store.db is not self.db:raise BoundaryDenied('SAME_PRIVACY_TRANSACTION_REQUIRED')
            result=store.apply(owner,p['kind'],str(row.id),now=now)
        elif type(store)is SyntheticPrivacyStore:result=store.apply(owner,p['kind'],str(row.id))
        else:raise BoundaryDenied('RETENTION_APPROVAL_AND_REAL_ADAPTER_UNAVAILABLE')
        row.payload={**p,'state':'synthetic_drill_complete','result':result,'result_hash':digest(result)}
        self.db.add(ActivityLog(user_id=owner,action='privacy_synthetic_drill',details=str(row.id)));return result


    def export(self,owner,id,*,now=None):
        self.fence(owner);row=self.owned(owner,id,True);p=row.payload
        if digest({k:v for k,v in p.items() if k not in {'state','result','result_hash','receipt_hash'}})!=p.get('receipt_hash'):raise BoundaryDenied('PRIVACY_BINDING_CHANGED')
        result=p.get('result')
        if p['state']!='synthetic_drill_complete' or p['kind']!='export' or utc(datetime.fromisoformat(p['expires_at']))<=utc(now or datetime.now(timezone.utc)) or not isinstance(result,dict) or result.get('owner_id')!=owner or result.get('synthetic')is not True or digest(result)!=p.get('result_hash'):raise BoundaryDenied('OWNED_EXPORT_UNAVAILABLE')
        return result


def public_receipt(row):
    return {'id':str(row.id),**{k:row.payload[k] for k in ('owner_id','kind','state','created_at','expires_at')},'legal_approval':False,'notice':'Request recorded; real export/deletion remains held for retention review and separately approved adapters.'}
