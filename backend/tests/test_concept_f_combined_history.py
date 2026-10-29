"""Disposable source/FX composition; no external prices or hosted claim."""
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
import pytest
from sqlalchemy import select, func
from test_stage18_linked_analysis_preview import linked_env, imported_source
from test_synthetic_acquisition_journal import setup
from app.domains.fx_rates.models import FxRate
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.domains.modules.models import UserModule
from app.domains.modules.lifecycle import ModuleLifecycleDenied
from app.domains.runs.analysis_workflows.synthetic_journal import acquire
from app.infrastructure.database.outbox.models import OutboxMessage
from app.uat2.combined_history import compose, project


def inputs(at):
    return ([{'at': at, 'value': '30.03', 'receipt': {'id': 'owned-india', 'source_hash': 'a'*64}}],
            [{'at': at, 'value': 110, 'receipt': {'id': 4, 'source_hash': 'b'*64}}])


def rate(at, **changes):
    return SimpleNamespace(**{**dict(id=1, base_currency='USD', quote_currency='INR', rate=Decimal('90'),
        source='synthetic-persisted-rate', source_as_of=at-timedelta(hours=1), fetched_at=at,
        verified=True), **changes})


def test_exact_coeval_values_retain_per_point_rate_and_native_receipts():
    from datetime import datetime, timezone
    at=datetime.now(timezone.utc);left,right=inputs(at)
    points=compose(left,right,[rate(at)],now=at)
    assert points[0]['value_exact']=='9930.03' and points[0]['value']==9930.03
    assert points[0]['known'] and not points[0]['reasons']
    assert points[0]['india']==left[0]['receipt'] and points[0]['us']==right[0]['receipt']
    assert points[0]['fx']['id']==1 and points[0]['fx']['rate']=='90'
    # Adding a newer current rate must not rewrite the older observation.
    assert compose(left,right,[rate(at),rate(at,id=2,source_as_of=at+timedelta(seconds=1),rate=Decimal('999'))],now=at+timedelta(hours=1))==points


@pytest.mark.parametrize('case',['missing','stale','future_rate','future_fetch','unverified','wrong_pair','negative','nonfinite','ambiguous','bound'])
def test_missing_invalid_ambiguous_or_truncated_fx_never_becomes_zero_or_backfilled(case):
    from datetime import datetime, timezone
    at=datetime.now(timezone.utc);left,right=inputs(at);rates=[rate(at)]
    changes={'stale':{'source_as_of':at-timedelta(hours=37)},'future_rate':{'source_as_of':at+timedelta(seconds=1)},
        'future_fetch':{'fetched_at':at+timedelta(seconds=1)},'unverified':{'verified':False},
        'wrong_pair':{'base_currency':'EUR'},'negative':{'rate':Decimal('-1')},'nonfinite':{'rate':Decimal('NaN')}}
    if case in changes:rates=[rate(at,**changes[case])]
    if case=='missing':rates=[]
    if case=='ambiguous':rates.append(rate(at,id=2))
    point=compose(left,right,rates,now=at,fx_truncated=case=='bound')[0]
    assert point['value'] is None and point['value_exact'] is None and not point['known'] and point['reasons']


def test_exact_instants_unknowns_duplicates_zero_and_overflow_are_distinct():
    from datetime import datetime, timezone
    at=datetime.now(timezone.utc);left,right=inputs(at)
    right[0]['at']=at+timedelta(microseconds=1)
    points=compose(left,right,[rate(at)],now=at+timedelta(seconds=1))
    assert len(points)==2 and all(not p['known'] for p in points)
    right[0]['at']=at;right[0]['value']=None
    assert 'us_value_unknown' in compose(left,right,[rate(at)],now=at)[0]['reasons']
    right[0]['value']=0;left[0]['value']=0
    assert compose(left,right,[rate(at)],now=at)[0]['value']==0
    assert 'india_source_ambiguous' in compose(left+left,right,[rate(at)],now=at)[0]['reasons']
    assert 'india_source_bound_exceeded' in compose(left,right,[rate(at)],now=at,source_truncated={'india':True})[0]['reasons']
    left[0]['value']='0.00000000000000000000001';right[0]['value']=1
    assert 'combined_value_not_representable' in compose(left,right,[rate(at)],now=at)[0]['reasons']
    left[0]['value']=1e308;right[0]['value']=1e308
    assert 'combined_value_out_of_range' in compose(left,right,[rate(at)],now=at)[0]['reasons']


