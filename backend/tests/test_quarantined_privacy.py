"""Recover actual queued-job models only in disposable synthetic SQL fixtures."""
from dataclasses import replace
from datetime import timedelta
import pytest
from sqlalchemy import MetaData,select,event,func
from test_stage17_sql_privacy_plan import setup as plan_setup,residency_setup,NOW
from app.domains.auth.models import UserSession,ActivityLog
from app.domains.jobs.models import Job
from app.domains.modules.models import UserModule,UserModulePreferences
from app.domains.public_service.sql_account import SQLAccountReader,AccountInventory,AccountTableRule,OwnerHop,schema_digest,_credential_column
from app.domains.public_service.sql_privacy_workflow import DisposablePrivacyScope
from app.domains.public_service.sql_privacy_plan import RetentionSchedule
from app.domains.public_service.quarantined_privacy import QuarantinedFixturePrivacy,REFERENCE
from app.domains.public_service.recoverable_privacy import RecoverableFixturePrivacy,TOPIC
from app.domains.ai_limits.contracts import BoundaryDenied
from app.shared.types import JobStatus
from app.infrastructure.database.outbox.models import OutboxMessage


@pytest.fixture
def quarantined(plan_setup):
    db,planner,request=plan_setup
    for model in (Job,UserModulePreferences,UserModule,UserSession):model.__table__.create(db.get_bind())
    for owner in (1,2):
        db.add(UserModulePreferences(user_id=owner,version=1))
        db.add(UserModule(user_id=owner,module_id='indmoney_us',enabled=True,version=1,
            schedules_paused=False,config={'schema_version':1}))
        db.add(Job(id=owner,user_id=owner,module_id='indmoney_us',module_version=1,
            provider='synthetic',model='fixture',prompt='synthetic queued work',status=JobStatus.PENDING))
        db.add(UserSession(id=owner,user_id=owner,token_hash='non-secret-fixture-hash-'+str(owner),
            expires_at=NOW.replace(tzinfo=None)+timedelta(days=1),is_active=True))
    db.commit()
    metadata=MetaData();metadata.reflect(db.get_bind());rules=[]
    for name,table in metadata.tables.items():
        if name in {'outbox','activity_logs'}:rules.append(AccountTableRule(name,(),excluded_reason='fixture operational anchors'));continue
        exported=tuple(column for column in table.c.keys() if not _credential_column(column))
        withheld=tuple(column for column in table.c.keys() if _credential_column(column))
        path=()
        if name=='fixture_holdings':path=(OwnerHop('fixture_portfolios',('portfolio_id',),('id',)),)
        if name=='user_modules':path=(OwnerHop('user_module_preferences',('user_id',),('user_id',)),)
        rules.append(AccountTableRule(name,exported,withheld,path=path,owner_column='id' if name=='users' else 'user_id'))
    inventory=AccountInventory('synthetic:quarantined-source-review',schema_digest(metadata),tuple(rules))
    retention=RetentionSchedule('synthetic:retention-review',NOW+timedelta(days=1),
        retain_until=tuple((name,None) for name in metadata.tables))
    workflow=QuarantinedFixturePrivacy(db,SQLAccountReader(db,metadata,inventory),planner.keyring,
        retention=retention,scope=DisposablePrivacyScope(REFERENCE))
    return db,workflow,request


def test_restored_jobs_sessions_and_modules_have_no_replay_authority(quarantined):
    db,workflow,request=quarantined
    result=workflow.execute(1,request,now=NOW);db.commit();db.expire_all()
    assert result['removed_counts']['jobs']==1 and db.get(Job,1) is None
    assert db.get(Job,2).status==JobStatus.PENDING
    restored=workflow.restore(1,request,now=NOW);db.commit();db.expire_all()
    job=db.get(Job,1);module=db.scalar(select(UserModule).where(UserModule.user_id==1))
    assert job.status==JobStatus.FAILED and job.module_cancel_requested
    assert job.module_version==1 and module.version>job.module_version
    assert module.enabled is False and module.schedules_paused is True
    assert db.get(UserSession,1).is_active is False
    assert db.get(Job,2).status==JobStatus.PENDING and db.get(UserSession,2).is_active is True
    assert restored['restore_controls']['authority_restored'] is False
    assert restored['complete_account_erasure'] is False
    version=module.version
    assert workflow.restore(1,request,now=NOW)['state']=='already_restored'
    assert db.scalar(select(UserModulePreferences.version).where(UserModulePreferences.user_id==1))==version
    assert db.scalar(select(func.count()).select_from(ActivityLog).where(ActivityLog.user_id==1,ActivityLog.action=='logout'))==1


