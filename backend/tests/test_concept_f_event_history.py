"""Disposable SQL sources; no event scan, web search, providers or live calendar."""
import pytest
from types import SimpleNamespace
from sqlalchemy import select,func
from test_stage18_linked_analysis_preview import linked_env
from test_synthetic_acquisition_journal import setup
from app.domains.jobs.models import Job
from app.domains.modules.models import UserModule
from app.infrastructure.database.outbox.models import OutboxMessage
from app.uat2.event_history import project
from app.shared.types import JobStatus

@pytest.mark.parametrize('portfolio',['india','indmoney_us'])
def test_exact_owned_marked_event_history_excludes_foreign_mixed_and_wrong_market(linked_env,portfolio):
    e=linked_env;scope,_=setup(e);binding=SimpleNamespace(scope=scope)
    module='zerodha_rebalance' if portfolio=='india' else 'indmoney_us';marker='[ZERODHA_EVENTS]' if portfolio=='india' else '[INDMONEY_US_EVENTS]';other='[INDMONEY_US_EVENTS]' if portfolio=='india' else '[ZERODHA_EVENTS]'
    # Existing disposable selection remains the authority; add only the test US selection.
    if not e.db.scalar(select(UserModule).where(UserModule.user_id==1,UserModule.module_id==module)):
        e.db.add(UserModule(user_id=1,module_id=module,enabled=True,version=1,config={'schema_version':1},schedules_paused=True));e.db.commit()
    records=[]
    for owner,prompt,market in [(1,marker,portfolio),(2,marker,portfolio),(1,marker+other,portfolio),(1,marker,'indmoney_us' if portfolio=='india' else 'india')]:
        row=Job(user_id=owner,module_id=module,module_version=1,provider='fake',model='offline',status=JobStatus.COMPLETED,prompt=prompt,response='unstructured synthetic output',auto_rebalance_portfolio=market);e.db.add(row);records.append(row)
    e.db.commit();before=e.db.scalar(select(func.count()).select_from(OutboxMessage))
    value=project(e.db,1,portfolio,binding);assert [row['job_id'] for row in value['items']]==[records[0].id];assert value['scan_started'] is False and value['live_calendar_verified'] is False
    detail=project(e.db,1,portfolio,binding,records[0].id);assert detail['item']['parse_state']=='unparsed_output';assert detail['item']['holdings_coverage_verified'] is False
    for row in records[1:]:
        with pytest.raises(LookupError):project(e.db,1,portfolio,binding,row.id)
    assert e.db.scalar(select(func.count()).select_from(OutboxMessage))==before
    selection=e.db.scalar(select(UserModule).where(UserModule.user_id==1,UserModule.module_id==module));selection.enabled=False;e.db.commit()
    with pytest.raises(Exception,match='denied|module|Module'):project(e.db,1,portfolio,binding)

def test_saved_calendar_missing_unparsed_actual_rows_and_preview_bound_never_invent_current_events(linked_env):
    e=linked_env;scope,_=setup(e);binding=SimpleNamespace(scope=scope)
    row=Job(user_id=1,module_id='zerodha_rebalance',module_version=1,provider='fake',model='offline',status=JobStatus.COMPLETED,prompt='[ZERODHA_EVENTS]',response=None)
    e.db.add(row);e.db.commit()
    assert project(e.db,1,'india',binding,row.id)['item']['parse_state']=='missing_output'
    row.response='| Date | Exchange | Stock Symbol | Stock Name | Event | Why it may matter | Expected Outcome | Status / Source |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 27 Oct 2026 | NSE | SYNTHETIC0 | Synthetic fixture | Results | Test only | Neutral | Synthetic saved source |'
    e.db.commit();item=project(e.db,1,'india',binding,row.id)['item']
    assert item['parse_state']=='parsed_rows' and len(item['table']['rows'])==1
    assert item['table']['rows'][0]['Stock Symbol']=='SYNTHETIC0'
    assert item['holdings_coverage_verified'] is False
    original_version=item['source_version'];row.response=row.response.replace('Results','Revised results');e.db.commit()
    assert project(e.db,1,'india',binding,row.id)['item']['source_version']!=original_version
    row.response='x'*256001;e.db.commit()
    with pytest.raises(OverflowError):project(e.db,1,'india',binding,row.id)

