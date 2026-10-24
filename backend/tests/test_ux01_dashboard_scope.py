"""Selected data is excluded before querying, for each authenticated owner."""
from types import SimpleNamespace
import pytest
from app.domains.dashboard.schemas import DashboardIndMoneySection, DashboardPortfolioHistory


@pytest.mark.asyncio
@pytest.mark.parametrize('selected',[[],['zerodha_rebalance'],['indmoney_us'],['zerodha_rebalance','indmoney_us']])
@pytest.mark.parametrize('owner,role',[(7101,'user'),(7102,'user'),(7103,'admin')])
async def test_native_aggregate_scopes_before_load_and_ignores_role_grants(monkeypatch,selected,owner,role):
    from app.uat2 import router
    from app.domains.modules import visibility
    from app.domains.dashboard import service
    calls=[];db=object()
    async def visible(session,subject):
        assert session is db and subject==owner
        return selected
    original=router.broker.portfolio
    def india(empty):calls.append('zerodha_rebalance');return original(empty)
    async def us(session,subject):
        assert session is db and subject==owner
        calls.append('indmoney_us');return DashboardIndMoneySection()
    monkeypatch.setattr(visibility,'visible_module_ids',visible)
    monkeypatch.setattr(router.broker,'portfolio',india)
    monkeypatch.setattr(service,'_load_indmoney_with_session',us)
    result=await router.dashboard(current_user=SimpleNamespace(id=owner,role=role),db=db)
    assert set(calls)==set(selected)
    assert ('zerodha' in result['sections'])==('zerodha_rebalance' in selected)
    assert ('indmoney_us' in result['sections'])==('indmoney_us' in selected)
    assert 'bullpen' not in result['sections'] and 'bullpen' not in result
    if 'zerodha_rebalance' not in selected:assert result['zerodha'] is None
    if 'indmoney_us' not in selected:
        assert result['indmoney_us'] is None and result['fx']['value'] is None


@pytest.mark.asyncio
async def test_normal_inr_only_summary_never_loads_fx_us_or_singleton(monkeypatch):
    from app.domains.dashboard import service
    calls=[]
    async def india(owner):calls.append(('india',owner));return None
    async def history(owner,**kwargs):calls.append(('history',owner));return DashboardPortfolioHistory()
    async def forbidden(*args,**kwargs):raise AssertionError('Unselected loader must not run')
    monkeypatch.setattr(service,'_load_zerodha',india)
    monkeypatch.setattr(service,'_load_portfolio_history',history)
    for name in ['_load_indmoney','_load_bullpen','_load_fx']:
        monkeypatch.setattr(service,name,forbidden)
    result=await service.build_dashboard_summary(7101,module_ids=['zerodha_rebalance'])
    assert calls==[('india',7101),('history',7101)]
    assert result.indmoney_us is None and result.bullpen is None and result.fx.value is None
