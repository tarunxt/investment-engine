"""Current fake acquisition projection on disposable SQL, no provider or live positions."""
from datetime import timedelta
import pytest
from sqlalchemy import select,func
from test_stage18_linked_analysis_preview import linked_env
from test_synthetic_acquisition_journal import setup
from app.domains.runs.analysis_workflows.synthetic_journal import acquire,TOPIC
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied,digest
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.connections.models import IntegrationConnection
from app.uat2.journal_portfolio import current_portfolio,amount
from app.uat2.synthetic_connections import connect

@pytest.mark.parametrize('mode',['user_owned','platform_managed'])
def test_current_exact_source_matches_analysis_both_modes_without_acquisition_or_other_owner(linked_env,mode):
    e=linked_env;scope,analysis=setup(e)
    if mode=='platform_managed':
        prior=e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id==1,IntegrationConnection.is_current.is_(True)))
        connect(e.db,1,mode=mode,key='journal-display-mode',expected_id=prior.id,expected_version=prior.version)
    source=acquire(e.db,1,scope=scope,authorize=analysis.authorize,key='journal-display-source');e.db.commit()
    count=e.db.scalar(select(func.count()).select_from(OutboxMessage))
    view=current_portfolio(e.db,1,analysis)
    assert view['latest']['source_receipt_id']==source['source_receipt_id']
    assert view['latest']['source_hash']==digest(analysis.source(e.db,1,'india'))
    assert view['latest']['holdings'][0]['tradingsymbol']=='SYNTHETIC0'
    assert view['latest']['holdings'][0]['quantity_exact']=='3'
    assert view['latest']['holdings_market_value_exact']=='30.03'
    assert view['latest']['available_margin'] is None
    assert view['latest']['holdings'][0]['average_price'] is None
    assert view['complete_live_portfolio'] is False and view['history_complete'] is False
    assert 'account' not in str(view['latest'].keys())
    with pytest.raises(WorkflowDenied):current_portfolio(e.db,2,analysis)
    assert e.db.scalar(select(func.count()).select_from(OutboxMessage))==count

def test_missing_corrupt_or_changed_connection_never_returns_generic_fixture(linked_env):
    e=linked_env;scope,analysis=setup(e)
    with pytest.raises(WorkflowDenied):current_portfolio(e.db,1,analysis)
    acquire(e.db,1,scope=scope,authorize=analysis.authorize,key='journal-invalid-source');e.db.commit()
    row=e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC))
    original=row.payload;row.payload={**original,'source_hash':'0'*64};e.db.commit()
    with pytest.raises(WorkflowDenied):current_portfolio(e.db,1,analysis)
    row.payload=original;e.db.commit()
    prior=e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id==1,IntegrationConnection.is_current.is_(True)))
    connect(e.db,1,mode='platform_managed',key='journal-reconnect-mode',expected_id=prior.id,expected_version=prior.version);e.db.commit()
    with pytest.raises(WorkflowDenied):current_portfolio(e.db,1,analysis)

def test_display_unknown_price_is_not_zero_and_nonfinite_never_becomes_numeric():
    for value in (None,True,'NaN','Infinity','-1'):assert amount(value) is None
    assert str(amount('0'))=='0'

def test_position_projection_preserves_missing_groups_distinct_from_explicit_empty_and_does_not_change_source_hash():
    from app.uat2.journal_portfolio import project_snapshot
    source={'currency':'INR','source_receipt_id':'synthetic-owned-record','content_hash':'a'*64,'captured_at':'2026-10-26T00:00:00Z','holdings':[{'exchange':'NSE','tradingsymbol':'SYNTHETIC0','quantity':'3','last_price':'10.01'}]}
    view=project_snapshot(source)
    assert view['positions']=={'net':None,'day':None}
    assert view['source_hash']==digest(source)
    explicit={**source,'net_positions':[],'day_positions':[]}
    assert project_snapshot(explicit)['positions']=={'net':[],'day':[]}
    net={**source,'net_positions':[{'tradingsymbol':'SYNTHETIC0','quantity':0,'product':'CNC','m2m':0}]}
    assert project_snapshot(net)['positions']=={'net':net['net_positions'],'day':None}
    with pytest.raises(WorkflowDenied):project_snapshot({**source,'net_positions':None})
    with pytest.raises(WorkflowDenied):project_snapshot({**source,'day_positions':['bad']})


def test_owned_us_dashboard_history_reads_only_accepted_owner_records_with_native_metadata(linked_env):
    import asyncio
    from sqlalchemy.ext.asyncio import create_async_engine,AsyncSession
    from test_stage18_linked_analysis_preview import imported_source
    from app.domains.dashboard.service import _load_indmoney_with_session
    e=linked_env
    accepted=imported_source(e)
    imported_source(e,accept=False)
    async def read():
        engine=create_async_engine('sqlite+aiosqlite:///'+str(e.path))
        try:
            async with AsyncSession(engine) as db:
                own=await _load_indmoney_with_session(db,1)
                other=await _load_indmoney_with_session(db,2)
                assert own.snapshot is not None and other.snapshot is None
                assert len(own.snapshot.history)==1
                point=own.snapshot.history[0]
                assert point.snapshot_id==accepted and point.owner_id==1
                assert point.currency=='USD' and point.metric=='accepted_us_portfolio_value_v1'
                assert point.recorded_value==110 and point.recorded_value_known is True
                assert len(point.import_source_hash)==64 and point.captured_at.utcoffset().total_seconds()==0
        finally:await engine.dispose()
    asyncio.run(read())


def test_us_history_missing_zero_and_lineage_are_distinct_from_legacy_value():
    from types import SimpleNamespace
    from datetime import datetime,UTC
    from app.domains.dashboard.native_history import owned_us_history_point
    base=dict(id=1,supersedes_id=None,owned_supersedes_id=None,import_provenance={'currency':'USD','source_hash':'a'*64},current_value=0,wallet_balance=None,captured_at=datetime(2026,10,26,tzinfo=UTC))
    zero=owned_us_history_point(SimpleNamespace(**base),1)
    assert zero.recorded_value==0 and zero.recorded_value_known
    missing=owned_us_history_point(SimpleNamespace(**{**base,'current_value':None}),1)
    assert missing.recorded_value is None and not missing.recorded_value_known
    legacy=owned_us_history_point(SimpleNamespace(**{**base,'import_provenance':None}),1)
    assert legacy.metric is None and legacy.recorded_value is None
    with pytest.raises(ValueError,match='lineage'):owned_us_history_point(SimpleNamespace(**{**base,'supersedes_id':2}),1)
    for invalid in (-1,float('nan'),float('inf')):
        with pytest.raises(ValueError):owned_us_history_point(SimpleNamespace(**{**base,'current_value':invalid}),1)
