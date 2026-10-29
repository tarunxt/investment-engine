"""Request-session FX reads/projection; disposable SQLite, not hosted or provider proof."""
from datetime import datetime,timedelta,timezone
from decimal import Decimal
from dataclasses import replace
import json
from types import SimpleNamespace
import pytest
import app.infrastructure.database.all_models
from sqlalchemy.ext.asyncio import create_async_engine,AsyncSession,async_sessionmaker
import app.domains.fx_rates.service as fx_service
from app.domains.fx_rates.models import FxRate
from app.domains.fx_rates.service import assess_persisted_fx_rate,read_persisted_usd_inr_rate
from app.domains.fx_rates.cost_read import read_cost_fx,cost_fx_projection
from app.domains.public_service.router import cost_fx

NOW=datetime(2026,10,26,12,tzinfo=timezone.utc)

@pytest.mark.asyncio
async def test_cost_fx_uses_verified_persisted_rows_and_current_owner_envelope(tmp_path,monkeypatch):
    engine=create_async_engine('sqlite+aiosqlite:///'+str(tmp_path/'fx.sqlite'))
    try:
        async with engine.begin() as connection:await connection.run_sync(FxRate.__table__.create)
        async with AsyncSession(engine) as db:
            empty=await read_cost_fx(db,1,now=NOW);assert empty['fx']['status']=='unavailable' and empty['fx']['value'] is None
            db.add_all([FxRate(base_currency='USD',quote_currency='INR',rate=Decimal('83.25'),source='synthetic-cost-fx',source_as_of=NOW-timedelta(hours=1),fetched_at=NOW,verified=True),FxRate(base_currency='USD',quote_currency='INR',rate=Decimal('999'),source='unverified-must-not-win',source_as_of=NOW,fetched_at=NOW,verified=False)])
            await db.commit();assessment=await read_persisted_usd_inr_rate(db,now=NOW)
            assert assessment.value==83.25 and assessment.source=='synthetic-cost-fx'
            monkeypatch.setattr(fx_service,'AsyncSessionLocal',async_sessionmaker(engine,expire_on_commit=False))
            assert await fx_service.load_persisted_usd_inr_rate(now=NOW)==assessment
            value=await read_cost_fx(db,2,now=NOW);assert value['owner_id']==2 and value['provider_contacted'] is False
            assert value['fx']['status']=='valid' and value['fx']['age_seconds']==3600
            response=await cost_fx(user=SimpleNamespace(id=2),db=db)
            body=json.loads(response.body);assert body['owner_id']==2
            assert response.headers['cache-control']=='private, no-store'
            assert 'billing' in body['notice']
    finally:await engine.dispose()

@pytest.mark.parametrize('value,source,as_of',[(Decimal('0'),'synthetic',NOW),(Decimal('-1'),'synthetic',NOW),(Decimal('NaN'),'synthetic',NOW),(Decimal('Infinity'),'synthetic',NOW),(Decimal('1'),' ',NOW),(Decimal('1'),'synthetic',NOW+timedelta(seconds=1))])
def test_invalid_future_or_unattributable_fx_never_becomes_conversion_authority(value,source,as_of):
    assessment=assess_persisted_fx_rate(value=value,source=source,as_of=as_of,now=NOW)
    result=cost_fx_projection(1,assessment,now=NOW)
    assert result['fx']['status']=='unavailable' and result['fx']['value'] is None


def test_stale_and_inconsistent_age_remain_blocked_and_owner_clock_are_required():
    assessment=assess_persisted_fx_rate(value=Decimal('83'),source='synthetic',as_of=NOW-timedelta(days=2),now=NOW)
    assert cost_fx_projection(1,assessment,now=NOW)['fx']['status']=='stale'
    assert cost_fx_projection(1,replace(assessment,status='valid',age_seconds=0),now=NOW)['fx']['status']=='stale'
    with pytest.raises(ValueError):cost_fx_projection(True,assessment,now=NOW)
    with pytest.raises(ValueError):cost_fx_projection(1,assessment,now=NOW.replace(tzinfo=None))

def test_exact_fx_read_uses_existing_selected_analysis_metadata_gate_only():
    from app.domains.modules.coverage import classify_route
    args=('public_service','cost_fx','/account/operations/cost-fx')
    assert classify_route(*args,{'GET'},'app.domains.public_service.router')==('__analysis_metadata__','view')
    for methods,source in [({'POST'},'app.domains.public_service.router'),({'GET'},'foreign.router')]:
        assert classify_route(*args,methods,source)==('unknown','view')
