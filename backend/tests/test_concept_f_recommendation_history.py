"""Bounded owned persisted history on disposable SQLite, not native PG evidence."""
from types import SimpleNamespace
from datetime import timedelta
import json
import pytest
from sqlalchemy import select,func,event
from test_stage18_linked_analysis_preview import linked_env
from test_synthetic_acquisition_journal import setup
from app.domains.runs.models import FinalActionableHistory as H,Run,RunJob,AutoRebalanceWorkflow
from app.domains.jobs.models import Job
from app.domains.modules.models import UserModule
from app.infrastructure.database.outbox.models import OutboxMessage
from app.uat2.recommendation_history import project

def prepare(e):
    for model in (H,RunJob):model.__table__.create(e.db.get_bind(),checkfirst=True)
    scope,_=setup(e);return SimpleNamespace(scope=scope)

def run(e,owner=1,portfolio='india',stage='rebalance',foreign_job=False):
    row=Run(user_id=owner,prompt='[REBALANCE_FLOW:'+('india' if portfolio=='india' else 'us')+']',prompt_preview='Synthetic retained row',auto_rebalance_portfolio=portfolio,auto_rebalance_label=('India Run' if portfolio=='india' else 'IndMoney US Run')+' 97 ('+stage+' Scan)',auto_export_enabled=False)
    if stage=='technical':row.prompt='## Technical Scan Input Bundle\nMarket: '+('India' if portfolio=='india' else 'US')+' equities'
    e.db.add(row);e.db.flush()
    job=Job(user_id=2 if foreign_job else owner,provider='fake',model='offline',prompt='PRIVATE_SOURCE_BODY',response='PRIVATE_SOURCE_OUTPUT');e.db.add(job);e.db.flush();e.db.add(RunJob(run_id=row.id,job_id=job.id));e.db.flush();return row

def history(e,source,**extra):
    row=H(user_id=1,rebalance_run_id=source.id,market='india' if source.auto_rebalance_portfolio=='india' else 'us',stock_symbol='ALPHA',covered_at=e.now,action='Buy New',score=0,consensus_numerator=0,consensus_denominator=2,historical_current_units=0,historical_current_value=0,action_units=1,amount=0,formula_version='saved-v1',source_run_ids_json=[],formula_inputs_json={'PRIVATE_FORMULA':'x'*10000},snapshot_json={'PRIVATE_SNAPSHOT':'y'*10000},**extra);e.db.add(row);e.db.flush();return row

@pytest.mark.parametrize('portfolio',['india','indmoney_us'])
def test_persisted_columns_preserve_zero_and_exact_sources_without_raw_bodies(linked_env,portfolio):
    e=linked_env;b=prepare(e);source=run(e,portfolio=portfolio);technical=run(e,portfolio=portfolio,stage='technical');row=history(e,source,technical_scan_run_id=technical.id);e.db.commit()
    before=e.db.scalar(select(func.count()).select_from(OutboxMessage));statements=[]
    def observed(_c,_u,statement,_params,_context,_many):statements.append(statement)
    event.listen(e.db.get_bind(),'before_cursor_execute',observed)
    try:value=project(e.db,1,portfolio,b,'ALPHA')
    finally:event.remove(e.db.get_bind(),'before_cursor_execute',observed)
    item=value['items'][0];assert item['id']==row.id and item['score']==0 and item['historical_current_value']==0 and item['historical_current_units']==0
    assert item['source_run_ids']==sorted([source.id,technical.id]);assert len(item['record_version'])==64
    assert item['exchange_binding_verified'] is False and item['snapshot_binding_verified'] is False
    assert all('formula_inputs_json' not in statement and 'snapshot_json' not in statement and 'jobs.response' not in statement for statement in statements)
    assert 'PRIVATE_' not in json.dumps(value,default=str)
    assert e.db.scalar(select(func.count()).select_from(OutboxMessage))==before
    assert project(e.db,2,portfolio,b,'ALPHA')['items']==[]
    selected=e.db.scalar(select(UserModule).where(UserModule.user_id==1,UserModule.module_id==('zerodha_rebalance' if portfolio=='india' else 'indmoney_us')));selected.enabled=False;e.db.commit()
    with pytest.raises(Exception):project(e.db,1,portfolio,b,'ALPHA')

