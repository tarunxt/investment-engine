"""Durable progress/retry boundaries over disposable SQL, never live providers."""
from datetime import timedelta
from dataclasses import replace
import pytest
from sqlalchemy import select
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied,PermanentAnalysisError
from app.shared.exceptions import ConflictException
from app.domains.ai_limits.runner import FakeProvider
from app.domains.jobs.models import Job
from app.domains.runs.models import AutoRebalanceWorkflow
from app.infrastructure.database.outbox.models import OutboxMessage
from test_stage12_durable_analysis import env,create,service,message,NOW
from test_stage18_linked_analysis_preview import linked_env,first_job

def test_read_progress_is_durable_and_delayed_pre_cancel_rank_is_lower(env):
    row=create(env)
    before=service(env).detail(1,row.id)
    assert before['progress']['created_at'] and before['request_key']==row.request_key
    service(env).consume(message(env).id,now=NOW);env.db.commit()
    running=service(env).detail(1,row.id)
    service(env).control(1,row.id,'cancel',0);env.db.commit()
    stopped=service(env).detail(1,row.id)
    assert stopped['progress']['progress_rank']>running['progress']['progress_rank']
    assert stopped['progress']['display_state']=='cancelled'
    assert not any(stopped['progress']['actions'].values())
    assert len(stopped['stages'])==6 and all('updated_at' in stage for stage in stopped['stages'])
    assert row.execution_json['orders_authorized'] is False

@pytest.mark.parametrize('kind',['source_partial','invalid_input','budget_stop','policy_stopped'])
def test_typed_failure_is_distinct_and_not_blindly_retried(env,kind):
    row=create(env)
    def denied(*args):
        error=PermanentAnalysisError('Synthetic typed failure');error.failure_kind=kind;raise error
    runtime=replace(env.runtime,adapter=denied)
    assert Workflows(env.db,runtime).consume(message(env).id,now=NOW)=='failed';env.db.commit()
    detail=Workflows(env.db,runtime).detail(1,row.id)
    assert detail['progress']['display_state']==kind
    assert detail['progress']['actions']['retry'] is False
    before=len(list(env.db.scalars(select(OutboxMessage))))
    with pytest.raises((WorkflowDenied,ConflictException)):Workflows(env.db,runtime).control(1,row.id,'retry',0)
    assert len(list(env.db.scalars(select(OutboxMessage))))==before

def test_actual_unknown_spend_stops_stage_retry_without_second_provider_call(linked_env,monkeypatch):
    env=linked_env;row,event=first_job(env);calls=[]
    original=FakeProvider.generate
    def lost(self,*args,**kwargs):calls.append('accepted-fake-call');raise TimeoutError('Synthetic response loss')
    monkeypatch.setattr(FakeProvider,'generate',lost)
    with pytest.raises(TimeoutError):env.preview.publish_governed_job(env.db,event.payload['job_id'],event.id,now=env.now)
    env.db.rollback();monkeypatch.setattr(FakeProvider,'generate',original)
    # Re-delivery observes the reservation. It cannot call the fake provider again.
    env.preview.publish_governed_job(env.db,event.payload['job_id'],event.id,now=env.now);env.db.commit()
    env.now+=timedelta(seconds=6);env.preview.advance(env.db,now=env.now);env.db.commit()
    detail=Workflows(env.db,env.runtime).detail(1,row.id)
    assert calls==['accepted-fake-call']
    assert detail['progress']['unresolved_spend'] is True
    assert detail['progress']['display_state']=='unknown_spend'
    assert detail['progress']['actions']['retry'] is False
    before=[len(list(env.db.scalars(select(model)))) for model in (Job,OutboxMessage)]
    with pytest.raises((WorkflowDenied,ConflictException)):Workflows(env.db,env.runtime).control(1,row.id,'retry',row.control_version)
    assert before==[len(list(env.db.scalars(select(model)))) for model in (Job,OutboxMessage)]

def test_actual_input_cap_is_budget_stop_and_never_calls_provider(linked_env,monkeypatch):
    env=linked_env;row,event=first_job(env);calls=[]
    governance=replace(env.runtime.governance,limits=replace(env.runtime.governance.limits,max_input_tokens=1))
    limited=replace(env.runtime,governance=governance)
    monkeypatch.setattr(env.preview.analysis,'runtime',limited)
    monkeypatch.setattr(FakeProvider,'generate',lambda *args,**kwargs:calls.append('forbidden'))
    env.preview.publish_governed_job(env.db,event.payload['job_id'],event.id,now=env.now);env.db.commit()
    env.now+=timedelta(seconds=6);env.preview.advance(env.db,now=env.now);env.db.commit()
    detail=Workflows(env.db,limited).detail(1,row.id)
    assert calls==[] and detail['progress']['display_state']=='budget_stop'
    assert detail['progress']['actions']['retry'] is False

@pytest.mark.parametrize('kind',['invalid_input','source_partial','policy_stopped','budget_stop'])
def test_nonretryable_failure_cannot_be_laundered_through_pause_resume(env,kind):
    row=create(env)
    def denied(*args):
        error=PermanentAnalysisError('Synthetic nonretryable failure');error.failure_kind=kind;raise error
    runtime=replace(env.runtime,adapter=denied)
    Workflows(env.db,runtime).consume(message(env).id,now=NOW);env.db.commit()
    before=len(list(env.db.scalars(select(OutboxMessage))))
    for action in ['pause','resume','retry']:
        with pytest.raises((ConflictException,WorkflowDenied)):Workflows(env.db,runtime).control(1,row.id,action,row.control_version)
    assert row.status=='failed' and row.control_version==0
    assert len(list(env.db.scalars(select(OutboxMessage))))==before
