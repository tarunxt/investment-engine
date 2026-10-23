"""Durable synthetic order state; persisted approval never grants real I/O.

Owner selection -> connection -> intent locks establish the dispatch/revocation
boundary. A committed submitting leg is never blindly retried, even if a process
crashes before the fake call. Stage15 reconciliation is deliberately separate.
"""
from copy import deepcopy
from datetime import datetime,timezone,timedelta
from uuid import uuid4,UUID
from sqlalchemy import select
from app.domains.auth.models import User
from app.domains.connections.models import IntegrationConnection
from app.domains.modules.models import UserModulePreferences
from app.domains.modules.lifecycle import WorkIdentity,current_sync
from app.infrastructure.database.outbox.models import OutboxMessage
from .models import OrderIntent,OrderLeg
from .contracts import OrderDenied,payload,digest,utc,stored_utc,receipt as validate_receipt
from .fake import FakeBroker

TOPIC='orders.confirmed.synthetic.v1'
MODULE='zerodha_rebalance'
TTL=timedelta(minutes=5)

def current_policy(db,identity):
    current_sync(db,identity,capability='execute',boundary='side_effect')

def unavailable_risk(*args):raise OrderDenied('REVIEWED_RISK_PROVIDER_UNAVAILABLE')

class Orders:
    def __init__(self,db,*,policy=current_policy,risk=unavailable_risk,clock=lambda:datetime.now(timezone.utc),provenance=None):
        self.db,self.policy,self.risk,self.clock=db,policy,risk,clock
        self.provenance=provenance

    def fence(self,identity):
        if type(identity.owner_id)is not int or identity.module_id!=MODULE or type(identity.version)is not int or identity.version<1:raise OrderDenied('INVALID_IDENTITY')
        user=self.db.scalar(select(User).where(User.id==identity.owner_id).with_for_update().execution_options(populate_existing=True))
        if user is None or not user.is_active:raise OrderDenied('ACTIVE_OWNER_REQUIRED')
        header=self.db.scalar(select(UserModulePreferences).where(UserModulePreferences.user_id==identity.owner_id).with_for_update().execution_options(populate_existing=True))
        if header is None:raise OrderDenied('MODULE_SELECTION_REQUIRED')
        self.policy(self.db,identity)

    def connection(self,owner,id,now):
        row=self.db.scalar(select(IntegrationConnection).where(IntegrationConnection.id==id,IntegrationConnection.owner_id==owner).with_for_update().execution_options(populate_existing=True))
        if row is None or row.provider!='zerodha' or row.status!='active' or not row.is_current or not row.provider_account_id or row.token_expires_at is None or stored_utc(row.token_expires_at)<=now:raise OrderDenied('CURRENT_OWNED_CONNECTION_REQUIRED')
        return row

    def owned(self,owner,id,*,lock=True):
        q=select(OrderIntent).where(OrderIntent.id==id,OrderIntent.owner_id==owner)
        if lock:q=q.with_for_update()
        row=self.db.scalar(q.execution_options(populate_existing=True))
        if row is None:raise OrderDenied('OWNED_INTENT_REQUIRED')
        return row

    def identity(self,row):return WorkIdentity(row.owner_id,row.module_id,row.module_version)
    def bound(self,row):
        return {'owner_id':row.owner_id,'module_id':row.module_id,'module_version':row.module_version,'connection_id':row.connection_id,'connection_version':row.connection_version,'account_id':row.account_id,'app_mode':row.app_mode,'payload':row.payload_json}
    def legs(self,row):
        return list(self.db.scalars(select(OrderLeg).where(OrderLeg.intent_id==row.id).order_by(OrderLeg.position).with_for_update().execution_options(populate_existing=True)))

    def checked(self,owner,id,now):
        row=self.owned(owner,id,lock=False);identity=self.identity(row)
        original=(row.module_id,row.module_version,row.connection_id)
        # Reacquire in canonical order before trusting any frozen row.
        self.fence(identity);conn=self.connection(owner,row.connection_id,now);row=self.owned(owner,id)
        if original!=(row.module_id,row.module_version,row.connection_id):raise OrderDenied('INTENT_BINDING_CHANGED')
        if (conn.version,conn.provider_account_id,conn.app_ownership_mode)!=(row.connection_version,row.account_id,row.app_mode):raise OrderDenied('CONNECTION_BINDING_CHANGED')
        if payload(deepcopy(row.payload_json))!=row.payload_json or digest(self.bound(row))!=row.request_digest:raise OrderDenied('IMMUTABLE_INTENT_CHANGED')
        legs=self.legs(row)
        if len(legs)!=len(row.payload_json['legs']) or any(l.position!=i or l.payload_digest!=digest(p) or l.client_reference!=digest({'intent':row.id,'leg':i}) for i,(l,p) in enumerate(zip(legs,row.payload_json['legs']))):raise OrderDenied('BASKET_LEGS_CHANGED')
        proof=self.provenance(self.db,row,now) if self.provenance is not None else None
        # Every post-draft state requires its frozen review/risk evidence.
        # Missing evidence can never turn a mandatory check into an optional one.
        if row.state!='draft' or row.risk_json is not None or row.review_digest is not None:
            if not isinstance(row.risk_json,dict) or row.risk_json.get('allowed') is not True or not row.review_digest:raise OrderDenied('FROZEN_RISK_REVIEW_REQUIRED')
            actual=self.risk_for(row,conn,now,proof=proof)
            if not isinstance(actual,dict) or actual.get('allowed') is not True or digest(actual)!=digest(row.risk_json):raise OrderDenied('RISK_CONDITIONS_CHANGED')
            if digest({'request':row.request_digest,'risk':actual})!=row.review_digest:raise OrderDenied('REVIEW_BINDING_CHANGED')
        completed_ids=set()
        for leg,p in zip(legs,row.payload_json['legs']):
            if leg.state in {'filled','partial','acknowledged','rejected'}:
                evidence=leg.reconciliation_json
                if not isinstance(evidence,dict) or set(evidence)!={'simulation','receipt'} or evidence['simulation'] is not True:raise OrderDenied('STORED_FILL_EVIDENCE_REQUIRED')
                value=evidence['receipt']
                value=validate_receipt(value,p,leg.client_reference)
                if (value['state'],value['filled_quantity'],value['broker_order_id'])!=(leg.state,leg.filled_quantity,leg.broker_order_id):raise OrderDenied('STORED_FILL_RECEIPT_CHANGED')
                if leg.broker_order_id in completed_ids:raise OrderDenied('DUPLICATE_BROKER_ORDER_RECEIPT')
                completed_ids.add(leg.broker_order_id)
            elif leg.state in {'draft','submitting'} and (leg.broker_order_id is not None or leg.filled_quantity!=0 or leg.reconciliation_json is not None):raise OrderDenied('UNEXPECTED_FILL_EVIDENCE')
        return row,legs

    def risk_for(self,row,connection,now,*,proof=None):
        value=self.risk(self.db,self.identity(row),deepcopy(row.payload_json),connection,now)
        if self.provenance is not None:
            proof=self.provenance(self.db,row,now) if proof is None else proof
            if type(proof) is not dict or type(value) is not dict:raise OrderDenied('TYPED_APPLICATION_PROVENANCE_REQUIRED')
            value={**value,'application_provenance_hash':digest(proof)}
        return value

    def create(self,identity,key,connection_id,order,*,now=None):
        now=utc(now or datetime.now(timezone.utc));self.fence(identity)
        if not isinstance(key,str) or not 1<=len(key)<=128:raise OrderDenied('OPERATION_KEY_REQUIRED')
        conn=self.connection(identity.owner_id,connection_id,now);order=payload(deepcopy(order))
        bound={'owner_id':identity.owner_id,'module_id':identity.module_id,'module_version':identity.version,'connection_id':conn.id,'connection_version':conn.version,'account_id':conn.provider_account_id,'app_mode':conn.app_ownership_mode,'payload':order}
        request=digest(bound);kd=digest({'operation':'confirmed_order','key':key})
        old=self.db.scalar(select(OrderIntent).where(OrderIntent.owner_id==identity.owner_id,OrderIntent.operation_key_digest==kd).execution_options(populate_existing=True))
        if old:
            if old.request_digest!=request:raise OrderDenied('OPERATION_KEY_CONFLICT')
            self.checked(identity.owner_id,old.id,now);return old
        row=OrderIntent(id=str(uuid4()),owner_id=identity.owner_id,operation_key_digest=kd,request_digest=request,connection_id=conn.id,connection_version=conn.version,account_id=conn.provider_account_id,app_mode=conn.app_ownership_mode,module_id=identity.module_id,module_version=identity.version,payload_json=order,state='draft',created_at=now)
        self.db.add(row);self.db.flush()
        for i,leg in enumerate(order['legs']):self.db.add(OrderLeg(intent_id=row.id,position=i,payload_digest=digest(leg),client_reference=digest({'intent':row.id,'leg':i}),state='draft',filled_quantity=0))
        self.db.flush();return row

    def validate(self,owner,id,*,now=None):
        now=utc(now or datetime.now(timezone.utc));row,_=self.checked(owner,id,now)
        if row.state!='draft':raise OrderDenied('DRAFT_REQUIRED')
        risk=self.risk_for(row,self.connection(owner,row.connection_id,now),now)
        if not isinstance(risk,dict) or risk.get('allowed') is not True:raise OrderDenied('RISK_DENIED')
        row.risk_json=deepcopy(risk);row.review_digest=digest({'request':row.request_digest,'risk':risk});row.state='validated';self.db.flush();return row

    def review(self,owner,id,*,now=None):
        row,_=self.checked(owner,id,utc(now or datetime.now(timezone.utc)))
        if row.state not in {'validated','awaiting_approval'}:raise OrderDenied('VALIDATED_REVIEW_REQUIRED')
        row.state='awaiting_approval';self.db.flush()
        return {'id':row.id,'owner_id':row.owner_id,'account_id':row.account_id,'connection_id':row.connection_id,'connection_version':row.connection_version,'app_mode':row.app_mode,'payload':deepcopy(row.payload_json),'risk_results':deepcopy(row.risk_json),'review_digest':row.review_digest,'expires_in_seconds':int(TTL.total_seconds()),'simulation_only':True}

    def approve(self,owner,id,displayed_digest,*,action,now=None):
        # Called only by explicit authenticated HTTP confirmation. Neither task
        # headers nor scheduled work are an approval authority.
        from .authority import consume_confirmation
        consume_confirmation(owner,id,displayed_digest)
        now=utc(now or datetime.now(timezone.utc));row,_=self.checked(owner,id,now)
        if action!='confirm_exact_order_or_basket' or row.state!='awaiting_approval' or displayed_digest!=row.review_digest:raise OrderDenied('EXPLICIT_CURRENT_REVIEW_REQUIRED')
        row.approved_by=owner;row.approved_at=now;row.expires_at=min(now+TTL,stored_utc(self.connection(owner,row.connection_id,now).token_expires_at));row.approval_nonce=str(uuid4())
        row.approval_digest=self.approval_hash(row);row.state='approved'
        self.db.add(OutboxMessage(topic=TOPIC,payload={'intent_id':row.id,'owner_id':owner,'approval_digest':row.approval_digest,'request_digest':row.request_digest}))
        self.db.flush();return row

    def approval_hash(self,row):
        if row.approved_at is None or row.expires_at is None or row.approved_by!=row.owner_id or not row.approval_nonce:raise OrderDenied('NO_AUTHENTICATED_APPROVAL')
        return digest({'request':row.request_digest,'review':row.review_digest,'approved_by':row.approved_by,'approved_at':stored_utc(row.approved_at).isoformat(),'expires_at':stored_utc(row.expires_at).isoformat(),'nonce':row.approval_nonce})

    def revoke(self,owner,id):
        row=self.owned(owner,id,lock=False)
        self.db.scalar(select(User.id).where(User.id==owner).with_for_update())
        # Revocation remains available even when the optional module is off.
        self.db.scalar(select(UserModulePreferences.user_id).where(UserModulePreferences.user_id==owner).with_for_update())
        row=self.owned(owner,id)
        if row.state in {'filled','partial','acknowledged','rejected','unknown','submitting'}:raise OrderDenied('RECONCILIATION_REQUIRED_NO_BLIND_CANCEL')
        row.state='cancelled';row.approval_digest=None;self.db.flush();return row

    def dispatch(self,outbox_id,broker,*,now=None,before_effect=lambda:None):
        if type(broker)is not FakeBroker:raise OrderDenied('FAKE_BROKER_REQUIRED')
        check_time=(lambda:utc(now)) if now is not None else (lambda:utc(self.clock()))
        now=check_time()
        try:oid=UUID(str(outbox_id))
        except (ValueError,TypeError):raise OrderDenied('PERSISTED_DISPATCH_REQUIRED') from None
        event=self.db.get(OutboxMessage,oid,populate_existing=True)
        if event is None or event.topic!=TOPIC:raise OrderDenied('PERSISTED_DISPATCH_REQUIRED')
        p=deepcopy(event.payload);row,legs=self.checked(p.get('owner_id'),p.get('intent_id'),now)
        event=self.db.scalar(select(OutboxMessage).where(OutboxMessage.id==oid).with_for_update().execution_options(populate_existing=True))
        if event.payload!=p or set(p)!={'owner_id','intent_id','approval_digest','request_digest'} or p['request_digest']!=row.request_digest or p['approval_digest']!=row.approval_digest:raise OrderDenied('DISPATCH_BINDING_CHANGED')
        if event.execution_attempts or row.state!='approved' or not row.risk_json or row.approval_digest!=self.approval_hash(row) or stored_utc(row.expires_at)<=now:raise OrderDenied('CURRENT_UNUSED_APPROVAL_REQUIRED')
        event.execution_attempts=1;row.state='submitting';self.db.commit()
        for i,leg in enumerate(legs):
            # Mark before I/O. Crash after this commit is uncertain, never a retry.
            row,legs=self.checked(p['owner_id'],p['intent_id'],check_time());leg=legs[i]
            if row.state!='submitting' or leg.state!='draft':raise OrderDenied('ORDER_STATE_CHANGED')
            if row.payload_json['sequencing']=='sell_then_buy' and row.payload_json['legs'][i]['side']=='BUY' and any(l.state!='filled' or l.filled_quantity!=row.payload_json['legs'][j]['quantity'] for j,l in enumerate(legs[:i])):
                row.state='acknowledged';self.db.commit();return row
            leg.state='submitting';self.db.commit()
            try:
                before_effect();row,legs=self.checked(p['owner_id'],p['intent_id'],check_time());leg=legs[i]
                if row.state!='submitting' or leg.state!='submitting' or row.request_digest!=p['request_digest'] or row.approval_digest!=p['approval_digest'] or row.approval_digest!=self.approval_hash(row) or stored_utc(row.expires_at)<=check_time():raise OrderDenied('APPROVAL_REVOKED_OR_EXPIRED')
                # Selection/connection/intent locks held across the bounded fake
                # effect: disable/disconnect/revoke commits serialize here.
                receipt=broker.submit(deepcopy(row.payload_json['legs'][i]),leg.client_reference)
                receipt=validate_receipt(receipt,row.payload_json['legs'][i],leg.client_reference)
                duplicate=self.db.scalar(select(OrderLeg.id).join(OrderIntent,OrderLeg.intent_id==OrderIntent.id).where(OrderIntent.owner_id==row.owner_id,OrderIntent.account_id==row.account_id,OrderLeg.broker_order_id==receipt['broker_order_id'],OrderLeg.id!=leg.id).limit(1))
                if duplicate is not None:raise OrderDenied('DUPLICATE_BROKER_ORDER_RECEIPT')
                leg.state=receipt['state'];leg.broker_order_id=receipt['broker_order_id'];leg.filled_quantity=receipt['filled_quantity'];leg.reconciliation_json={'simulation':True,'receipt':deepcopy(receipt)}
                self.db.commit()
                if leg.state in {'partial','rejected','acknowledged'}:
                    row.state=leg.state;self.db.commit();return row
            except BaseException:
                self.db.rollback();row=self.owned(p['owner_id'],p['intent_id']);leg=self.legs(row)[i]
                row.state=leg.state='unknown';self.db.commit();raise
        row,legs=self.checked(p['owner_id'],p['intent_id'],check_time())
        if row.state!='submitting' or row.approval_digest!=p['approval_digest'] or row.approval_digest!=self.approval_hash(row) or stored_utc(row.expires_at)<=check_time() or any(l.state!='filled' or l.filled_quantity!=request['quantity'] for l,request in zip(legs,row.payload_json['legs'])):raise OrderDenied('QUANTITATIVE_BASKET_COMPLETION_REQUIRED')
        row.state='filled';self.db.commit();return row


def orders_for_runtime(db,runtime,**kwargs):
    return Orders(db,policy=runtime.policy,risk=runtime.risk,
        provenance=getattr(runtime,'provenance',None),**kwargs)
