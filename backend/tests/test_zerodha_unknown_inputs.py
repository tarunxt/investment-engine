import copy
import pytest
from app.domains.zerodha.portfolio import (
    _as_float, _as_int, normalize_holding, normalize_position, build_portfolio_snapshot,
)

@pytest.mark.parametrize("value", [None, "", "bad", True, float("nan"), float("inf"), float("-inf")])
def test_unknown_numbers_remain_unknown(value):
    assert _as_float(value) is None
    assert _as_int(value) is None
    holding = normalize_holding({"quantity": value, "last_price": value})
    assert holding["quantity"] is None
    assert holding["last_price"] is None
    assert holding["market_value"] is None
    assert normalize_position({"quantity": value})["quantity"] is None

@pytest.mark.parametrize("value, expected", [(0, 0), ("0", 0), (-3, -3), ("12", 12)])
def test_known_integer_boundaries(value, expected):
    assert _as_int(value) == expected
    assert _as_float(value) == expected

@pytest.mark.parametrize("value", [1.5, "1.5"])
def test_fractional_quantity_is_not_truncated(value):
    assert _as_int(value) is None

def valid_holding():
    return dict(quantity=2, t1_quantity=0, last_price=10, average_price=8, pnl=4, day_change=1)

@pytest.mark.parametrize("field", ["quantity", "t1_quantity", "last_price", "average_price", "pnl", "day_change"])
@pytest.mark.parametrize("value", [None, "bad", float("nan")])
def test_partial_holding_rejected_before_snapshot(field, value):
    holding = valid_holding()
    holding[field] = value
    original = copy.deepcopy(holding)
    for _ in range(2):
        with pytest.raises(ValueError, match=rf"holdings\[1\].{field}"):
            build_portfolio_snapshot([valid_holding(), holding], {}, {"equity": {"available_margin": 0}})
    assert holding.keys() == original.keys()

@pytest.mark.parametrize("margin", [None, {}, {"equity": {}}, {"equity": {"available": {}}}, {"equity": {"available_margin": "bad"}}])
def test_unknown_margin_rejected_without_inferring_cash(margin):
    with pytest.raises(ValueError, match="margins.equity.available_margin"):
        build_portfolio_snapshot([], {}, margin)

def test_explicit_zero_is_preserved_and_inputs_unchanged():
    holding = valid_holding()
    original = copy.deepcopy(holding)
    snapshot = build_portfolio_snapshot([holding], {}, {"equity": {"available": {"live_balance": 0}}})
    assert snapshot["available_margin"] == 0
    assert snapshot["holdings_market_value"] == 20
    assert snapshot["holdings"][0]["used_quantity"] is None
    assert holding == original

def test_unusable_net_exposure_rejected():
    with pytest.raises(ValueError, match="net_positions"):
        build_portfolio_snapshot([], {"net": [{"quantity": "bad"}]}, {"equity": {"available_margin": 0}})
