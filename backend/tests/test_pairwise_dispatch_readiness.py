from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from test_auto_rebalance_audit_durability import anyio_backend

from app.core.config import settings
from app.domains.runs import spend_guard
from app.domains.scorecards.technical_sources import resolve_history_instruments


def test_run_254_issuer_aliases_need_exact_verified_identity():
    for alias, ticker, isin, issuer in [
        ("ICICIBC", "ICICIBANK", "INE090A01021", "ICICI Bank Ltd"),
        ("PBFINTECH", "POLICYBZR", "INE417T01026", "PB Fintech Limited"),
        ("RIL", "RELIANCE", "INE002A01018", "Reliance Industries Limited"),
    ]:
        raw, canonical = "NSE:" + alias, "NSE:" + ticker
        stock = {"listing":raw, "name":issuer}
        master = {canonical:{"isin":isin}}
        assert resolve_history_instruments([stock], master, {}) == {raw:canonical}
        assert not resolve_history_instruments([{**stock, "isin":"conflicting"}], master, {})
        assert not resolve_history_instruments([{**stock, "name":"Unrelated company"}], master, {})


@pytest.mark.anyio
async def test_first_call_capacity_obeys_real_headroom(monkeypatch):
    workflow = SimpleNamespace(id=42)
    monkeypatch.setattr(spend_guard, "history_budgets", AsyncMock(return_value={42:{"headroom_inr":4.25}}))
    monkeypatch.setattr(settings, "zerodha_run_charge_ceilings", {})
    capacity, reason = await spend_guard.request_capacity(None, workflow, "deepseek", "flash")
    assert capacity == 0 and "No verified" in reason
    monkeypatch.setattr(settings, "zerodha_run_charge_ceilings", {
        "deepseek:flash:request":{"max_paise":200,"contract_ref":"test","valid_until":"2099-01-01T00:00:00+00:00"}})
    assert await spend_guard.request_capacity(None, workflow, "deepseek", "flash") == (2, None)
