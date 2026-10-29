"""Metadata projection on actual owned stores; no provider or mutation contract."""
from types import SimpleNamespace
from datetime import datetime,timezone
from sqlalchemy import select,func
from test_stage18_linked_analysis_preview import linked_env
from test_synthetic_acquisition_journal import setup
from app.domains.runs.models import Run,AutoRebalanceWorkflow
from app.domains.modules.models import UserModule
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.types import JobStatus
from app.uat2.activity_history import project
from app.infrastructure.database.base import Base
def activity_setup(e):
 Base.metadata.create_all(e.engine)
 return setup(e)

def test_recent_activity_scopes_both_owners_and_never_serializes_body_or_dispatches(linked_env):
 e=linked_env;scope,_=activity_setup(e);binding=SimpleNamespace(scope=scope)
 for owner,market,module,sequence in [(1,'india','zerodha_rebalance',91),(1,'indmoney_us','indmoney_us',92),(2,'india','zerodha_rebalance',93)]:
  e.db.add(Run(user_id=owner,module_id=module,module_version=1,prompt='PRIVATE_SYNTHETIC_BODY api_key=SYNTHETIC_ONLY',prompt_preview='PRIVATE_SYNTHETIC_PREVIEW',status=JobStatus.COMPLETED,auto_export_enabled=False,auto_rebalance_portfolio=market,auto_rebalance_sequence=sequence))
 e.db.commit();before=e.db.scalar(select(func.count()).select_from(OutboxMessage));value=project(e.db,1,binding)
 assert {row['resource_id'] for row in value['items']}=={'91','92'}
 assert all(row['historical_only'] for row in value['items']) and value['complete_account_history'] is False and value['orders_authorized'] is False
 assert 'PRIVATE_SYNTHETIC_BODY' not in str(value) and 'SYNTHETIC_ONLY' not in str(value)
 assert e.db.scalar(select(func.count()).select_from(OutboxMessage))==before

def test_disabled_module_is_not_queried_as_an_empty_history_and_markets_are_distinct(linked_env):
 e=linked_env;scope,_=activity_setup(e);binding=SimpleNamespace(scope=scope)
 e.db.add(Run(user_id=1,module_id='zerodha_rebalance',module_version=1,prompt='synthetic',prompt_preview='synthetic',status=JobStatus.COMPLETED,auto_export_enabled=False,auto_rebalance_portfolio='india',auto_rebalance_sequence=91));e.db.commit()
 selection=e.db.scalar(select(UserModule).where(UserModule.user_id==1,UserModule.module_id=='zerodha_rebalance'));selection.enabled=False;e.db.commit();value=project(e.db,1,binding,portfolio='india')
 assert value['items']==[] and any(row['status']=='not_selected' for row in value['sources']) and value['complete_account_history'] is False
 e.db.rollback()


def test_disabled_optional_stores_are_not_selected_even_when_history_exists(linked_env):
 from sqlalchemy import event
 e=linked_env;scope,_=activity_setup(e);binding=SimpleNamespace(scope=scope)
 for row in e.db.scalars(select(UserModule).where(UserModule.user_id==1)):row.enabled=False
 e.db.commit();statements=[]
 def capture(conn,cursor,statement,parameters,context,many):statements.append(statement.lower())
 event.listen(e.engine,'before_cursor_execute',capture)
 try:value=project(e.db,1,binding)
 finally:event.remove(e.engine,'before_cursor_execute',capture)
 assert all(source['status']=='not_selected' for source in value['sources'] if source['name']=='module_history')
 assert not any('from auto_rebalance_workflows' in sql or 'from runs ' in sql or 'from indmoney_us_portfolio_snapshots' in sql for sql in statements)
 assert value['complete_account_history'] is False


def test_native_install_has_exact_read_only_activity_route():
 from app.uat2.main import app
 from app.domains.modules.coverage import classify_route
 routes=[route for route in app.routes if getattr(route,'path',None)=='/uat2/simulation/activity-history']
 assert len(routes)==1 and routes[0].methods=={'GET'} and routes[0].endpoint.__module__=='app.uat2.activity_history'
 assert classify_route(None,'recent','/uat2/simulation/activity-history',{'GET'},'app.uat2.activity_history') is None


def test_legacy_saved_estimate_coverage_distinguishes_known_zero_from_missing():
 from app.domains.runs.router import _estimated_cost_coverage
 assert _estimated_cost_coverage([])=={'cost_coverage':'unavailable','priced_provider_count':0}
 assert _estimated_cost_coverage([SimpleNamespace(estimated_cost=0)])=={'cost_coverage':'complete','priced_provider_count':1}
 for missing in (None,float('nan'),-1):
  assert _estimated_cost_coverage([SimpleNamespace(estimated_cost=0),SimpleNamespace(estimated_cost=missing)])=={'cost_coverage':'incomplete','priced_provider_count':1}


