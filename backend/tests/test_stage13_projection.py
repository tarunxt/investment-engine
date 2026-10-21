"""Independent P2 regression: actual frozen facts, never a declared hash label."""
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta,timezone
from types import SimpleNamespace
import json
import pytest
from sqlalchemy import select
from app.domains.jobs.models import Job
from app.domains.ai_limits.jobs import execute_governed_job,recommendation_source
from app.domains.ai_limits.projection import frozen_projection
from app.domains.ai_limits.contracts import BoundaryDenied,digest
from app.domains.recommendation_audit.models import SpendAttempt
from app.domains.runs.analysis_workflows.adapters import QueuedAI
from app.shared.types import JobStatus
from test_stage13_governed_jobs import env,governed,first_job,NOW
from test_stage12_durable_analysis import service,message


def frozen(raw=None,*,module='indmoney_us',portfolio='indmoney_us'):
    raw=deepcopy(raw if raw is not None else {'owner_id':1,'currency':'USD','captured_at':NOW.isoformat(),'holdings':{'US:TEST':'10'}})
    return SimpleNamespace(user_id=1,module_id=module,portfolio=portfolio,execution_json={'source':raw,'source_hash':digest(raw)})


def test_original_10_to_999_reproduction_rejected_before_provider_or_reservation(env):
    e=env;e.states[1]['holdings']={'US:TEST':'10'}
    rt,providers=governed(e,source_change={'holdings':{'US:TEST':'999'}},document_change={'recommendations':[{'instrument':'US:TEST','action':'hold','current_units':'999','final_units':'999','allocation':'.1'}]})
    row,job=first_job(e,rt);assert row.execution_json['source']['holdings']=={'US:TEST':'10'}
    with pytest.raises(BoundaryDenied,match='PROJECTION_MISMATCH'):execute_governed_job(e.db,job.id,rt,now=NOW)
    assert not providers and not e.db.scalars(select(SpendAttempt)).all()
    assert job.status!=JobStatus.COMPLETED and job.response is None


@pytest.mark.parametrize('change',[
    {'holdings':{'US:TEST':'9'}},
    {'holdings':{'US:TEST':'10','US:OTHER':'0'}},
    {'holdings':{}},
    {'captured_at':NOW+timedelta(seconds=1)},
    {'currency':'INR'},
    {'foreign_context':'synthetic owner2 private context'},
])
def test_resolver_mutations_with_valid_old_hash_are_rejected(env,change):
    e=env;rt,providers=governed(e,source_change=change);row,job=first_job(e,rt)
    with pytest.raises(BoundaryDenied):execute_governed_job(e.db,job.id,rt,now=NOW)
    assert not providers and not e.db.scalars(select(SpendAttempt)).all()


@pytest.mark.parametrize('field',['holdings','currency','captured_at'])
def test_resolver_cannot_fill_a_missing_frozen_fact(env,field):
    e=env;rt,providers=governed(e);del e.states[1][field]
    row,job=first_job(e,rt)
    with pytest.raises(BoundaryDenied,match='FROZEN'):execute_governed_job(e.db,job.id,rt,now=NOW)
    assert not providers


@pytest.mark.parametrize('forge_response',[False,True])
def test_checkpoint_rejects_projection_change_even_with_matching_output_hash(env,forge_response):
    e=env;rt,providers=governed(e);row,job=first_job(e,rt)
    assert execute_governed_job(e.db,job.id,rt,now=NOW)['status']=='completed'
    source=rt.governance.source
    def changed(*args):return {**source(*args),'holdings':{'US:TEST':'999'}}
    governance=replace(rt.governance,source=changed);changed_runtime=replace(rt,governance=governance,adapter=QueuedAI(governance))
    if forge_response:
        document=json.loads(job.response);document['recommendations'][0].update(current_units='999',final_units='999')
        job.response=json.dumps(document)
        job.runtime_metadata_json={**job.runtime_metadata_json,'guardrails':{**job.runtime_metadata_json['guardrails'],'output_hash':digest(document)}};e.db.commit()
    with pytest.raises(BoundaryDenied,match='PROJECTION_MISMATCH'):execute_governed_job(e.db,job.id,changed_runtime,now=NOW)
    assert service(e,changed_runtime).consume(message(e,NOW+timedelta(seconds=6)).id,now=NOW+timedelta(seconds=6))=='failed';e.db.commit()
    detail=service(e,changed_runtime).detail(1,row.id)
    assert detail['status']=='partial' and detail['stages'][1]['status']=='failed'
    assert sum(p.calls for p in providers)==1


