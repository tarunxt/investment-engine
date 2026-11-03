"""Synthetic supplied calendars/prices/costs, never historical investment evidence."""
from copy import deepcopy
import pytest
from app.domains.recommendation_audit.execution_evidence import reconcile_execution
from app.domains.recommendation_audit.validation import COST_COMPONENTS


def fixture():
    identity = {"share_unit_vintage": "synthetic-shares-v1", "security_id": "synthetic-security", "market": "synthetic-market", "currency": "USD"}
    source = {"source_hash": "a" * 64}
    costs = {key: {"value": "0", "currency": "USD", "coverage": "complete", **source} for key in COST_COMPONENTS}
    return {"decision": {**identity, "identity_verified": True, "decision_at": "2024-01-02T10:00:00Z", "original_completion_at": "2024-01-02T10:00:00Z", "quantity": "10"},
            "share_unit_vintage": "synthetic-shares-v1", "corporate_action_reconciliation_hash": "b" * 64,
            "fill_window_end_at": "2024-01-02T16:00:00Z", "observed_at": "2024-01-03T17:00:00Z", "lot_size": "1",
            "settled_available_cash": "10000", "available_position_units": "10",
            "remainder_policy": "cancel_at_window_end", "price_cost_convention": "execution_price_includes_spread_slippage",
            "sessions": [{"id": "synthetic-session", "is_open": True, "open_at": "2024-01-02T09:00:00Z", "close_at": "2024-01-02T16:00:00Z", "market": identity["market"], **source}],
            "points": [{**identity, **source, "at": "2024-01-02T11:00:00Z", "available_at": "2024-01-02T11:00:00Z", "session_id": "synthetic-session", "tradable": True, "execution_price": "100", "capacity_units": "10", "costs_for_filled_units": "10", "costs": costs}],
            "terminal": {**identity, **source, "at": "2024-01-03T16:00:00Z", "available_at": "2024-01-03T16:00:00Z", "price": "101", "rule": "mark_to_supplied_price"}}


def test_complete_fill_and_cost_mark_preserve_inputs():
    data = fixture(); data["points"][0]["costs"]["commission"]["value"] = "1"
    before = deepcopy(data); result = reconcile_execution(data)
    assert result["status"] == "filled" and result["filled_units"] == "10"
    assert result["gross_cashflow_mark"] == "10" and result["net_cashflow_mark"] == "9"
    assert result["investment_validation"] == "not_established" and data == before


@pytest.mark.parametrize("mutation,reason", [
    ({"at": "2024-01-02T10:00:00Z", "available_at": "2024-01-02T10:00:00Z"}, "outside_strictly_after_decision_fill_window"),
    ({"at": "2024-01-02T16:00:00.000001Z"}, "outside_strictly_after_decision_fill_window"),
    ({"available_at": None}, "point_availability_unknown_or_future"),
    ({"available_at": "2024-01-02T12:00:00Z"}, "point_availability_unknown_or_future"),
    ({"tradable": False}, "illiquid_or_tradability_unknown"),
    ({"capacity_units": None}, "execution_price_or_capacity_unknown_or_invalid"),
    ({"capacity_units": "0"}, "no_executable_lot_capacity"),
    ({"security_id": "different-security"}, "point_identity_market_or_currency_mismatch"),
    ({"session_id": "unknown"}, "calendar_closed_or_session_unknown"),
    ({"source_hash": "invalid"}, "point_source_unknown"),
])
def test_infeasible_points_are_retained_as_exclusions(mutation, reason):
    data = fixture(); data["points"][0].update(mutation)
    result = reconcile_execution(data)
    assert result["status"] == "unfilled_cancelled"
    assert result["excluded_points"][0]["reason"] == reason
    assert result["net_cashflow_mark"] is None


def test_supplied_holiday_and_session_boundaries():
    data = fixture(); data["sessions"][0]["is_open"] = False
    assert reconcile_execution(data)["excluded_points"][0]["reason"] == "calendar_closed_or_session_unknown"
    data = fixture(); data["sessions"][0]["open_at"] = "2024-01-02T12:00:00Z"
    assert reconcile_execution(data)["excluded_points"][0]["reason"] == "outside_supplied_session"
    data = fixture(); data["points"][0].update(at="2024-01-02T16:00:00Z", available_at="2024-01-02T16:00:00Z")
    assert reconcile_execution(data)["status"] == "filled"


def test_partial_fill_cancels_remainder_and_does_not_scale_costs():
    data = fixture(); data["points"][0]["capacity_units"] = "4.5"
    result = reconcile_execution(data)
    assert result["status"] == "partial_fill_remainder_cancelled"
    assert result["filled_units"] == "4" and result["cancelled_units"] == "6"
    assert result["net_cashflow_mark"] is None  # costs were supplied for 10, not 4 units
    data["points"][0]["costs_for_filled_units"] = "4"
    assert reconcile_execution(data)["net_cashflow_mark"] == "4"