def test_held_filter_requires_explicit_exact_accepted_source_and_read_does_not_acquire(linked_env):
    from app.domains.runs.analysis_workflows.synthetic_journal import acquire
    e=linked_env;scope,analysis=setup(e);binding=SimpleNamespace(scope=scope,analysis=analysis)
    row=Job(user_id=1,module_id='zerodha_rebalance',module_version=1,provider='fake',model='offline',status=JobStatus.COMPLETED,prompt='[ZERODHA_EVENTS]',response='| Date | Exchange | Stock Symbol | Stock Name | Event | Why it may matter | Expected Outcome | Status / Source |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 27 Oct 2026 | NSE | SYNTHETIC0 | Synthetic fixture | Results | Test only | Neutral | Synthetic source |')
    e.db.add(row);e.db.commit();before=e.db.scalar(select(func.count()).select_from(OutboxMessage))
    assert project(e.db,1,'india',binding,row.id)['item']['holding_match']['available'] is False
    assert project(e.db,1,'india',binding,row.id,include_holdings=True)['item']['holding_match']['available'] is False
    assert e.db.scalar(select(func.count()).select_from(OutboxMessage))==before
    acquire(e.db,1,scope=scope,authorize=analysis.authorize,key='event-held-synthetic-preparation');e.db.commit();before=e.db.scalar(select(func.count()).select_from(OutboxMessage))
    match=project(e.db,1,'india',binding,row.id,include_holdings=True)['item']['holding_match']
    assert match['available'] and match['row_indices']==[0] and len(match['source_hash'])==64
    assert e.db.scalar(select(func.count()).select_from(OutboxMessage))==before


def test_us_held_events_use_canonical_symbol_contract_and_never_guess_an_exchange(linked_env):
    from test_stage18_linked_analysis_preview import imported_source
    e=linked_env;scope,analysis=setup(e);binding=SimpleNamespace(scope=scope,analysis=analysis)
    imported_source(e)
    row=Job(user_id=1,module_id='indmoney_us',module_version=1,provider='fake',model='offline',status=JobStatus.COMPLETED,prompt='[INDMONEY_US_EVENTS]',auto_rebalance_portfolio='indmoney_us',response='| Date | Exchange | Stock Symbol | Stock Name | Event | Why it may matter | Expected Outcome | Status / Source |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 27 Oct 2026 | US | UATA | Synthetic Alpha | Results | Test only | Neutral | Synthetic source |\n| 27 Oct 2026 | NASDAQ | UATA | Synthetic Alpha | Results | Test only | Neutral | Synthetic source |\n| 27 Oct 2026 | US | UATB | Synthetic Beta | Results | Test only | Neutral | Synthetic source |')
    e.db.add(row);e.db.commit();before=e.db.scalar(select(func.count()).select_from(OutboxMessage))
    assert project(e.db,1,'indmoney_us',binding,row.id)['item']['holding_match']['available'] is False
    match=project(e.db,1,'indmoney_us',binding,row.id,include_holdings=True)['item']['holding_match']
    assert match['available'] and match['row_indices']==[0] and len(match['source_hash'])==64
    assert 'not live' in match['notice'].lower()
    with pytest.raises(LookupError):project(e.db,2,'indmoney_us',binding,row.id,include_holdings=True)
    assert e.db.scalar(select(func.count()).select_from(OutboxMessage))==before


def test_zero_recorded_us_units_do_not_become_a_held_event_match(linked_env):
    from test_stage18_linked_analysis_preview import imported_source
    from app.domains.indmoney_us.import_validation import CSV_TEMPLATE
    e=linked_env;scope,analysis=setup(e);binding=SimpleNamespace(scope=scope,analysis=analysis)
    zero=CSV_TEMPLATE.split('\n',1)[0]+'\nUATA,Synthetic Alpha,USD,0,55,0,0,0,\n'
    imported_source(e,raw_text=zero)
    row=Job(user_id=1,module_id='indmoney_us',module_version=1,provider='fake',model='offline',status=JobStatus.COMPLETED,prompt='[INDMONEY_US_EVENTS]',auto_rebalance_portfolio='indmoney_us',response='| Date | Exchange | Stock Symbol | Stock Name | Event | Why it may matter | Expected Outcome | Status / Source |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 27 Oct 2026 | US | UATA | Synthetic Alpha | Results | Test only | Neutral | Synthetic source |')
    e.db.add(row);e.db.commit();before=e.db.scalar(select(func.count()).select_from(OutboxMessage))
    match=project(e.db,1,'indmoney_us',binding,row.id,include_holdings=True)['item']['holding_match']
    assert match['available'] and match['row_indices']==[]
    assert len(match['source_hash'])==64 and 'not live' in match['notice'].lower()
    assert e.db.scalar(select(func.count()).select_from(OutboxMessage))==before


