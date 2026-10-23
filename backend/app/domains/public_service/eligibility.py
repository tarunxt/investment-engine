"""Residency is a server-owned reviewed assertion, never email/IP inference.

Submissions are pending. No HTTP endpoint can turn a self-declaration into a
verified residence or override any provider/module/execution approval.
"""
from datetime import datetime,timezone
from sqlalchemy import select
from app.domains.auth.models import ActivityLog
from app.domains.ai_limits.contracts import BoundaryDenied
import json


async def eligibility_status(db,owner):
    row=(await db.execute(select(ActivityLog).where(ActivityLog.user_id==owner,ActivityLog.action=='residency_declared').order_by(ActivityLog.id.desc()).limit(1))).scalar_one_or_none()
    return {'owner_id':owner,'country':json.loads(row.details)['country'] if row else None,'status':'pending_review' if row else 'unknown','eligible':False,'notice':'Google email, IP address and self-declaration do not prove India residency. Review and provider approval remain required.'}


async def declare(db,owner,country):
    if country!='IN':raise BoundaryDenied('INDIA_RESIDENT_SCOPE_ONLY')
    db.add(ActivityLog(user_id=owner,action='residency_declared',details=json.dumps({'country':'IN','status':'pending_review','version':1})))
    await db.flush();return await eligibility_status(db,owner)