def test_actual_owner_queries_integrity_module_scope_and_no_mutation(linked_env,monkeypatch):
    e=linked_env;scope,analysis=setup(e);binding=SimpleNamespace(scope=scope,analysis=analysis)
    FxRate.__table__.create(e.engine,checkfirst=True)
    receipt=acquire(e.db,1,scope=scope,authorize=analysis.authorize,key='coeval-history-source',now=e.now)
    imported_source(e)
    e.db.add(FxRate(base_currency='USD',quote_currency='INR',rate=Decimal('90'),source='synthetic-persisted-rate',source_as_of=e.now-timedelta(hours=1),fetched_at=e.now,verified=True));e.db.commit()
    counts=[e.db.scalar(select(func.count()).select_from(model)) for model in (OutboxMessage,IndMoneyUsPortfolioSnapshot,FxRate)]
    result=project(e.db,1,binding,now=e.now)
    assert result['points'][0]['value_exact']=='9930.03'
    assert result['points'][0]['india']['id']==receipt['source_receipt_id']
    assert result['history_complete'] is False and result['orders_authorized'] is False and result['continuity_verified'] is True
    assert project(e.db,2,binding,now=e.now)['points']==[]
    assert receipt['source_receipt_id'] not in str(project(e.db,2,binding,now=e.now))
    assert counts==[e.db.scalar(select(func.count()).select_from(model)) for model in (OutboxMessage,IndMoneyUsPortfolioSnapshot,FxRate)]
    selection=e.db.scalar(select(UserModule).where(UserModule.user_id==1,UserModule.module_id=='indmoney_us'));selection.enabled=False;e.db.commit()
    with pytest.raises((PermissionError,ModuleLifecycleDenied)):project(e.db,1,binding,now=e.now)
    selection.enabled=True;e.db.commit()
    import app.uat2.combined_history as module
    actual=module.compose
    def disable_during_projection(*args,**kwargs):
        selection.enabled=False;e.db.flush()
        return actual(*args,**kwargs)
    monkeypatch.setattr(module,'compose',disable_during_projection)
    with pytest.raises((PermissionError,ModuleLifecycleDenied)):project(e.db,1,binding,now=e.now)



def test_preview_and_corrupt_accepted_us_source_do_not_become_combined_history(linked_env):
    e=linked_env;scope,analysis=setup(e);binding=SimpleNamespace(scope=scope,analysis=analysis)
    FxRate.__table__.create(e.engine,checkfirst=True)
    acquire(e.db,1,scope=scope,authorize=analysis.authorize,key='history-preview-source',now=e.now);e.db.commit()
    identifier=imported_source(e,accept=False)
    assert all(not p['known'] for p in project(e.db,1,binding,now=e.now)['points'])
    # Synthetic fixture corruption bypasses immutable ORM updates deliberately.
    from sqlalchemy import update
    e.db.execute(update(IndMoneyUsPortfolioSnapshot).where(IndMoneyUsPortfolioSnapshot.id==identifier).values(acceptance_state='accepted',content_hash='0'*64));e.db.commit()
    result=project(e.db,1,binding,now=e.now)
    assert result['rejected_sources']['us']==1 and result['continuity_verified'] is False and all(p['us'] is None for p in result['points'])


@pytest.mark.parametrize('foreign_parent',[False,True])
def test_correction_query_retains_owned_lineage_and_rejects_foreign_parent(linked_env,foreign_parent):
    from app.domains.indmoney_us.import_validation import parse_import,CSV_TEMPLATE
    from app.domains.indmoney_us.schemas import IndMoneyUsPortfolioSnapshotCreateRequest
    e=linked_env;scope,analysis=setup(e);binding=SimpleNamespace(scope=scope,analysis=analysis)
    FxRate.__table__.create(e.engine,checkfirst=True)
    acquire(e.db,1,scope=scope,authorize=analysis.authorize,key='history-correction-source',now=e.now);e.db.commit()
    parent=imported_source(e,2 if foreign_parent else 1)
    data=parse_import(IndMoneyUsPortfolioSnapshotCreateRequest(raw_text=CSV_TEMPLATE,captured_at=e.now,format='csv',supersedes_id=parent))
    data.update(acceptance_state='accepted',accepted_at=e.now)
    row=IndMoneyUsPortfolioSnapshot(user_id=1,**data)
    e.db.add(row);e.db.add(FxRate(base_currency='USD',quote_currency='INR',rate=Decimal('90'),source='synthetic-persisted-rate',source_as_of=e.now,fetched_at=e.now,verified=True));e.db.commit()
    result=project(e.db,1,binding,now=e.now)
    if foreign_parent:
        assert result['rejected_sources']['us']==1
        assert all(p['us'] is None and not p['known'] for p in result['points'])
    else:
        assert len(result['points'])==1 and result['points'][0]['known']
        assert result['points'][0]['us']['id']==row.id and result['points'][0]['us']['supersedes_id']==parent


