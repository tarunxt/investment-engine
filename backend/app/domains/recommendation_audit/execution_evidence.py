"""Offline execution feasibility and cashflow marks from supplied evidence only.

No live fills, strategy changes, market calendars, prices or costs are fetched.
The arithmetic describes an incremental position; it is not portfolio performance
or an approved investment outcome label. Unknown evidence remains unknown.
"""
from collections import Counter
from decimal import Decimal, ROUND_FLOOR
import re

from .deterministic import digest, number
from .validation import COST_COMPONENTS, cost_coverage, timestamp

VERSION = "execution-evidence-v1"


def source_hash(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def reconcile_execution(data):
    """Consume explicit sessions/quotes and cancel any remainder at window end.

    Quantities are signed share units. Positive buys and negative sells describe
    incremental cashflow marks, never an assumed short portfolio or whole portfolio.
    Supplied execution prices must include any price-side spread/slippage; explicit
    costs must declare this to avoid double counting. No price/cost defaults exist.
    """
    decision = data.get("decision") or {}
    start = timestamp(decision.get("decision_at"))
    completion = timestamp(decision.get("original_completion_at"))
    cutoff = timestamp(data.get("fill_window_end_at"))
    observed = timestamp(data.get("observed_at"))
    quantity = number(decision.get("quantity"))
    lot = number(data.get("lot_size"))
    starting_cash = number(data.get("settled_available_cash"))
    starting_units = number(data.get("available_position_units"))
    base = {"schema_version": VERSION, "input_hash": digest(data),
            "investment_validation": "not_established", "fills": [], "excluded_points": [],
            "limitations": ["Incremental-position cashflow mark, not portfolio performance",
                            "Supplied calendar, capacity, execution and cost evidence only",
                            "Price-only mark; distributions and total-return outcomes require separate reconciliation",
                            "No annualization, calibration or investment outcome label"]}
    gaps = []
    if start is None or completion is None or completion > start:
        gaps.append("original_decision_or_completion_unknown_or_future")
    if cutoff is None or start is None or cutoff <= start or observed is None or observed < cutoff:
        gaps.append("fill_window_or_observation_unknown_or_unmatured")
    if quantity is None or quantity == 0 or lot is None or lot <= 0:
        gaps.append("quantity_or_lot_unknown_or_invalid")
    elif abs(quantity) % lot:
        gaps.append("requested_quantity_not_lot_aligned")
    if not decision.get("security_id") or decision.get("identity_verified") is not True or not decision.get("market") or not decision.get("currency"):
        gaps.append("identity_market_or_currency_unverified")
    if data.get("remainder_policy") != "cancel_at_window_end":
        gaps.append("remainder_policy_not_declared")
    if data.get("price_cost_convention") != "execution_price_includes_spread_slippage":
        gaps.append("price_cost_convention_not_declared")
    if len(data.get("sessions", [])) > 10000 or len(data.get("points", [])) > 100000:
        gaps.append("offline_evidence_bounds_exceeded")
    if starting_cash is None or starting_cash < 0 or starting_units is None or starting_units < 0:
        gaps.append("starting_settled_cash_or_position_unknown_or_invalid")
    if not data.get("share_unit_vintage") or not source_hash(data.get("corporate_action_reconciliation_hash")):
        gaps.append("share_units_or_corporate_action_reconciliation_unknown")
    sessions = {}
    for session in data.get("sessions", []):
        key = session.get("id")
        opened, closed = timestamp(session.get("open_at")), timestamp(session.get("close_at"))
        if not isinstance(key, str) or not key or key in sessions or session.get("is_open") not in (True, False):
            gaps.append("calendar_session_invalid_or_duplicate")
            continue
        if session.get("is_open") is True and (opened is None or closed is None or opened >= closed):
            gaps.append("calendar_session_boundaries_unknown_or_invalid")
        if not source_hash(session.get("source_hash")) or session.get("market") != decision.get("market"):
            gaps.append("calendar_market_or_source_unknown")
        sessions[key] = session
    if not sessions:
        gaps.append("calendar_not_supplied")
    if gaps:
        return base | {"status": "unknown", "gaps": sorted(set(gaps)), "net_cashflow_mark": None}

    points = data.get("points", [])
    if any(timestamp(p.get("at")) is None for p in points):
        return base | {"status": "unknown", "gaps": ["point_time_unknown"], "net_cashflow_mark": None}
    points = sorted(points, key=lambda point: timestamp(point["at"]))
    duplicate_times = Counter(timestamp(p["at"]) for p in points)
    remaining = abs(quantity)
    sign = Decimal(1) if quantity > 0 else Decimal(-1)
    cashflow = Decimal(0)
    known_costs = Decimal(0)
    costs_complete = True
    remaining_cash, remaining_position = starting_cash, starting_units
    constraints_known = True
    for point in points:
        when = timestamp(point["at"])
        available = timestamp(point.get("available_at"))
        key = point["at"]
        reason = None
        session = sessions.get(point.get("session_id"))
        price, capacity = number(point.get("execution_price")), number(point.get("capacity_units"))
        if duplicate_times[when] > 1:
            reason = "duplicate_point_instant"
        elif when <= start or when > cutoff:
            reason = "outside_strictly_after_decision_fill_window"
        elif available is None or available > when or available > observed:
            reason = "point_availability_unknown_or_future"
        elif not source_hash(point.get("source_hash")):
            reason = "point_source_unknown"
        elif point.get("security_id") != decision["security_id"] or point.get("market") != decision["market"] or point.get("currency") != decision["currency"]:
            reason = "point_identity_market_or_currency_mismatch"
        elif point.get("share_unit_vintage") != data["share_unit_vintage"]:
            reason = "share_unit_vintage_mismatch"
        elif not session or session.get("is_open") is not True:
            reason = "calendar_closed_or_session_unknown"
        elif not timestamp(session.get("open_at")) <= when <= timestamp(session.get("close_at")):
            reason = "outside_supplied_session"
        elif point.get("tradable") is not True:
            reason = "illiquid_or_tradability_unknown"
        elif price is None or price <= 0 or capacity is None or capacity < 0:
            reason = "execution_price_or_capacity_unknown_or_invalid"
        if reason:
            base["excluded_points"].append({"at": key, "reason": reason})
            continue
        if remaining == 0:
            continue
        filled = (min(remaining, capacity) / lot).to_integral_value(rounding=ROUND_FLOOR) * lot
        if filled == 0:
            base["excluded_points"].append({"at": key, "reason": "no_executable_lot_capacity"})
            continue
        costs = point.get("costs") or {}
        coverage = cost_coverage(costs)
        # Spread/slippage must be explicitly evidenced zero incremental charges
        # because their price effect is already in the supplied execution price.
        price_side_ok = all(number((costs.get(k) or {}).get("value")) == 0 for k in ("spread", "slippage"))
        cost_currency_ok = all((costs.get(k) or {}).get("currency") == decision["currency"] for k in COST_COMPONENTS)
        complete = coverage["complete"] and price_side_ok and cost_currency_ok and number(point.get("costs_for_filled_units")) == filled
        expense = sum((number(costs[k]["value"]) for k in COST_COMPONENTS), Decimal(0)) if complete else None
        if sign > 0 and (filled * price > remaining_cash or expense is not None and filled * price + expense > remaining_cash) or sign < 0 and filled > remaining_position:
            base["excluded_points"].append({"at": key, "reason": "settled_cash_or_position_constraint"})
            continue
        costs_complete = costs_complete and complete
        constraints_known = constraints_known and complete
        if sign > 0:
            remaining_cash -= filled * price + (expense if expense is not None else 0)
        else:
            remaining_position -= filled
        if expense is not None:
            known_costs += expense
        cashflow -= sign * filled * price
        remaining -= filled
        base["fills"].append({"at": key, "units": str(sign * filled), "execution_price": str(price),
                              "cost_coverage": coverage, "costs_reconciled": complete,
                              "all_in_incremental_cost": str(expense) if expense is not None else None})

    filled_quantity = abs(quantity) - remaining
    state = "filled" if remaining == 0 else "partial_fill_remainder_cancelled" if filled_quantity else "unfilled_cancelled"
    terminal = data.get("terminal") or {}
    at, available = timestamp(terminal.get("at")), timestamp(terminal.get("available_at"))
    terminal_price = number(terminal.get("price"))
    terminal_gaps = []
    supplied_outcome_state = terminal.get("outcome_state")
    if supplied_outcome_state in {"censored", "unresolved", "unknown", "pending_maturity"}:
        terminal_gaps.append(f"terminal_outcome_{supplied_outcome_state}")
    if terminal.get("rule") != "mark_to_supplied_price":
        terminal_gaps.append("terminal_rule_unknown_or_unsupported")
    if at is None or at < cutoff or available is None or available < at or available > observed:
        terminal_gaps.append("terminal_price_pending_or_unknown")
    if terminal_price is None or terminal_price <= 0:
        terminal_gaps.append("terminal_price_missing_or_invalid")
    if terminal.get("share_unit_vintage") != data["share_unit_vintage"]:
        terminal_gaps.append("terminal_share_unit_vintage_mismatch")
    if any(terminal.get(k) != decision.get(k) for k in ("security_id", "market", "currency")) or not source_hash(terminal.get("source_hash")):
        terminal_gaps.append("terminal_identity_currency_or_source_unknown")
    gross = cashflow + sign * filled_quantity * terminal_price if not terminal_gaps and filled_quantity else None
    return base | {"status": state, "requested_units": str(quantity), "filled_units": str(sign * filled_quantity),
                   "cancelled_units": str(sign * remaining), "outcome_coverage": supplied_outcome_state if supplied_outcome_state in {"censored", "unresolved", "unknown", "pending_maturity"} else "pending_maturity" if at and at > observed else "unresolved" if terminal_gaps else "known_supplied_mark",
                   "terminal_gaps": terminal_gaps,
                   "execution_feasibility": "known_supplied_constraints" if constraints_known and filled_quantity else "unknown",
                   "costs_complete": costs_complete and bool(filled_quantity),
                   "gross_cashflow_mark": str(gross) if gross is not None else None,
                   "net_cashflow_mark": str(gross - known_costs) if gross is not None and costs_complete else None,
                   "gaps": []}