@pytest.mark.parametrize('flip_at',[2,3])
def test_resolver_rechecked_after_admission_and_after_response(env,flip_at):
    e=env;rt,providers=governed(e);source=rt.governance.source;calls=[]
    def changed(*args):
        calls.append(1);value=source(*args)
        return {**value,'holdings':{'US:TEST':'999'}} if len(calls)>=flip_at else value
    governance=replace(rt.governance,source=changed);rt=replace(rt,governance=governance,adapter=QueuedAI(governance));row,job=first_job(e,rt)
    with pytest.raises(BoundaryDenied,match='PROJECTION_MISMATCH'):execute_governed_job(e.db,job.id,rt,now=NOW)
    assert sum(p.calls for p in providers)==(0 if flip_at==2 else 1)
    assert job.status!=JobStatus.COMPLETED and job.response is None
    assert e.db.scalar(select(SpendAttempt)).status==('uncertain' if flip_at==2 else 'settled')


@pytest.mark.parametrize('shape',['mapping','us_rows'])
def test_consistent_frozen_sources_accept_equivalent_quantity_and_timezone(env,shape):
    e=env;rt,providers=governed(e,source_change={'holdings':{'US:TEST':'10.000'},'captured_at':NOW.astimezone(timezone(timedelta(hours=5,minutes=30)))})
    if shape=='us_rows':e.states[1]['holdings']=[{'symbol':'TEST','quantity':10.0,'currency':'USD','company_name':'Synthetic Company'}]
    row,job=first_job(e,rt)
    projected=recommendation_source(e.db,row,job,rt.governance,NOW)
    assert projected['holdings']=={'US:TEST':'1e1'} and projected['captured_at']==NOW
    assert execute_governed_job(e.db,job.id,rt,now=NOW)['status']=='completed'
    assert service(e,rt).consume(message(e,NOW+timedelta(seconds=6)).id,now=NOW+timedelta(seconds=6))=='completed';e.db.commit()


@pytest.mark.parametrize('actual,claimed',[
    ('1.00000000000000000000000000001','1'),
    ('0.30000000000000004','.3'),
    ('10.000000000000000000000000001','10'),
])
def test_exact_precision_cannot_be_rounded_in_resolver(env,actual,claimed):
    e=env;e.states[1]['holdings']={'US:TEST':actual}
    rt,providers=governed(e,source_change={'holdings':{'US:TEST':claimed}});row,job=first_job(e,rt)
    with pytest.raises(BoundaryDenied,match='PROJECTION_MISMATCH'):execute_governed_job(e.db,job.id,rt,now=NOW)
    assert not providers


@pytest.mark.parametrize('rows',[
    [{'symbol':'TEST','quantity':5},{'symbol':'TEST','quantity':5}],
    [{'symbol':'TEST','quantity':True}],
    [{'symbol':'TEST','quantity':float('inf')}],
    [{'symbol':'TEST'}],
    [{'symbol':'TEST','quantity':10,'currency':'EUR'}],
])
def test_ambiguous_nonfinite_and_incomplete_frozen_holdings_rejected(rows):
    raw={'owner_id':1,'currency':'USD','captured_at':NOW.isoformat(),'holdings':rows}
    with pytest.raises(BoundaryDenied):frozen_projection(frozen(raw))


def test_real_india_shape_projection_is_exact_without_activating_acquisition():
    raw={'owner_id':1,'portfolio':'india','currency':'INR','captured_at':NOW.isoformat(),'holdings':[
        {'exchange':'NSE','tradingsymbol':'TEST','quantity':10,'average_price':100},
        {'exchange':'BSE','tradingsymbol':'TEST','quantity':2}],
        'connection':{'id':'synthetic','version':7},'net_positions':[],'day_positions':[]}
    row=frozen(raw,module='zerodha_rebalance',portfolio='india')
    assert frozen_projection(row)['holdings']=={'BSE:TEST':'2e0','NSE:TEST':'1e1'}
    row.execution_json['source']['holdings'][0]['quantity']=999
    with pytest.raises(BoundaryDenied,match='INTEGRITY'):frozen_projection(row)


def test_mapping_order_zero_and_exact_decimal_equivalence():
    row=frozen({'owner_id':1,'currency':'USD','captured_at':NOW.isoformat(),'holdings':{'US:B':'0.000','US:A':'10.000'}})
    assert frozen_projection(row)['holdings']=={'US:A':'1e1','US:B':'0'}
