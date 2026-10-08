"""Synthetic local-only regressions: no broker, provider, or persistent DB calls."""
import asyncio
from types import SimpleNamespace

import pytest

from app.domains.recommendation_audit.deterministic import sizing_layer


@pytest.mark.parametrize("held,requested,market,action,units,review", [
    ("1", "-.5", "india", "Trim", None, True),
    ("2", "-1", "india", "Trim", "-1", False),
    ("3", "-1.5", "india", "Trim", "-1", False),
    ("1", "-.5", "us", "Trim", "-0.5", False),
    ("1", "-1", "india", "Sell All", "-1", False),
    (None, None, "india", None, None, False),
    ("0", "0", "india", "Hold", "0", False),
])
def test_sizing_policy_preserves_normal_lots_and_blocks_fractional_india_trim(held, requested, market, action, units, review):
    source = {"current_units": held, "formula_units": requested, "formula_action": action}
    before = dict(source)
    result = sizing_layer(source, market)
    assert result["action"] == action and result["units"] == units
    assert result.get("review_required", False) is review
    assert source == before


def test_new_sizing_never_rewrites_a_legacy_saved_sizing():
    saved = {"calculation": {"current_units": "1", "formula_units": "-.5", "formula_action": "Trim"}, "sizing": {"policy": "existing-basket-rounding-v1", "action": "Sell All", "units": "-1"}}
    assert sizing_layer(saved["calculation"], "india")["units"] is None
    assert saved["sizing"]["action"] == "Sell All" and saved["sizing"]["units"] == "-1"


@pytest.mark.parametrize("recovery,writable", [("0", True), ("1", False)])
def test_profile_read_reports_capability_without_performing_a_write(monkeypatch, recovery, writable):
    from app.domains.auth.router import get_profile
    from app.domains.auth.schemas import UpdateProfileRequest
    monkeypatch.setenv("CREDX_RECOVERY_MODE", recovery)
    profile = SimpleNamespace(avatar_url=None, bio=None, timezone="UTC", notification_preferences=None, theme_preference=None, zerodha_buy_threshold=2.5, indmoney_buy_threshold=2.5)
    class ReadOnlyDb:
        async def execute(self, query):
            return SimpleNamespace(scalar_one_or_none=lambda: profile)
    result = asyncio.run(get_profile(SimpleNamespace(id=1, full_name="Fixture User"), ReadOnlyDb()))
    assert result.preferences_writable is writable
    assert result.zerodha_buy_threshold == result.indmoney_buy_threshold == 2.5
    assert "preferences_writable" not in UpdateProfileRequest.model_fields
