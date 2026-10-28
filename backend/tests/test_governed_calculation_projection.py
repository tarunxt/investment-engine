"""Actual governed completion with zero legacy Runs; projection never writes."""
from copy import deepcopy
from datetime import timedelta
from decimal import Decimal
import json
import pytest
from sqlalchemy import select,func,event
from sqlalchemy.orm import Session
from app.domains.runs.analysis_workflows.calculation_projection import catalogue,project,MISSING
from app.domains.runs.analysis_workflows.calculation_schema import GovernedEvidence
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied,digest
from app.domains.runs.models import Run,RunJob,AutoRebalanceWorkflow,AutoRebalanceWorkflowStage
from app.domains.jobs.models import Job
from app.domains.connections.models import IntegrationConnection
from test_stage18_linked_analysis_preview import linked_env,complete_analysis

@pytest.mark.parametrize('owner,portfolio',[(1,'india'),(2,'india'),(1,'indmoney_us'),(2,'indmoney_us')])
def test_actual_governed_zero_run_history_is_read_only_and_missing_safe(linked_env,owner,portfolio):
    e=linked_env;RunJob.__table__.create(e.engine,checkfirst=True);receipt=complete_analysis(e,owner,portfolio);e.db.commit()
    assert e.db.scalar(select(func.count()).select_from(Run))==0
    assert e.db.scalar(select(func.count()).select_from(RunJob))==0
    e.db.commit();statements=[]
    def record(conn,cursor,statement,parameters,context,many):statements.append(statement)
    event.listen(e.engine,'before_cursor_execute',record)
    try:
        with e.engine.connect() as connection:
            connection.exec_driver_sql('PRAGMA query_only=ON')
            with Session(connection) as reader:
                listed=catalogue(reader,owner,portfolio);value=project(reader,owner,portfolio,receipt['workflow_id'])
                assert listed['items'][0]['id']==receipt['workflow_id']
                GovernedEvidence.model_validate(value)
                assert not reader.new and not reader.dirty and not reader.deleted
            connection.exec_driver_sql('PRAGMA query_only=OFF')
    finally:event.remove(e.engine,'before_cursor_execute',record)
    assert all(s.lstrip().upper().startswith(('SELECT','PRAGMA')) and 'FOR UPDATE' not in s.upper() for s in statements)
    assert value['orders_authorized'] is False and value['historical'] is True and value['current_readiness']=='not_established'
    assert value['missing_fields']==MISSING and len(value['stages'])==6
    assert len([s for s in value['stages'] if s['state']=='available'])==5
    for stage in value['stages'][1:]:
        assert stage['rows'] and stage['response_hash'] and stage['result_hash']
        for row in stage['rows']:
            assert set(row)=={'id','instrument','action','current_units','final_units','allocation','units_change','units_change_kind'}
    def keys(item):
        if isinstance(item,dict):return set(item)|set().union(*(keys(v) for v in item.values()))
        if isinstance(item,list):return set().union(*(keys(v) for v in item))
        return set()
    assert not {'prompt','response','runtime_metadata_json','request_context_json','execution_json','holdings','connection'} & keys(value)
    for stage in value['stages'][1:]:
        for row in stage['rows']:assert Decimal(row['units_change'])==Decimal(row['final_units'])-Decimal(row['current_units'])

@pytest.mark.parametrize('wrong', ['owner','market','job_owner','checkpoint','job_pointer','request','legacy_pointer','sync_pointer'])
def test_mismatches_fail_closed_without_fallback(linked_env,wrong):
    e=linked_env;receipt=complete_analysis(e);id=receipt['workflow_id']
    if wrong=='owner':
        with pytest.raises(WorkflowDenied):project(e.db,2,'india',id)
        return
    if wrong=='market':
        with pytest.raises(WorkflowDenied):project(e.db,1,'indmoney_us',id)
        return
    stage=e.db.scalar(select(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflowStage.workflow_id==id,AutoRebalanceWorkflowStage.stage=='threats'))
    job=e.db.get(Job,stage.job_id)
    if wrong=='job_owner':job.user_id=2
    elif wrong=='checkpoint':
        value=deepcopy(stage.checkpoint_json);value['result']['owner_id']=2;stage.checkpoint_json=value
    elif wrong=='job_pointer':
        other=e.db.scalar(select(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflowStage.workflow_id==id,AutoRebalanceWorkflowStage.stage=='swing'));other.job_id=job.id
    elif wrong=='legacy_pointer':stage.run_id=123
    elif wrong=='sync_pointer':
        sync=e.db.scalar(select(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflowStage.workflow_id==id,AutoRebalanceWorkflowStage.stage=='sync'));sync.job_id=job.id
    else:job.request_context_json={**job.request_context_json,'source_hash':'0'*64}
    e.db.commit()
    with pytest.raises(WorkflowDenied):project(e.db,1,'india',id)

def test_historical_read_does_not_require_current_connection_or_rewrite_pending_changes(linked_env):
    e=linked_env;receipt=complete_analysis(e);connection=e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id==1));connection.token_expires_at=e.now-timedelta(days=5);e.db.commit()
    job=e.db.scalar(select(Job).where(Job.user_id==1));job.error_message='unsaved caller change';before=set(e.db.dirty)
    value=project(e.db,1,'india',receipt['workflow_id'])
    assert value['current_readiness']=='not_established' and set(e.db.dirty)==before
    e.db.rollback()

def test_incomplete_workflow_has_explicit_stage_states_and_no_substitution(linked_env):
    from app.domains.runs.analysis_workflows.service import Workflows
    from test_stage18_linked_analysis_preview import current_source
    e=linked_env;snapshot=current_source(e);row=Workflows(e.db,e.runtime).create(1,'india','projection-pending',snapshot_id=snapshot,now=e.now);e.db.commit()
    value=project(e.db,1,'india',row.id)
    assert all(stage['state']=='not_completed' and not stage['rows'] for stage in value['stages'])
