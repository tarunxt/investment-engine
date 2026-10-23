"""Reviewed-evidence producer contract. Only explicit synthetic composition exists.

The public declaration route cannot manufacture this producer or mark real
eligibility. No normal-runtime producer is registered or inferred from IP/email.
"""
from dataclasses import dataclass
from datetime import datetime,timezone,timedelta
from sqlalchemy import select
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.ai_limits.contracts import BoundaryDenied,digest,utc
from app.domains.connections.crypto import ConnectionKeyring,ConnectionFault
from app.domains.modules.policy import ModuleFacts
from .store import owner
TOPIC='public_service.residency.synthetic.v1'

class SyntheticResidencyProducer:
    def __init__(self,keyring):
        if type(keyring)is not ConnectionKeyring:raise BoundaryDenied('SYNTHETIC_REVIEW_KEYRING_REQUIRED')
        self.keyring=keyring
    def record(self,db,owner_id,*,country,evidence_reference,reviewer,now,expires):
        now=utc(now);expires=utc(expires);owner(db,owner_id,verified=True)
        if country!='IN' or not evidence_reference.startswith('synthetic:') or not reviewer.startswith('synthetic:') or not now<expires<=now+timedelta(days=30):raise BoundaryDenied('REVIEWED_EVIDENCE_REQUIRED')
        p={'owner_id':owner_id,'country':'IN','source':'synthetic-review','reference_hash':digest(evidence_reference),'reviewer_hash':digest(reviewer),'issued_at':now.isoformat(),'expires_at':expires.isoformat(),'real_eligibility':False}
        ciphertext,version=self.keyring.seal(p);row=OutboxMessage(topic=TOPIC,payload={'owner_id':owner_id,'ciphertext':ciphertext,'key_version':version,'revoked':False});db.add(row);db.flush();return row
    def resolve(self,db,owner_id,*,now):
        owner(db,owner_id,verified=True);row=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC,OutboxMessage.payload['owner_id'].as_integer()==owner_id).order_by(OutboxMessage.created_at.desc(),OutboxMessage.id.desc()).limit(1))
        if row is None or row.payload.get('revoked')is not False:raise BoundaryDenied('REVIEWED_RESIDENCY_UNAVAILABLE')
        try:p=self.keyring.open(row.payload['ciphertext'],row.payload['key_version'])
        except (ConnectionFault,KeyError):raise BoundaryDenied('REVIEWED_RESIDENCY_UNAVAILABLE') from None
        if set(p)!={'owner_id','country','source','reference_hash','reviewer_hash','issued_at','expires_at','real_eligibility'} or p['owner_id']!=owner_id or p['country']!='IN' or p['source']!='synthetic-review' or p['real_eligibility']is not False or not utc(datetime.fromisoformat(p['issued_at']))<=utc(now)<utc(datetime.fromisoformat(p['expires_at'])):raise BoundaryDenied('REVIEWED_RESIDENCY_BINDING')
        return {'synthetic_entitled':True,'real_eligible':False,'evidence_id':str(row.id)}
    def revoke(self,db,owner_id,id):
        owner(db,owner_id,verified=True);row=db.scalar(select(OutboxMessage).where(OutboxMessage.id==id,OutboxMessage.topic==TOPIC).with_for_update())
        if row is None or row.payload.get('owner_id')!=owner_id:raise BoundaryDenied('OWNED_REVIEW_REQUIRED')
        row.payload={**row.payload,'revoked':True}

def reviewed_facts(db,owner_id,facts,*,producer=None,simulation=False,now=None):
    if simulation is not True or type(producer)is not SyntheticResidencyProducer:raise BoundaryDenied('REVIEWED_REAL_PRODUCER_UNAVAILABLE')
    if type(facts)is not ModuleFacts:raise BoundaryDenied('SERVER_FACTS_REQUIRED')
    producer.resolve(db,owner_id,now=now or datetime.now(timezone.utc))
    return facts.model_copy(update={'jurisdiction':'allowed'})