def test_actual_store_bounds_do_not_establish_unique_sources_or_rate_coverage(linked_env,monkeypatch):
    import app.uat2.combined_history as module
    e=linked_env;scope,analysis=setup(e);binding=SimpleNamespace(scope=scope,analysis=analysis)
    FxRate.__table__.create(e.engine,checkfirst=True)
    for index in range(2):
        acquire(e.db,1,scope=scope,authorize=analysis.authorize,key='history-bound-source-'+str(index),now=e.now-timedelta(seconds=index))
        e.db.add(FxRate(base_currency='USD',quote_currency='INR',rate=Decimal('90'),source='synthetic-rate',source_as_of=e.now-timedelta(hours=index+1),fetched_at=e.now,verified=True))
    e.db.commit();imported_source(e)
    monkeypatch.setattr(module,'SOURCE_LIMIT',1)
    result=project(e.db,1,binding,now=e.now)
    assert result['has_more']['india'] and not result['continuity_verified']
    assert all(not p['known'] and 'india_source_bound_exceeded' in p['reasons'] for p in result['points'])
    monkeypatch.setattr(module,'SOURCE_LIMIT',100);monkeypatch.setattr(module,'FX_LIMIT',1)
    result=project(e.db,1,binding,now=e.now)
    assert result['has_more']['fx'] and not result['continuity_verified']
    assert all(not p['known'] and 'fx_bound_exceeded' in p['reasons'] for p in result['points'])


@pytest.mark.parametrize('case',['valid','stale','future','negative','missing'])
def test_native_current_summary_uses_validated_persisted_fx_not_static_fixture(linked_env,case):
    import asyncio
    from sqlalchemy.ext.asyncio import create_async_engine,AsyncSession
    from app.uat2.router import dashboard
    from app.uat2.policy_bindings import install_session_binding
    e=linked_env;scope,_=setup(e);FxRate.__table__.create(e.engine,checkfirst=True)
    imported_source(e)
    if case!='missing':
        at=e.now+timedelta(hours=1) if case=='future' else e.now-timedelta(hours=48 if case=='stale' else 1)
        e.db.add(FxRate(base_currency='USD',quote_currency='INR',rate=Decimal('-1' if case=='negative' else '90'),source='synthetic-persisted-current',source_as_of=at,fetched_at=e.now,verified=True));e.db.commit()
    async def read():
        engine=create_async_engine('sqlite+aiosqlite:///'+str(e.path))
        try:
            async with AsyncSession(engine) as db:
                install_session_binding(db.sync_session,scope)
                result=await dashboard(current_user=SimpleNamespace(id=1),db=db)
                assert result['fx']['status']==('valid' if case=='valid' else 'stale' if case=='stale' else 'unavailable')
                assert result['usd_inr_rate']==(90 if case=='valid' else None)
                assert result['fx']['value']==(90 if case in {'valid','stale'} else None)
                assert result['fx']['source']==('synthetic-persisted-current' if case in {'valid','stale'} else None)
                assert result['indmoney_us']['snapshot']['captured_at'].endswith(('Z','+00:00'))
        finally:await engine.dispose()
    asyncio.run(read())


def test_native_summary_never_reads_fx_when_us_module_is_disabled(linked_env):
    import asyncio
    from sqlalchemy import event
    from sqlalchemy.ext.asyncio import create_async_engine,AsyncSession
    from app.uat2.router import dashboard
    from app.uat2.policy_bindings import install_session_binding
    e=linked_env;scope,_=setup(e)
    selection=e.db.scalar(select(UserModule).where(UserModule.user_id==1,UserModule.module_id=='indmoney_us'));selection.enabled=False;e.db.commit()
    # No FX table is created: an accidental read would fail in addition to the SQL assertion.
    async def read():
        engine=create_async_engine('sqlite+aiosqlite:///'+str(e.path));statements=[]
        event.listen(engine.sync_engine,'before_cursor_execute',lambda connection,cursor,statement,parameters,context,many:statements.append(statement))
        try:
            async with AsyncSession(engine) as db:
                install_session_binding(db.sync_session,scope)
                result=await dashboard(current_user=SimpleNamespace(id=1),db=db)
                assert result['fx']['status']=='unavailable' and result['indmoney_us'] is None
                assert not any('fx_rates' in statement.lower() for statement in statements)
        finally:await engine.dispose()
    asyncio.run(read())
