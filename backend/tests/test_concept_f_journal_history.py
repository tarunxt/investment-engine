"""Historical receipt viewing on disposable SQL; current acquisition rules unchanged."""
from datetime import datetime,timezone,timedelta
from types import SimpleNamespace
from uuid import UUID
import pytest
from sqlalchemy import select,func
from test_stage18_linked_analysis_preview import linked_env
from test_synthetic_acquisition_journal import setup
from app.domains.runs.analysis_workflows.synthetic_journal import acquire,TOPIC
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
from app.domains.connections.models import IntegrationConnection
from app.domains.modules.models import UserModule
from app.infrastructure.database.outbox.models import OutboxMessage
from app.uat2.journal_history import history,snapshot
from app.uat2.journal_portfolio import current_portfolio
from app.uat2.synthetic_connections import connect

@pytest.mark.parametrize('mode',['user_owned','platform_managed'])
def test_exact_history_survives_reconnect_without_replacing_current_source_or_dispatching(linked_env,mode):
    e=linked_env;scope,analysis=setup(e);binding=SimpleNamespace(scope=scope,analysis=analysis)
    first=acquire(e.db,1,scope=scope,authorize=analysis.authorize,key='historical-first-source');e.db.commit()
    current=e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id==1,IntegrationConnection.is_current.is_(True)))
    connect(e.db,1,mode=mode,key='historical-reconnect-source',expected_id=current.id,expected_version=current.version);e.db.commit()
    second=acquire(e.db,1,scope=scope,authorize=analysis.authorize,key='historical-second-source');e.db.commit()
    count=e.db.scalar(select(func.count()).select_from(OutboxMessage))
    page=history(e.db,1,binding,limit=1);assert [row['id'] for row in page['items']]==[second['source_receipt_id']] and page['has_more']
    older=history(e.db,1,binding,limit=1,before=page['next_before_sequence']);assert [row['id'] for row in older['items']]==[first['source_receipt_id']]
    record=snapshot(e.db,1,binding,UUID(first['source_receipt_id']));assert record['current_research_ready'] is False and record['orders_authorized'] is False
    assert record['snapshot']['source']=='owned_synthetic_acquisition_journal_history' and record['snapshot']['available_margin'] is None
    assert current_portfolio(e.db,1,analysis)['latest']['source_receipt_id']==second['source_receipt_id']
    assert e.db.scalar(select(func.count()).select_from(OutboxMessage))==count

def test_old_expired_fake_lineage_is_readable_but_never_admitted_as_current_research(linked_env):
    e=linked_env;scope,analysis=setup(e);binding=SimpleNamespace(scope=scope,analysis=analysis);past=datetime.now(timezone.utc)-timedelta(days=3)
    connection=e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id==1,IntegrationConnection.is_current.is_(True)));connection.created_at=past-timedelta(hours=1);e.db.commit()
    receipt=acquire(e.db,1,scope=scope,authorize=analysis.authorize,key='historical-old-source',now=past);e.db.commit()
    connection.token_expires_at=past+timedelta(hours=1);e.db.commit()
    record=snapshot(e.db,1,binding,UUID(receipt['source_receipt_id']));assert record['read_context']=='history' and record['current_research_ready'] is False
    with pytest.raises(WorkflowDenied):current_portfolio(e.db,1,analysis)

def test_missing_foreign_corrupt_or_credential_authority_lineage_never_substitutes_a_source(linked_env):
    e=linked_env;scope,analysis=setup(e);binding=SimpleNamespace(scope=scope,analysis=analysis)
    receipt=acquire(e.db,1,scope=scope,authorize=analysis.authorize,key='historical-integrity-source');e.db.commit();identifier=UUID(receipt['source_receipt_id'])
    # Fully selected second owner still cannot read the first owner's receipt.
    assert e.db.scalar(select(UserModule).where(UserModule.user_id==2,UserModule.module_id=='zerodha_rebalance')).enabled is True
    with pytest.raises(LookupError):snapshot(e.db,2,binding,identifier)
    message=e.db.get(OutboxMessage,identifier);original=message.payload;message.payload={**original,'source_hash':'0'*64};e.db.commit()
    with pytest.raises(WorkflowDenied):snapshot(e.db,1,binding,identifier)
    page=history(e.db,1,binding);assert page['items']==[] and page['rejected_receipts']==1 and identifier.hex not in str(page)
    message.payload=original;e.db.commit();connection=e.db.get(IntegrationConnection,receipt['connection']['id']);connection.credential_ref='synthetic-reference-forbidden';e.db.commit()
    with pytest.raises(WorkflowDenied):snapshot(e.db,1,binding,identifier)
    connection.credential_ref=None;connection.version+=1;e.db.commit()
    with pytest.raises(WorkflowDenied):snapshot(e.db,1,binding,identifier)

@pytest.mark.parametrize('prices,expected', [(['10.01', '2.50'], 40.03), (['0', '0'], 0.0), (['10.01', None], None)])
def test_history_value_matches_exact_captured_projection_without_mutation(linked_env, prices, expected):
    from copy import deepcopy
    from app.domains.runs.analysis_workflows.contracts import digest
    e=linked_env;scope,analysis=setup(e);binding=SimpleNamespace(scope=scope,analysis=analysis)
    receipt=acquire(e.db,1,scope=scope,authorize=analysis.authorize,key='history-value-projection');e.db.commit()
    message=e.db.get(OutboxMessage,UUID(receipt['source_receipt_id']))
    # Disposable prior-format source fixtures; no runtime repair/backfill path.
    source=deepcopy(message.payload['source']);source.pop('price_history',None)
    source['holdings']=[{'exchange':'NSE','tradingsymbol':'FIRST','quantity':3,'last_price':prices[0]},
                        {'exchange':'BSE','tradingsymbol':'SECOND','quantity':4,'last_price':prices[1]}]
    source['content_hash']=digest({k:v for k,v in source.items() if k!='content_hash'})
    message.payload={**deepcopy(message.payload),'source':source,'source_hash':digest(source)};e.db.commit()
    original=deepcopy(message.payload);count=e.db.scalar(select(func.count()).select_from(OutboxMessage))
    listed=history(e.db,1,binding)['items'][0]
    exact=snapshot(e.db,1,binding,message.id)['snapshot']
    assert listed['holdings_market_value']==exact['holdings_market_value']==expected
    assert listed['holdings_market_value_exact']==exact['holdings_market_value_exact']
    assert listed['currency']=='INR' and listed['source_hash']==exact['source_hash']
    assert history(e.db,2,binding)['items']==[]
    assert message.payload==original
    assert e.db.scalar(select(func.count()).select_from(OutboxMessage))==count
