"""Actual owned SQL observations -> durable redacted local alerts. No network."""
from datetime import datetime,timezone
from uuid import UUID,uuid5,NAMESPACE_URL
from decimal import Decimal
from sqlalchemy import select,func
from app.domains.auth.models import ActivityLog
from app.domains.order_intents.models import OrderIntent
from app.domains.recommendation_audit.models import SpendAccount
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.ai_limits.private_effects import LocalSink
from app.domains.ai_limits.contracts import BoundaryDenied,digest,utc
from .operations import diagnostics
from .store import control,owner
TOPIC='public_service.operational_alert.synthetic.v1'

def stored_time(value):
    if value is None:return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else utc(value)

class OperationalMonitor:
    def __init__(self,db,*,source_time=None):
        if source_time is not None and not callable(source_time):raise BoundaryDenied('MONITOR_SOURCE_BINDING_REQUIRED')
        self.db,self.source_time=db,source_time
    def snapshot(self,id,*,correlation_id=None,now=None):
        now=utc(now or datetime.now(timezone.utc));owner(self.db,id)
        captured=self.source_time(id) if self.source_time is not None else self.db.scalar(select(func.max(ZerodhaPortfolioSnapshot.captured_at)).where(ZerodhaPortfolioSnapshot.user_id==id))
        if captured is not None and not isinstance(captured,datetime):raise BoundaryDenied('MONITOR_SOURCE_BINDING_REQUIRED')
        captured=stored_time(captured)
        unknown=self.db.scalar(select(func.count()).select_from(OrderIntent).where(OrderIntent.owner_id==id,OrderIntent.state.in_(['unknown','submitting','partial'])))
        account=self.db.scalar(select(SpendAccount).where(SpendAccount.user_id==id,SpendAccount.day==now.date().isoformat()))
        age=901 if captured is None else max(0,int((now-captured).total_seconds()))
        if captured is not None and captured>now:age=901
        cost=Decimal('0') if account is None else account.spent_usd+account.reserved_usd
        cap=Decimal('0') if account is None else account.cap_usd
        result=diagnostics(correlation_id=correlation_id or str(uuid5(NAMESPACE_URL,f'credx:monitor:{id}:{now.date()}')),stale_seconds=age,unknown_orders=unknown,cost_usd=cost,cap_usd=cap)
        return {**result,'owner_id':id,'source_unavailable':captured is None,'scope':'owned_database_observation'}
    def observe(self,id,*,correlation_id,now=None,sink=None,provenance=None):
        now=utc(now or datetime.now(timezone.utc));sink=LocalSink() if sink is None else sink
        if type(sink)is not LocalSink:raise BoundaryDenied('LOCAL_ALERT_SINK_REQUIRED')
        if provenance is not None:
            import json
            try: valid=type(provenance) is dict and len(json.dumps(provenance,allow_nan=False).encode())<=4096
            except (ValueError,TypeError):valid=False
            if not valid:raise BoundaryDenied('MONITOR_PROVENANCE_REQUIRED')
        control(self.db,'monitor');report=self.snapshot(id,correlation_id=correlation_id,now=now)
        identity={k:report[k] for k in ('owner_id','stale_data','unknown_orders','cost_spike','source_unavailable')}
        key=uuid5(NAMESPACE_URL,'credx:local-alert:'+digest({**identity,'hour':now.strftime('%Y-%m-%dT%H'),
            **({'provenance':provenance} if provenance is not None else {})}))
        row=self.db.scalar(select(OutboxMessage).where(OutboxMessage.id==key).with_for_update())
        if row is None:
            row=OutboxMessage(id=key,topic=TOPIC,payload={**report,'synthetic_sink':True,'state':'pending',
                **({'provenance':provenance} if provenance is not None else {})});self.db.add(row);self.db.flush()
        if row.topic!=TOPIC or row.payload.get('owner_id')!=id:raise BoundaryDenied('ALERT_BINDING_CHANGED')
        if row.payload['state']=='pending':
            receipt=sink.deliver(str(row.id),report);row.payload={**row.payload,'state':'recorded','receipt':receipt};row.execution_attempts+=1
        self.db.commit();return row.payload
