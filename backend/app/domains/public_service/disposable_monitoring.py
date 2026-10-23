"""Disposable monitoring composition only; no network sink or runtime default."""
from dataclasses import dataclass
from datetime import datetime,timezone
from typing import Callable
from sqlalchemy import select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from app.domains.ai_limits.contracts import BoundaryDenied,utc
from app.domains.ai_limits.private_effects import LocalSink
from app.domains.auth.models import User,UserRole
from app.infrastructure.database.outbox.models import OutboxMessage
from .sql_privacy_workflow import DisposablePrivacyScope
from .monitor_dispatch import MonitorDispatch,MonitorDispatchPolicy,TOPIC
from .monitoring import OperationalMonitor
from .disposable_consumers import check_disposable_transport

TASK='public_service.monitor.consume'
QUEUE='operational_monitoring'
STATES=frozenset({'queued','dispatching','recorded','uncertain','escalated','acknowledged'})

@dataclass(frozen=True)
class DisposableMonitoringFactory:
    scope:DisposablePrivacyScope
    engine:Engine
    scope_hash:str
    policy:MonitorDispatchPolicy
    sink:LocalSink
    clock:Callable[[],datetime]|None=None

    @classmethod
    def from_session(cls,db,scope,policy,sink):
        if type(scope)is not DisposablePrivacyScope:raise BoundaryDenied('DISPOSABLE_MONITOR_BINDING_REQUIRED')
        value=cls(scope,db.get_bind(),scope.validate(db),policy,sink)
        return value.validate(scope.reference)

    def validate(self,reference):
        import os
        if (os.getenv('ENVIRONMENT')!='test' or type(self.scope)is not DisposablePrivacyScope
            or self.scope.reference!=reference or not isinstance(self.engine,Engine)
            or type(self.scope_hash)is not str or len(self.scope_hash)!=64
            or type(self.policy)is not MonitorDispatchPolicy
            or not self.policy.reference.startswith('synthetic:') or type(self.sink)is not LocalSink
            or self.clock is not None and not callable(self.clock)):
            raise BoundaryDenied('DISPOSABLE_MONITOR_BINDING_REQUIRED')
        self.policy.fingerprint();return self

    def now(self):return utc(self.clock() if self.clock else datetime.now(timezone.utc))

    def service(self,db):
        self.validate(self.scope.reference)
        if self.scope.validate(db)!=self.scope_hash:raise BoundaryDenied('DISPOSABLE_MONITOR_DATABASE_CHANGED')
        return MonitorDispatch(db,policy=self.policy,sink=self.sink)

    def observe(self,db,subject):
        service=self.service(db)
        # All intake and delivery paths take control -> owner. Snapshot itself
        # takes the owner fence, so acquire the shared order before reading it.
        service._fence(subject)
        # The existing monitor derives a stable owner/day correlation itself.
        # Repeated identical observations coalesce; callers cannot manufacture
        # unlimited unique reports by varying a request UUID or report flags.
        now=self.now();report=OperationalMonitor(db).snapshot(subject,now=now)
        row=service.enqueue(subject,report,now=now)
        return self.status(db,subject,row.id)

    def status(self,db,subject,key):
        service=self.service(db);service._fence(subject);row=service._row(subject,key)
        state=row.payload.get('state')
        if type(state)is not str or state not in STATES:raise BoundaryDenied('MONITOR_ALERT_CHANGED')
        return {'id':str(row.id),'state':state,'uncertain':state in {'dispatching','uncertain'},'synthetic_only':True}

    def operator(self,db,subject,actor):
        service=self.service(db);service._fence(subject)
        if type(actor)is not int or actor not in self.policy.operator_ids:raise BoundaryDenied('MONITOR_OPERATOR_REQUIRED')
        person=db.scalar(select(User).where(User.id==actor).with_for_update().execution_options(populate_existing=True))
        if person is None or not person.is_active or not person.is_verified or person.role!=UserRole.ADMIN:
            raise BoundaryDenied('MONITOR_OPERATOR_REQUIRED')
        return service

    def acknowledge(self,db,subject,key,actor):
        self.operator(db,subject,actor).acknowledge(subject,key,actor,now=self.now())
        return self.status(db,subject,key)

    def escalate(self,db,subject,key,actor):
        self.operator(db,subject,actor).escalate(subject,key,now=self.now())
        return self.status(db,subject,key)

    def consume(self):
        with Session(self.engine,expire_on_commit=False) as db:
            try:
                service=self.service(db)
                # No row lock before control/owner: dispatch owns that lock
                # order. Concurrent consumers revalidate the selected row.
                row=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC,
                    OutboxMessage.payload['state'].as_string()=='queued').order_by(OutboxMessage.created_at,OutboxMessage.id).limit(1))
                if row is None:
                    uncertain=db.scalar(select(OutboxMessage.id).where(OutboxMessage.topic==TOPIC,
                        OutboxMessage.payload['state'].as_string().in_(['dispatching','uncertain'])).limit(1))
                    return {'state':'idle','uncertain_pending':uncertain is not None,'synthetic_only':True}
                subject=row.payload.get('owner_id');key=row.id
                self.status(db,subject,key)
                service.dispatch(subject,key,now=self.now())
                return self.status(db,subject,key)
            except Exception:
                db.rollback()
                # Corrupt persisted values or adapter failures must not put
                # their original exception arguments into Celery error logs.
                raise BoundaryDenied('DISPOSABLE_MONITOR_DISPATCH_REJECTED') from None
            except BaseException:
                db.rollback();raise # preserves process-loss boundaries; no auto retry

    def register(self,app):
        self.validate(self.scope.reference);check_disposable_transport(app)
        previous=getattr(app,'_credx_disposable_monitor',None)
        if previous is not None:
            factory,task=previous
            if factory is not self or app.tasks.get(TASK)is not task:raise BoundaryDenied('MONITOR_TASK_BINDING_CHANGED')
            return task
        routes=app.conf.task_routes or {}
        if type(routes)is not dict or TASK in app.tasks:raise BoundaryDenied('MONITOR_TASK_BINDING_CHANGED')
        @app.task(name=TASK,shared=False,queue=QUEUE,acks_late=True,reject_on_worker_lost=True,
            max_retries=0,autoretry_for=(),soft_time_limit=30,time_limit=35)
        def consume_monitor():return self.consume()
        task=consume_monitor
        app.conf.task_routes={**routes,TASK:{'queue':QUEUE}}
        app._credx_disposable_monitor=(self,task)
        return task # no send, Beat schedule or normal-runtime registration
