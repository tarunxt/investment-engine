"""Transactional new-account admission, independent of module/AI budgets.

Counts admitted creations in the caller's transaction; rollback releases the
reservation. This is not a perimeter credential-verification/IP/CAPTCHA limit.
"""
from dataclasses import dataclass
from datetime import datetime,timezone,timedelta
import hashlib
from fastapi import HTTPException
from app.domains.ai_limits.contracts import BoundaryDenied,utc
from .store import control
@dataclass(frozen=True)
class SignupLimits:
    per_hour:int=20
    per_identity:int=3
    def validate(self):
        if type(self.per_hour)is not int or type(self.per_identity)is not int or not 1<=self.per_identity<=self.per_hour<=128:raise BoundaryDenied('SIGNUP_LIMITS_INVALID')
        return self

def admit(db,email,*,now=None,limits=SignupLimits()):
    now=utc(now or datetime.now(timezone.utc));limits.validate()
    if not isinstance(email,str) or not 3<=len(email)<=320 or '@' not in email:raise BoundaryDenied('SIGNUP_IDENTITY_REQUIRED')
    identity=hashlib.sha256(email.strip().lower().encode()).hexdigest()
    row=control(db,'signup');events=row.payload.get('events',[])
    if not isinstance(events,list) or len(events)>128:raise BoundaryDenied('SIGNUP_LEDGER_INVALID')
    retained=[]
    for event in events:
        try:at=utc(datetime.fromisoformat(event['at']))
        except (KeyError,TypeError,ValueError):raise BoundaryDenied('SIGNUP_LEDGER_INVALID') from None
        if at>now:raise BoundaryDenied('SIGNUP_CLOCK_ROLLBACK')
        if at>now-timedelta(hours=1):retained.append(event)
    if len(retained)>=limits.per_hour or sum(e['identity']==identity for e in retained)>=limits.per_identity:raise BoundaryDenied('SIGNUP_QUOTA_EXHAUSTED')
    row.payload={**row.payload,'events':retained+[{'at':now.isoformat(),'identity':identity}]}
    db.flush();return identity

async def admit_signup(db,email):
    try:return await db.run_sync(lambda s:admit(s,email))
    except BoundaryDenied:raise HTTPException(429,'Account creation temporarily unavailable; retry later') from None
