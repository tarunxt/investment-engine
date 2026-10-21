"""Owner consent + current platform-admin role + durable access audit.

Only narrow profile/diagnostic summaries; no credentials, impersonation or
arbitrary SQL/resource URLs. An audit commit failure yields no data response.
"""
from datetime import datetime,timezone,timedelta
from uuid import UUID
from sqlalchemy import select
from app.domains.auth.models import User,UserRole,UserProfile,ActivityLog
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.ai_limits.contracts import BoundaryDenied,digest,utc
from .store import owner
from .monitoring import OperationalMonitor
TOPIC='public_service.support_consent.v1'
SCOPES=frozenset({'profile_summary','diagnostics'})

class SupportAccess:
    def __init__(self,db):self.db=db
    def people(self,*ids):
        if any(type(id)is not int or id<1 for id in ids):raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
        rows=list(self.db.scalars(select(User).where(User.id.in_(set(ids))).order_by(User.id).with_for_update().execution_options(populate_existing=True)))
        if len(rows)!=len(set(ids)) or any(not r.is_active or not r.is_verified for r in rows):raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
        return {r.id:r for r in rows}
    def consent(self,id,actor_id,scopes,ticket,*,confirmed=False,now=None):
        now=utc(now or datetime.now(timezone.utc));people=self.people(id,actor_id);actor=people[actor_id]
        if actor.role!=UserRole.ADMIN or actor_id==id or confirmed is not True or not scopes or not set(scopes)<=SCOPES or not isinstance(ticket,str) or not 3<=len(ticket)<=100:raise BoundaryDenied('EXACT_SUPPORT_CONSENT_REQUIRED')
        p={'owner_id':id,'actor_id':actor_id,'scopes':sorted(set(scopes)),'ticket_hash':digest(ticket),'expires_at':(now+timedelta(minutes=10)).isoformat()}
        row=OutboxMessage(topic=TOPIC,payload={**p,'seal':digest(p),'state':'granted'});self.db.add(row);self.db.flush();self.db.add(ActivityLog(user_id=id,action='support_consent',resource_type='support',details=str(row.id)));return row
    def owned(self,id,key):
        try:key=UUID(str(key))
        except (TypeError,ValueError):raise BoundaryDenied('OWNED_CONSENT_REQUIRED') from None
        row=self.db.scalar(select(OutboxMessage).where(OutboxMessage.id==key,OutboxMessage.topic==TOPIC).with_for_update().execution_options(populate_existing=True))
        if row is None or row.payload.get('owner_id')!=id:raise BoundaryDenied('OWNED_CONSENT_REQUIRED')
        return row
    def revoke(self,id,key):
        owner(self.db,id,verified=True);row=self.owned(id,key);row.payload={**row.payload,'state':'revoked'};self.db.add(ActivityLog(user_id=id,action='support_revoked',details=str(row.id)));return row
    def read(self,actor_id,key,scope,*,now=None):
        now=utc(now or datetime.now(timezone.utc))
        try:key=UUID(str(key))
        except (TypeError,ValueError):raise BoundaryDenied('SUPPORT_ACCESS_DENIED') from None
        hint=self.db.get(OutboxMessage,key,populate_existing=True)
        if hint is None or hint.topic!=TOPIC:raise BoundaryDenied('SUPPORT_ACCESS_DENIED')
        subject=hint.payload.get('owner_id');people=self.people(subject,actor_id);user=people[subject];actor=people[actor_id];row=self.owned(subject,key);p=row.payload
        valid=(actor.role==UserRole.ADMIN and actor_id==p['actor_id'] and p['state']=='granted' and scope in p['scopes'] and scope in SCOPES and utc(datetime.fromisoformat(p['expires_at']))>now and digest({k:v for k,v in p.items() if k not in {'state','seal'}})==p['seal'])
        if not valid:
            self.db.add(ActivityLog(user_id=actor_id,action='support_denied',resource_type='support',details=digest({'subject':subject,'consent':str(key)})));self.db.commit();raise BoundaryDenied('SUPPORT_ACCESS_DENIED')
        self.db.add(ActivityLog(user_id=actor_id,action='support_read',resource_type=scope,resource_id=subject,details=str(key)))
        self.db.flush() # fail before even querying protected diagnostic rows
        result={'owner_id':subject,'user_id':user.id,'profile_present':self.db.scalar(select(UserProfile.user_id).where(UserProfile.user_id==subject)) is not None} if scope=='profile_summary' else OperationalMonitor(self.db).snapshot(subject,correlation_id=str(key),now=now)
        self.db.commit() # commit before delivery; failure never returns data
        return result