def test_multiple_partial_fills_have_distinct_costs_and_capacity():
    data = fixture(); first = data["points"][0]
    first.update(capacity_units="4", costs_for_filled_units="4")
    second = deepcopy(first); second.update(at="2024-01-02T12:00:00Z", available_at="2024-01-02T12:00:00Z", capacity_units="6", costs_for_filled_units="6", execution_price="102")
    data["points"].append(second)
    result = reconcile_execution(data)
    assert result["status"] == "filled" and len(result["fills"]) == 2
    assert result["net_cashflow_mark"] == "-2"


def test_duplicate_instant_cannot_choose_favorable_price():
    data = fixture(); second = deepcopy(data["points"][0]); second["execution_price"] = "90"
    data["points"].append(second)
    result = reconcile_execution(data)
    assert result["status"] == "unfilled_cancelled"
    assert all(p["reason"] == "duplicate_point_instant" for p in result["excluded_points"])


@pytest.mark.parametrize("key,value", [("tax", None), ("fx", "partial"), ("spread", "1")])
def test_missing_partial_and_double_counted_costs_block_net_mark(key, value):
    data = fixture()
    if value is None: del data["points"][0]["costs"][key]
    elif value == "partial": data["points"][0]["costs"][key]["coverage"] = value
    else: data["points"][0]["costs"][key]["value"] = value
    result = reconcile_execution(data)
    assert result["gross_cashflow_mark"] == "10" and result["net_cashflow_mark"] is None


def test_future_terminal_is_pending_maturity_not_zero_return():
    data = fixture(); data["terminal"]["at"] = "2024-01-04T16:00:00Z"
    result = reconcile_execution(data)
    assert result["outcome_coverage"] == "pending_maturity" and result["net_cashflow_mark"] is None


def test_unknown_terminal_and_liquidation_rule_remain_unresolved():
    data = fixture(); data["terminal"]["rule"] = "liquidate"
    result = reconcile_execution(data)
    assert result["outcome_coverage"] == "unresolved" and result["net_cashflow_mark"] is None
    data["terminal"] = {}
    assert reconcile_execution(data)["net_cashflow_mark"] is None


def test_sell_is_signed_incremental_mark_not_short_portfolio():
    data = fixture(); data["decision"]["quantity"] = "-10"
    result = reconcile_execution(data)
    assert result["filled_units"] == "-10" and result["net_cashflow_mark"] == "-10"


def test_missing_calendar_or_lot_and_unmatured_window_fail_closed():
    for key, value in (("sessions", []), ("lot_size", None), ("observed_at", "2024-01-02T12:00:00Z")):
        result = reconcile_execution(fixture() | {key: value})
        assert result["status"] == "unknown" and result["gaps"] and result["net_cashflow_mark"] is None


def test_cash_and_position_constraints_do_not_invent_financing_or_shorting():
    data = fixture(); data["settled_available_cash"] = "999"
    assert reconcile_execution(data)["excluded_points"][0]["reason"] == "settled_cash_or_position_constraint"
    data = fixture(); data["decision"]["quantity"] = "-10"; data["available_position_units"] = "9"
    assert reconcile_execution(data)["status"] == "unfilled_cancelled"
    data = fixture(); data["settled_available_cash"] = None
    assert "starting_settled_cash_or_position_unknown_or_invalid" in reconcile_execution(data)["gaps"]


def test_execution_cli_reconciles_local_fixture_without_mutating_input(tmp_path):
    import json
    from pathlib import Path
    import subprocess
    import sys
    source, output = tmp_path / "synthetic.json", tmp_path / "result.json"
    source.write_text(json.dumps(fixture())); before = source.read_bytes()
    script = Path(__file__).resolve().parents[1] / "scripts" / "reconcile_execution_evidence.py"
    subprocess.run([sys.executable, str(script), str(source), str(output)], check=True)
    result = json.loads(output.read_text())
    assert result["net_cashflow_mark"] == "10" and source.read_bytes() == before
    assert result["investment_validation"] == "not_established"


def test_split_units_must_be_reconciled_before_comparing_terminal_mark():
    data = fixture(); data["terminal"]["share_unit_vintage"] = "synthetic-after-split"
    result = reconcile_execution(data)
    assert "terminal_share_unit_vintage_mismatch" in result["terminal_gaps"]
    assert result["net_cashflow_mark"] is None
    data = fixture(); data["corporate_action_reconciliation_hash"] = None
    assert "share_units_or_corporate_action_reconciliation_unknown" in reconcile_execution(data)["gaps"]


@pytest.mark.parametrize("state", ["censored", "unresolved", "unknown", "pending_maturity"])
def test_explicit_unknown_or_censored_outcome_is_preserved(state):
    data = fixture(); data["terminal"]["outcome_state"] = state
    result = reconcile_execution(data)
    assert result["outcome_coverage"] == state and result["net_cashflow_mark"] is None
    assert f"terminal_outcome_{state}" in result["terminal_gaps"]
