"""Durable FULL declared synthetic account inventory; no real-data binding.

Every current module plus core datasets must be classified, even when empty.
Unknown categories/ownership fail closed. Normal runtime cannot seed or enable
this fixture adapter through an HTTP/environment flag.
"""
from dataclasses import dataclass,field
from datetime import datetime,timezone
from copy import deepcopy
from uuid import uuid5,NAMESPACE_URL
from sqlalchemy import select
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.modules.registry import REGISTRY
from app.domains.ai_limits.contracts import BoundaryDenied,digest,utc
from .store import owner
from .redaction import _sensitive
TOPIC='public_service.synthetic_account.v1'
DATASETS=frozenset({'profile','preferences','connections','activity','private_artifacts'}|{m.value for m in REGISTRY})
FORBIDDEN={'ciphertext','credentials','passwordhash','keyhash','tokenhash','sessionid','credentialmaterial'}

@dataclass(frozen=True)
class SyntheticRetentionReview:
    reference:str
    reviewed:bool=False
    holds:frozenset=field(default_factory=frozenset)
    retain_until:dict=field(default_factory=dict)
    def validate(self):
        if self.reviewed is not True or not self.reference.startswith('synthetic:') or not self.holds<=DATASETS or not set(self.retain_until)<=DATASETS:raise BoundaryDenied('RETENTION_REVIEW_REQUIRED')
        for t in self.retain_until.values():utc(t)
        return self

def filtered(value,depth=0):
    if depth>16:raise BoundaryDenied('ACCOUNT_EXPORT_DEPTH')
    if isinstance(value,dict):return {k:('[withheld credential]' if str(k).lower().replace('_','') in FORBIDDEN or _sensitive(k) else filtered(v,depth+1)) for k,v in value.items()}
    if isinstance(value,list):return [filtered(v,depth+1) for v in value]
    if value is None or isinstance(value,(str,bool,int,float)):return value
    raise BoundaryDenied('ACCOUNT_EXPORT_SCHEMA')

class SyntheticAccountDataAdapter:
    def __init__(self,db,review=None):self.db,self.review=db,review
    def owned(self,id):
        owner(self.db,id);row=self.db.scalar(select(OutboxMessage).where(OutboxMessage.id==uuid5(NAMESPACE_URL,'credx:synthetic-account:'+str(id)),OutboxMessage.topic==TOPIC).with_for_update().execution_options(populate_existing=True))
        if row is None or row.payload.get('owner_id')!=id or row.payload.get('synthetic')is not True or row.payload.get('schema')!=1:raise BoundaryDenied('SYNTHETIC_ACCOUNT_REQUIRED')
        data=row.payload.get('datasets')
        if not isinstance(data,dict) or set(data)!=DATASETS:raise BoundaryDenied('FULL_ACCOUNT_INVENTORY_REQUIRED')
        for rows in data.values():
            if not isinstance(rows,list) or len(rows)>1000 or any(not isinstance(r,dict) or r.get('owner_id')!=id for r in rows):raise BoundaryDenied('ACCOUNT_DATA_OWNER_MISMATCH')
        digest(data);return row
    def seed(self,id,datasets):
        owner(self.db,id)
        if set(datasets)!=DATASETS:raise BoundaryDenied('FULL_ACCOUNT_INVENTORY_REQUIRED')
        key=uuid5(NAMESPACE_URL,'credx:synthetic-account:'+str(id))
        old=self.db.get(OutboxMessage,key)
        if old is not None:raise BoundaryDenied('SYNTHETIC_ACCOUNT_ALREADY_SEEDED')
        row=OutboxMessage(id=key,topic=TOPIC,payload={'owner_id':id,'schema':1,'synthetic':True,'datasets':deepcopy(datasets),'version':1})
        self.db.add(row);self.db.flush();self.owned(id);return row
    def apply(self,id,kind,key,*,now=None):
        now=utc(now or datetime.now(timezone.utc));row=self.owned(id)
        if type(self.review)is not SyntheticRetentionReview:raise BoundaryDenied('RETENTION_REVIEW_REQUIRED')
        self.review.validate();data=deepcopy(row.payload['datasets']);before=digest(data)
        if kind=='export':return {'owner_id':id,'synthetic':True,'real_legal_approval':False,'kind':'export','schema_version':1,'inventory_complete_for_declared_schema':True,'datasets':filtered(data),'row_counts':{k:len(v) for k,v in data.items()},'snapshot_hash':before}
        if kind!='delete':raise BoundaryDenied('PRIVACY_KIND_INVALID')
        held={k for k in DATASETS if k in self.review.holds or (k in self.review.retain_until and now<utc(self.review.retain_until[k]))}
        removed={k:len(v) for k,v in data.items() if k not in held}
        for category in DATASETS-held:data[category]=[]
        row.payload={**row.payload,'datasets':data,'version':row.payload['version']+1,'last_request':key}
        self.db.flush()
        return {'owner_id':id,'synthetic':True,'real_legal_approval':False,'kind':'delete','removed_counts':removed,'held_counts':{k:len(data[k]) for k in held},'before_hash':before,'after_hash':digest(data)}
