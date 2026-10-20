"""Bounded, read-only owned safety activity; no provider/runtime invocation."""
import json
from sqlalchemy import select,or_
from sqlalchemy.exc import SQLAlchemyError
from app.domains.auth.models import ActivityLog,UserRole

async def safety_activity(db,user):
    rows=(await db.execute(select(ActivityLog).where(ActivityLog.user_id==user.id,
        or_(ActivityLog.action.ilike('%order%'),ActivityLog.action=='module_preferences_updated'))
        .order_by(ActivityLog.id.desc()).limit(50))).scalars().all()
    events=[]
    for row in rows:
        try:details=json.loads(row.details or '{}') if isinstance(row.details,str) else row.details or {}
        except (ValueError,TypeError):details={}
        if not isinstance(details,dict):details={}
        events.append({'id':row.id,'action':row.action,'at':row.created_at.isoformat(),
            'status':str(details.get('status','recorded'))[:64]})
    source={'name':'accepted_order_intents','state':'restricted','items':[]}
    if user.role==UserRole.ADMIN:
        from app.domains.polymarket_auto_live.models import PolymarketAutoLiveOrderIntentRecord as Intent
        try:
            async with db.begin_nested():
                intents=(await db.execute(select(Intent.id,Intent.action,Intent.status).where(Intent.user_id==user.id,
                    Intent.remote_order_id.is_not(None),Intent.status.notin_(['filled','cancelled','canceled','completed','rejected','expired']))
                    .order_by(Intent.updated_at.desc()).limit(50))).all()
            source.update(state='checked',items=[{'id':i.id,'action':i.action,'status':i.status} for i in intents])
        except SQLAlchemyError:source.update(state='unavailable')
    return {'owner_id':user.id,'read_only':True,'events':events,'sources':[source],
        'complete_financial_reconciliation':False,
        'notice':'Recorded account activity remains visible with modules disabled. This view does not contact brokers, submit/cancel orders or claim complete live reconciliation. Existing runtime role restrictions remain in force.'}
