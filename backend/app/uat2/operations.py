"""Native source-aware observations using the existing closed local monitor.

External sinks/rosters are unconfigured. No role grant, alert send, trading
control or data erasure occurs. Evidence records stay in the existing SQL store.
"""
from datetime import datetime,timezone
import os
import re
from uuid import uuid5,NAMESPACE_URL
from sqlalchemy import select,func
from app.domains.modules.models import UserModule
from app.domains.ai_limits.contracts import BoundaryDenied,digest
from app.domains.runs.analysis_workflows.synthetic_composition import SyntheticAnalysis
from app.domains.public_service.monitoring import OperationalMonitor,TOPIC
from app.domains.public_service.store import owner,control
from app.infrastructure.database.outbox.models import OutboxMessage


class SimulationOperations:
    def __init__(self,analysis):
        if type(analysis) is not SyntheticAnalysis:raise BoundaryDenied('EXACT_SIMULATION_ANALYSIS_REQUIRED')
        self.analysis=analysis

    def sources(self,db,subject,now):
        self.analysis.scope.validate(db,subject);owner(db,subject,verified=True)
        selected=set(db.scalars(select(UserModule.module_id).where(UserModule.user_id==subject,UserModule.enabled.is_(True))))
        versions={};captures=[]
        for module,portfolio in (('zerodha_rebalance','india'),('indmoney_us','indmoney_us')):
            if module not in selected:continue
            try:
                source=self.analysis.source(db,subject,portfolio)
                captured=datetime.fromisoformat(source['captured_at'])
                if captured.tzinfo is None:raise ValueError()
                versions[module]=source['content_hash'];captures.append(captured)
            except (PermissionError,BoundaryDenied,KeyError,TypeError,ValueError):versions[module]=None
        missing=any(value is None for value in versions.values())
        capture=None if missing else min(captures) if captures else now
        declared=os.getenv('UAT2_SOURCE_COMMIT','')
        declared=declared if re.fullmatch('[0-9a-f]{40}',declared) else 'local-unbuilt'
        proof={'schema':1,'binding':'uat2-native-source-observation-v1',
            'declared_source_commit':declared,'source_versions':versions}
        return capture,proof

    def snapshot(self,db,subject,*,now=None):
        now=now or datetime.now(timezone.utc)
        capture,proof=self.sources(db,subject,now)
        correlation=str(uuid5(NAMESPACE_URL,'credx:native-observation:'+digest({'owner':subject,'proof':proof,'day':now.date().isoformat()})))
        report=OperationalMonitor(db,source_time=lambda _:capture).snapshot(subject,correlation_id=correlation,now=now)
        return {**report,'observed_at':now.isoformat(),'provenance':proof,'external_delivery':False,'simulation_only':True}

    def observe(self,db,subject,*,now=None):
        now=now or datetime.now(timezone.utc)
        control(db,'monitor') # preserve canonical control -> owner lock order
        capture,proof=self.sources(db,subject,now)
        count=db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==TOPIC,
            OutboxMessage.payload['owner_id'].as_integer()==subject))
        if count>=1000:
            return {'owner_id':subject,'state':'held_retention_review','external_delivery':False,'simulation_only':True}
        correlation=str(uuid5(NAMESPACE_URL,'credx:native-observation:'+digest({'owner':subject,'proof':proof,'day':now.date().isoformat()})))
        result=OperationalMonitor(db,source_time=lambda _:capture).observe(subject,correlation_id=correlation,
            now=now,provenance=proof)
        return {**result,'external_delivery':False,'simulation_only':True}