def test_import_activity_keeps_exact_versions_and_excludes_foreign_raw_source(linked_env):
 from datetime import timedelta
 from app.domains.indmoney_us.import_validation import parse_import
 from app.domains.indmoney_us.schemas import IndMoneyUsPortfolioSnapshotCreateRequest
 from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
 e=linked_env;scope,_=activity_setup(e);now=datetime.now(timezone.utc);rows=[]
 raw='symbol,company_name,currency,quantity,market_price,invested_value,current_value,total_pnl,total_pnl_percent\nSYNUSA,Synthetic Activity Alpha,USD,2,55,100,110,10,10\nSYNUSB,Synthetic Activity Beta,USD,1,25,20,25,5,25\n'
 for owner,offset in ((1,2),(1,0),(2,1)):
  data=parse_import(IndMoneyUsPortfolioSnapshotCreateRequest(raw_text=raw,captured_at=now-timedelta(days=offset),format='csv'))
  assert not data['import_provenance']['errors']
  data['acceptance_state']='accepted';data['accepted_at']=now-timedelta(days=offset)
  row=IndMoneyUsPortfolioSnapshot(user_id=owner,**data);e.db.add(row);rows.append(row)
 e.db.commit();value=project(e.db,1,SimpleNamespace(scope=scope),portfolio='indmoney_us');imports=[row for row in value['items'] if row['kind']=='import']
 assert {row['resource_id'] for row in imports}=={str(row.id) for row in rows[:2]}
 assert {row['source_version'] for row in imports}=={row.content_hash for row in rows[:2]}
 assert all(row['state']=='accepted' and row['time_basis']=='accepted' for row in imports)
 assert 'Synthetic Activity Alpha' not in str(value) and 'raw_text' not in str(value)


import pytest
@pytest.mark.parametrize('status',['paused','partial','failed','completed','unrecognized'])
def test_parent_lifecycle_is_not_replaced_by_finished_child_and_changed_state_rebinds_metadata(linked_env,status):
 e=linked_env;scope,_=activity_setup(e);binding=SimpleNamespace(scope=scope)
 parent=AutoRebalanceWorkflow(user_id=1,module_id='zerodha_rebalance',portfolio='india',sequence=94,label='Synthetic saved parent',status=status,current_stage='technical',control_version=3)
 e.db.add(parent);e.db.add(Run(user_id=1,module_id='zerodha_rebalance',module_version=1,prompt='synthetic',prompt_preview='synthetic',status=JobStatus.COMPLETED,auto_export_enabled=False,auto_rebalance_portfolio='india',auto_rebalance_sequence=94));e.db.commit()
 first=next(row for row in project(e.db,1,binding)['items'] if row['key']=='legacy_research:india:94')
 assert first['state']==('unverified' if status=='unrecognized' else status) and first['source_version']==3
 parent.status='cancelled';parent.control_version=4;e.db.commit()
 second=next(row for row in project(e.db,1,binding)['items'] if row['key']=='legacy_research:india:94')
 assert second['state']=='cancelled' and second['source_version']==4 and second['record_hash']!=first['record_hash']


def test_import_preview_and_quarantine_remain_distinct_from_acceptance(linked_env):
 from app.domains.indmoney_us.import_validation import parse_import
 from app.domains.indmoney_us.schemas import IndMoneyUsPortfolioSnapshotCreateRequest
 from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
 from datetime import timedelta
 e=linked_env;scope,_=activity_setup(e);now=datetime.now(timezone.utc);expected={}
 raw='symbol,company_name,currency,quantity,market_price,invested_value,current_value,total_pnl,total_pnl_percent\nSYNUSA,Synthetic Activity Alpha,USD,2,55,100,110,10,10\nSYNUSB,Synthetic Activity Beta,USD,1,25,20,25,5,25\n'
 for offset,currency in ((0,'USD'),(1,'INR')):
  data=parse_import(IndMoneyUsPortfolioSnapshotCreateRequest(raw_text=raw,captured_at=now-timedelta(minutes=offset),format='csv',currency=currency))
  row=IndMoneyUsPortfolioSnapshot(user_id=1,**data);e.db.add(row);e.db.flush();expected[str(row.id)]=row.acceptance_state
 e.db.commit();assert set(expected.values())=={'preview','quarantined'}
 imports=[row for row in project(e.db,1,SimpleNamespace(scope=scope),portfolio='indmoney_us')['items'] if row['kind']=='import']
 assert {row['resource_id']:row['state'] for row in imports}==expected
 assert all(row['time_basis']=='created' for row in imports)


def test_identical_legacy_sequence_in_both_markets_is_not_merged(linked_env):
 e=linked_env;scope,_=activity_setup(e)
 for market,module in [('india','zerodha_rebalance'),('indmoney_us','indmoney_us')]:
  e.db.add(Run(user_id=1,module_id=module,module_version=1,prompt='Synthetic same-sequence source',prompt_preview='Synthetic same-sequence source',status=JobStatus.COMPLETED,auto_export_enabled=False,auto_rebalance_portfolio=market,auto_rebalance_sequence=97))
 e.db.commit();items=project(e.db,1,SimpleNamespace(scope=scope))['items']
 assert {row['key'] for row in items}=={'legacy_research:india:97','legacy_research:indmoney_us:97'}
 assert len({row['record_hash'] for row in items})==2
