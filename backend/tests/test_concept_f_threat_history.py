"""Actual legacy parser on owned disposable records; no scan/provider publication."""
import pytest
from types import SimpleNamespace
from sqlalchemy import select,func
from test_stage18_linked_analysis_preview import linked_env
from test_synthetic_acquisition_journal import setup
from app.domains.jobs.models import Job
from app.domains.modules.models import UserModule
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.types import JobStatus
from app.uat2.threat_history import project,MARKERS
from app.domains.public_service.redaction import redact,redact_source_text
BODY='## Summary\n- Main portfolio risk in one sentence: Synthetic concentration only\n\n## Table 3: Stock-Level Threat Map\n| Stock Symbol | Threat | Severity |\n| --- | --- | --- |\n| SYNTHETIC0 | Synthetic source risk | High |\n'
@pytest.mark.parametrize('portfolio',['india','indmoney_us'])
def test_owned_market_marker_pagination_parser_and_no_dispatch(linked_env,portfolio):
 e=linked_env;scope,_=setup(e);binding=SimpleNamespace(scope=scope);module='zerodha_rebalance' if portfolio=='india' else 'indmoney_us';other='indmoney_us' if portfolio=='india' else 'india';rows=[]
 for owner,prompt,market in [(1,MARKERS[portfolio],portfolio),(1,MARKERS[portfolio],portfolio),(2,MARKERS[portfolio],portfolio),(1,MARKERS[portfolio]+MARKERS[other],portfolio),(1,MARKERS[portfolio],other),(1,'Quoted source '+MARKERS[portfolio],portfolio)]:
  row=Job(user_id=owner,module_id=module,module_version=1,provider='fake',model='offline',status=JobStatus.COMPLETED,prompt=prompt,response=BODY,auto_rebalance_portfolio=market);e.db.add(row);rows.append(row)
 e.db.commit();before=e.db.scalar(select(func.count()).select_from(OutboxMessage));first=project(e.db,1,portfolio,binding,limit=1);assert first['items'][0]['job_id']==rows[1].id and first['has_more'];older=project(e.db,1,portfolio,binding,limit=1,before=first['next_before_job_id']);assert older['items'][0]['job_id']==rows[0].id and not older['has_more']
 value=project(e.db,1,portfolio,binding,rows[0].id);item=value['item'];assert item['parse_state']=='parsed_report' and item['report']['tables'][0]['rows'][0]['Stock Symbol']=='SYNTHETIC0';assert value['current_risk_verified'] is False and value['orders_authorized'] is False and value['scan_started'] is False
 for row in rows[2:]:
  with pytest.raises(LookupError):project(e.db,1,portfolio,binding,row.id)
 assert e.db.scalar(select(func.count()).select_from(OutboxMessage))==before
 selection=e.db.scalar(select(UserModule).where(UserModule.user_id==1,UserModule.module_id==module));selection.enabled=False;e.db.commit()
 with pytest.raises(Exception,match='denied|module|Module'):project(e.db,1,portfolio,binding,rows[0].id)

def test_missing_failed_partial_malformed_redacted_and_changed_sources_never_become_current_risk(linked_env):
 e=linked_env;scope,_=setup(e);binding=SimpleNamespace(scope=scope);row=Job(user_id=1,module_id='zerodha_rebalance',module_version=1,provider='fake',model='offline',status=JobStatus.COMPLETED,prompt=MARKERS['india'],response=None);e.db.add(row);e.db.commit()
 assert project(e.db,1,'india',binding,row.id)['item']['parse_state']=='missing_output'
 row.response='unstructured source';e.db.commit();first=project(e.db,1,'india',binding,row.id)['item'];assert first['parse_state']=='unparsed_output'
 row.response=BODY;row.status=JobStatus.PARTIAL;e.db.commit();second=project(e.db,1,'india',binding,row.id)['item'];assert second['parse_state']=='partial_report' and second['source_version']!=first['source_version']
 row.status=JobStatus.FAILED;e.db.commit();assert project(e.db,1,'india',binding,row.id)['item']['parse_state']=='failed'
 row.status=JobStatus.COMPLETED;row.response=BODY+'\napi_key=SYNTHETIC-ONLY';e.db.commit();redacted=project(e.db,1,'india',binding,row.id)['item'];assert redacted['source_redacted'] and 'SYNTHETIC-ONLY' not in str(redacted)
 row.prompt=MARKERS['india']+'\n[THREAT_SNAPSHOT_DATE=2026-99-99]';e.db.commit();assert project(e.db,1,'india',binding,row.id)['item']['source_metadata_verified'] is False
 row.response='😀'*64001;e.db.commit()
 with pytest.raises(OverflowError):project(e.db,1,'india',binding,row.id)

def test_bounded_source_redaction_retains_existing_log_bound_and_catches_late_assignments():
 clean='Synthetic risk source. '*4000;assert len(clean)>65536
 assert redact(clean)=='[redacted]' and redact_source_text(clean)==clean
 value=redact_source_text(clean+'\napi_key=SYNTHETIC-ONLY');assert 'SYNTHETIC-ONLY' not in value and '[redacted]' in value
 assert redact_source_text('😀'*64001) is None

def test_all_ten_source_tables_and_summary_fields_survive_without_holding_or_quote_injection(linked_env):
 from app.domains.zerodha.threats import THREAT_TABLE_SPECS,SUMMARY_FIELD_LABELS
 e=linked_env;scope,_=setup(e);binding=SimpleNamespace(scope=scope)
 body='## Summary\n'+'\n'.join('- '+label+': Synthetic '+key for key,label in SUMMARY_FIELD_LABELS)+'\n\n'
 body+='\n\n'.join('## '+title+'\n| Stock Symbol | Source Note |\n| --- | --- |\n| SYNTHETIC0 | Exact source '+key+' |' for key,title in THREAT_TABLE_SPECS)
 row=Job(user_id=1,module_id='zerodha_rebalance',module_version=1,provider='fake',model='offline',status=JobStatus.COMPLETED,prompt=MARKERS['india'],response=body);e.db.add(row);e.db.commit()
 result=project(e.db,1,'india',binding,row.id);report=result['item']['report']
 assert [table['key'] for table in report['tables']]==[key for key,_ in THREAT_TABLE_SPECS]
 for table in report['tables']:
  assert table['columns']==['Stock Symbol','Source Note'] and table['rows']==[{'Stock Symbol':'SYNTHETIC0','Source Note':'Exact source '+table['key']}]
 assert all(report['summary'][key]=='Synthetic '+key for key,_ in SUMMARY_FIELD_LABELS)
 assert result['holdings_relationship_verified'] is False and result['current_risk_verified'] is False