@pytest.mark.parametrize('portfolio',['india','indmoney_us'])
def test_event_holding_target_pins_actual_owned_source_version_and_portfolio_key(linked_env,portfolio):
    from test_stage18_linked_analysis_preview import imported_source
    from app.domains.runs.analysis_workflows.synthetic_journal import acquire
    from app.domains.runs.analysis_workflows.contracts import digest
    e=linked_env;scope,analysis=setup(e);binding=SimpleNamespace(scope=scope,analysis=analysis)
    if portfolio=='india':acquire(e.db,1,scope=scope,authorize=analysis.authorize,key='event-exact-holding-source');e.db.commit()
    else:imported_source(e)
    market,symbol,module,marker=('NSE','SYNTHETIC0','zerodha_rebalance','[ZERODHA_EVENTS]') if portfolio=='india' else ('US','UATA','indmoney_us','[INDMONEY_US_EVENTS]')
    row=Job(user_id=1,module_id=module,module_version=1,provider='fake',model='offline',status=JobStatus.COMPLETED,prompt=marker,auto_rebalance_portfolio=portfolio,response='| Date | Exchange | Stock Symbol | Stock Name | Event | Why it may matter | Expected Outcome | Status / Source |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 27 Oct 2026 | '+market+' | '+symbol+' | Synthetic source | Results | Test only | Neutral | Synthetic source |')
    e.db.add(row);e.db.commit();source=analysis.source(e.db,1,portfolio,None);before=e.db.scalar(select(func.count()).select_from(OutboxMessage))
    result=project(e.db,1,portfolio,binding,row.id,include_holdings=True)['item']['holding_match'];target=result['targets'][0]
    assert target['owner_id']==1 and target['portfolio']==portfolio and target['row_index']==0
    assert target['source_hash']==result['source_hash']==digest(source) and target['captured_at']==source['captured_at']
    assert target['source_id']==(source['source_receipt_id'] if portfolio=='india' else str(source['snapshot_id']))
    assert target['source_version']==(digest(source) if portfolio=='india' else source['content_hash'])
    assert target['stock_key']==('INR:NSE:SYNTHETIC0:0' if portfolio=='india' else 'USD::UATA:0')
    assert e.db.scalar(select(func.count()).select_from(OutboxMessage))==before

def test_event_holding_targets_are_bounded_and_foreign_source_is_not_admitted():
    from app.uat2.event_holding_targets import project_holdings
    from app.domains.ai_limits.contracts import BoundaryDenied
    source={'owner_id':1,'currency':'USD','captured_at':'2026-10-26T00:00:00Z','snapshot_id':1,'content_hash':'a'*64,'holdings':[{'symbol':'UATA','quantity':2}]}
    rows=[{'Exchange':'US','Stock Symbol':'UATA'} for _ in range(205)]
    result=project_holdings(source,1,'indmoney_us',rows)
    assert len(result['row_indices'])==205 and len(result['targets'])==200 and result['targets_truncated']
    with pytest.raises(BoundaryDenied):project_holdings(source,2,'indmoney_us',rows)

def test_event_membership_without_supported_exact_source_identity_never_links_latest():
    from app.uat2.event_holding_targets import project_holdings
    source={'owner_id':1,'currency':'INR','captured_at':'2026-10-26T00:00:00Z','snapshot_id':42,'holdings':[{'exchange':'NSE','tradingsymbol':'SYNTHETIC0','quantity':3}]}
    result=project_holdings(source,1,'india',[{'Exchange':'NSE','Stock Symbol':'SYNTHETIC0'}])
    assert result['available'] and result['row_indices']==[0] and result['targets']==[]
    assert 'not established' in result['target_notice']
