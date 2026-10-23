"""Recover selected executable SQL fixtures without reviving work authority.

The inherited exact disposable scope rejects UAT2/production. No runtime route,
worker binding, general operator-state restore or real identity erasure exists.
"""
from datetime import timezone
from sqlalchemy import select,update,func
from app.domains.ai_limits.contracts import BoundaryDenied,digest
from app.domains.auth.models import UserSession,APIKey,ActivityLog
from app.domains.jobs.models import Job
from app.domains.modules.models import UserModule,UserModulePreferences
from app.domains.runs.models import Run,RunJob,AutoRebalanceWorkflow,AutoRebalanceWorkflowStage
from .recoverable_privacy import RecoverableFixturePrivacy

REFERENCE='synthetic:quarantined-work-recovery-v1'
CONTRACTS={model.__tablename__:model.__table__ for model in (Job,Run,RunJob,AutoRebalanceWorkflow,AutoRebalanceWorkflowStage,UserSession,APIKey,UserModule,UserModulePreferences)}


class QuarantinedFixturePrivacy(RecoverableFixturePrivacy):
    contracts=CONTRACTS
    reference=REFERENCE
    def _contract(self,name):
        table=self.reader.metadata.tables.get(name);expected=self.contracts[name]
        if table is None:raise BoundaryDenied('RECOVERY_QUARANTINE_SCHEMA_REQUIRED')
        shape=lambda value:sorted((column.name,str(column.type),column.nullable) for column in value.c)
        links=lambda value:sorted((element.parent.name,element.target_fullname,constraint.ondelete or '',constraint.onupdate or '',
            str(constraint.deferrable),str(constraint.initially)) for constraint in value.foreign_key_constraints for element in constraint.elements)
        if shape(table)!=shape(expected) or links(table)!=links(expected):
            raise BoundaryDenied('RECOVERY_QUARANTINE_SCHEMA_REQUIRED')
        return table

    def _restorable(self,name):
        if name not in self.contracts:return super()._restorable(name)
        if self.scope.reference!=self.reference:raise BoundaryDenied('EXPLICIT_QUARANTINED_RECOVERY_SCOPE_REQUIRED')
        self._contract(name)
        for other in self.contracts:
            if other in self.reader.metadata.tables:self._contract(other)
        if name in {'jobs','runs','run_jobs','auto_rebalance_workflows','auto_rebalance_workflow_stages','user_modules','user_module_preferences'}:
            self._contract('user_modules');self._contract('user_module_preferences')
        if name=='auto_rebalance_workflow_stages':self._contract('auto_rebalance_workflows')
        if name=='run_jobs':self._contract('runs');self._contract('jobs')
        return True

    def _after_restore(self,owner,counts,now):
        if not any(name in self.contracts and count for name,count in counts.items()):return {}
        # This only runs inside the inherited restore savepoint, after all
        # parents/children are inserted and before the restored audit commits.
        if self.scope.reference!=self.reference:raise BoundaryDenied('EXPLICIT_QUARANTINED_RECOVERY_SCOPE_REQUIRED')
        controls={'schema':1,'owner_id':owner,'authority_restored':False,'quarantined_tables':[],
            'module_version_floor':None,'prior_sessions_revoked':True}
        tables=self.reader.metadata.tables
        if 'user_module_preferences' in tables or 'user_modules' in tables:
            header=self._contract('user_module_preferences');modules=self._contract('user_modules')
            previous=self.db.scalar(select(header.c.version).where(header.c.user_id==owner).with_for_update())
            versions=[previous or 0,self.db.scalar(select(func.max(modules.c.version)).where(modules.c.user_id==owner)) or 0]
            if 'jobs' in tables:
                jobs=self._contract('jobs')
                versions.append(self.db.scalar(select(func.max(jobs.c.module_version)).where(jobs.c.user_id==owner)) or 0)
            for name in ('runs','auto_rebalance_workflows'):
                if name in tables:
                    work=self._contract(name)
                    versions.append(self.db.scalar(select(func.max(work.c.module_version)).where(work.c.user_id==owner)) or 0)
            floor=max(versions)+1
            if previous is None:self.db.execute(header.insert().values(user_id=owner,version=floor,updated_at=now.astimezone(timezone.utc).replace(tzinfo=None)))
            else:self.db.execute(update(header).where(header.c.user_id==owner).values(version=floor,updated_at=now.astimezone(timezone.utc).replace(tzinfo=None)))
            self.db.execute(update(modules).where(modules.c.user_id==owner).values(enabled=False,schedules_paused=True,version=floor))
            controls['module_version_floor']=floor
        for name in ('runs','auto_rebalance_workflows'):
            if name not in tables:continue
            work=self._contract(name)
            self.db.execute(update(work).where(work.c.user_id==owner).values(module_cancel_requested=True))
            self.db.execute(update(work).where(work.c.user_id==owner,
                work.c.status.not_in(['completed','failed','cancelled'])).values(status='failed'))
            if name=='runs':
                self.db.execute(update(work).where(work.c.user_id==owner).values(auto_export_enabled=False))
            else:
                self.db.execute(update(work).where(work.c.user_id==owner).values(control_version=work.c.control_version+1))
                if 'auto_rebalance_workflow_stages' in tables:
                    stages=self._contract('auto_rebalance_workflow_stages')
                    self.db.execute(update(stages).where(stages.c.workflow_id.in_(
                        select(work.c.id).where(work.c.user_id==owner)),
                        stages.c.status.not_in(['completed','failed','cancelled'])).values(status='failed',
                            error_message='Restored in quarantine; no automatic work resumed'))
            controls['quarantined_tables'].append(name)
        for name in ('jobs','user_sessions','api_keys'):
            if name not in tables:continue
            table=self._contract(name)
            if name=='jobs':
                self.db.execute(update(table).where(table.c.user_id==owner).values(module_cancel_requested=True))
                self.db.execute(update(table).where(table.c.user_id==owner,
                    table.c.status.not_in(['completed','failed','cancelled'])).values(status='failed',
                        error_message='Restored in quarantine; new explicit work and current module version required'))
            else:self.db.execute(update(table).where(table.c.user_id==owner).values(is_active=False))
            controls['quarantined_tables'].append(name)
        self.db.add(ActivityLog(user_id=owner,action='logout',resource_type='privacy_recovery_quarantine',
            created_at=now.astimezone(timezone.utc).replace(tzinfo=None),details='Synthetic recovery revoked prior authentication; no work authority restored'))
        self.db.flush()
        return controls

    def _restore_metadata(self,row):
        controls=row.payload.get('restore_controls')
        if controls is None:
            if 'restore_controls_hash' in row.payload:raise BoundaryDenied('RECOVERY_QUARANTINE_RECEIPT_INVALID')
            return {}
        if (type(controls) is not dict or controls.get('schema')!=1 or controls.get('authority_restored') is not False
                or controls.get('owner_id')!=row.payload.get('owner_id')
                or controls.get('prior_sessions_revoked') is not True
                or digest(controls)!=row.payload.get('restore_controls_hash')):
            raise BoundaryDenied('RECOVERY_QUARANTINE_RECEIPT_INVALID')
        return {'restore_controls':controls}