def test_related_foreign_mixed_wrong_stage_and_opaque_oversized_sources_withheld(linked_env):
    e=linked_env;b=prepare(e);sources=[run(e),run(e,owner=2),run(e,foreign_job=True),run(e,portfolio='indmoney_us'),run(e,stage='technical'),run(e),run(e)]
    rows=[]
    for source in sources:
        row=history(e,source);row.market='india';rows.append(row)
    rows[-2].source_run_ids_json=[sources[1].id]
    rows[-1].source_run_ids_json=list(range(1,18))
    e.db.commit();value=project(e.db,1,'india',b,'NSE:ALPHA')
    assert [row['id'] for row in value['items']]==[rows[0].id]
    assert value['withheld_records']==6 and value['requested_symbol']=='NSE:ALPHA'
    assert 'PRIVATE_' not in json.dumps(value,default=str)

def test_withheld_page_cursor_advances_and_recorded_coverage_is_not_current_formula(linked_env):
    e=linked_env;b=prepare(e);rows=[]
    for index,state in enumerate(['suggested','not_mentioned','run_failed','parse_failed']):
        source=run(e);row=history(e,source,coverage_status=state);row.covered_at=e.now-timedelta(days=index);rows.append(row)
    # Newest owned projection with a broken related job cannot become a successful empty page.
    source=run(e,foreign_job=True);bad=history(e,source);bad.covered_at=e.now+timedelta(days=1);e.db.commit()
    first=project(e.db,1,'india',b,'ALPHA',limit=1);assert first['items']==[] and first['withheld_records']==1 and first['has_more']
    cursor=first['next_cursor'];seen=[]
    for _ in range(4):
        page=project(e.db,1,'india',b,'ALPHA',limit=1,cursor=cursor);seen.extend(row['coverage_status'] for row in page['items']);cursor=page['next_cursor']
    assert seen==['suggested','not_mentioned','run_failed','parse_failed'];assert cursor is None
    with pytest.raises(ValueError):project(e.db,1,'india',b,'ALPHA',cursor='bad!')
    version=project(e.db,1,'india',b,'ALPHA')['items'][0]['record_version']
    rows[0].score=1;e.db.commit();assert project(e.db,1,'india',b,'ALPHA')['items'][0]['record_version']!=version

def test_original_bounded_paths_are_market_scoped_in_browser_manifest():
    from app.domains.modules.presentation import presentation_manifest
    rules=presentation_manifest()['api_rules']
    for category in ('buy-threshold','recommendation-history'):
        for portfolio,module in [('india','zerodha_rebalance'),('indmoney_us','indmoney_us')]:
            matching=[row for row in rules if row['path']=='/uat2/simulation/'+category+'/'+portfolio]
            assert len(matching)==1 and matching[0]['module_ids']==[module] and matching[0]['capability']=='view'

def test_foreign_workflow_and_missing_source_job_are_withheld_without_detail_leak(linked_env):
    e=linked_env;b=prepare(e);source=run(e)
    foreign=AutoRebalanceWorkflow(user_id=2,portfolio='india',sequence=501,label='PRIVATE_FOREIGN_WORKFLOW',request_key='synthetic-foreign-history')
    e.db.add(foreign);e.db.flush();row=history(e,source,workflow_id=foreign.id);e.db.commit()
    value=project(e.db,1,'india',b,'ALPHA');assert value['items']==[] and value['withheld_records']==1
    row.workflow_id=None;e.db.add(RunJob(run_id=source.id,job_id=999999));e.db.commit()
    value=project(e.db,1,'india',b,'ALPHA');assert value['items']==[] and value['withheld_records']==1
    assert 'PRIVATE_' not in json.dumps(value,default=str)

def test_native_history_get_routes_authenticate_before_read(monkeypatch):
    from test_uat2_native_route_order import first
    from app.uat2.main import app
    from fastapi.testclient import TestClient
    monkeypatch.setenv('CREDX_UAT2','1');client=TestClient(app,raise_server_exceptions=False)
    try:
        for portfolio in ('india','indmoney_us'):
            path='/uat2/simulation/recommendation-history/'+portfolio
            assert first(path,'GET')[0].endpoint.__module__=='app.uat2.recommendation_history'
            assert client.get(path,params={'symbol':'ALPHA'}).status_code==401
    finally:client.close()
    assert app.dependency_overrides=={}