def test_original_data_only_adapter_still_refuses_queued_job_restore(quarantined):
    db,workflow,request=quarantined
    original=RecoverableFixturePrivacy(db,workflow.reader,workflow.keyring,retention=workflow.retention,scope=workflow.scope)
    with pytest.raises(BoundaryDenied,match='STORE_ADAPTER_UNAVAILABLE'):original.execute(1,request,now=NOW)
    db.commit();db.expire_all();assert db.get(Job,1).status==JobStatus.PENDING


def test_quarantine_audit_failure_rolls_back_restore_and_controls_even_after_outer_commit(quarantined):
    db,workflow,request=quarantined
    workflow.execute(1,request,now=NOW);db.commit()
    def fail(session,ctx,instances):
        if any(isinstance(row,ActivityLog) and row.action=='logout' for row in session.new):raise RuntimeError('synthetic audit failure')
    event.listen(db,'before_flush',fail)
    try:
        with pytest.raises(RuntimeError):workflow.restore(1,request,now=NOW)
        db.commit()
    finally:event.remove(db,'before_flush',fail)
    db.expire_all();assert db.get(Job,1) is None
    assert db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC)).payload['state']=='recoverable'
    assert db.get(Job,2).status==JobStatus.PENDING


@pytest.mark.parametrize('case',['scope','production'])
def test_quarantine_remains_unavailable_outside_its_explicit_fixture_scope(quarantined,monkeypatch,case):
    db,workflow,request=quarantined
    if case=='scope':workflow.scope=DisposablePrivacyScope('synthetic:unreviewed-recovery')
    else:monkeypatch.setenv('ENVIRONMENT','production')
    with pytest.raises(BoundaryDenied):workflow.execute(1,request,now=NOW)
    db.commit();db.expire_all();assert db.get(Job,1).status==JobStatus.PENDING


def test_restored_run_workflow_and_stage_are_quarantined(quarantined):
    from app.domains.runs.models import Run,RunJob,AutoRebalanceWorkflow,AutoRebalanceWorkflowStage
    from app.domains.prompts.models import Prompt
    db,old,request=quarantined
    for model in (Prompt,Run,RunJob,AutoRebalanceWorkflow,AutoRebalanceWorkflowStage):
        model.__table__.create(db.get_bind())
    for subject in (1,2):
        db.add(Run(id=subject,user_id=subject,prompt='synthetic',prompt_preview='synthetic',
            module_id='indmoney_us',module_version=7,status=JobStatus.PENDING,auto_export_enabled=True))
        db.add(AutoRebalanceWorkflow(id=subject,user_id=subject,portfolio='us',sequence=1,
            label='synthetic',module_id='indmoney_us',module_version=9,status='queued'))
    db.flush()
    for subject in (1,2):
        db.add(AutoRebalanceWorkflowStage(id=subject,workflow_id=subject,stage='parse',status='queued'))
        db.add(RunJob(id=subject,run_id=subject,job_id=subject,stage=1))
    db.commit()
    metadata=MetaData();metadata.reflect(db.get_bind())
    rules=list(old.reader.inventory.rules)
    for name in ('prompts','runs','run_jobs','auto_rebalance_workflows','auto_rebalance_workflow_stages'):
        table=metadata.tables[name];path=()
        if name=='prompts':
            rules.append(AccountTableRule(name,(),excluded_reason='fixture retained prompt anchors'));continue
        if name=='run_jobs':path=(OwnerHop('runs',('run_id',),('id',)),)
        if name=='auto_rebalance_workflow_stages':path=(OwnerHop('auto_rebalance_workflows',('workflow_id',),('id',)),)
        fields=tuple(c for c in table.c.keys() if not _credential_column(c))
        rules.append(AccountTableRule(name,fields,tuple(c for c in table.c.keys() if _credential_column(c)),path=path))
    inventory=AccountInventory('synthetic:work-graph',schema_digest(metadata),tuple(rules))
    retention=RetentionSchedule('synthetic:retention-review',NOW+timedelta(days=1),
        retain_until=tuple((name,None) for name in metadata.tables))
    workflow=QuarantinedFixturePrivacy(db,SQLAccountReader(db,metadata,inventory),old.keyring,
        retention=retention,scope=old.scope)
    workflow.execute(1,request,now=NOW);db.commit()
    workflow.restore(1,request,now=NOW);db.commit();db.expire_all()
    assert db.get(Run,1).status==JobStatus.FAILED
    assert db.get(Run,1).module_cancel_requested and not db.get(Run,1).auto_export_enabled
    assert db.get(AutoRebalanceWorkflow,1).status=='failed'
    assert db.get(AutoRebalanceWorkflow,1).control_version==1
    assert db.get(AutoRebalanceWorkflowStage,1).status=='failed'
    assert db.get(RunJob,1).job_id==1
    assert db.scalar(select(UserModulePreferences.version).where(UserModulePreferences.user_id==1))>9
    assert db.get(Run,2).status==JobStatus.PENDING
    assert db.get(AutoRebalanceWorkflowStage,2).status=='queued'
