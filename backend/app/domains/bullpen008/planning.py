"""Deterministic Bullpen 008 Stage 5 planning and Stage 6 preflight.

This module is intentionally provider-free. Stage 4 is the only portfolio
authority; Stage 5 translates its frozen targets and Stage 6 validates only
the actions in that frozen plan.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
import math
from typing import Iterable

from app.domains.bullpen008.constants import ACTION_PLAN_VERSION, EXECUTION_VERSION, WORKFLOW_PROFILE
from app.domains.bullpen008.engine import stable_hash
from app.domains.bullpen008.schemas import Bullpen008Settings

ACTION_ARRAYS = (
    "claims",
    "order_cancellations",
    "full_exits",
    "trims",
    "buys",
    "holds",
    "blocked_untradeable",
)
ACTION_PRIORITY = {
    "claim": 10,
    "cancel": 20,
    "full_exit": 30,
    "trim": 40,
    "buy": 70,
    "hold": 80,
    "blocked": 90,
}


def _number(value: object, default: float = 0.0) -> float:
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def _iso(value: object) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _rows(value: object) -> list[dict[str, object]]:
    return [dict(row) for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def wallet_version(wallet_snapshot: dict[str, object]) -> str:
    """Stable version proving the exact account, positions, orders and cash."""
    positions = [
        {
            key: row.get(key)
            for key in (
                "market_id", "condition_id", "side", "shares", "average_price_cents",
                "exposure_usd", "classification", "claimable",
            )
        }
        for row in _rows(wallet_snapshot.get("positions"))
    ]
    balance = wallet_snapshot.get("balance")
    balance_version = {
        key: balance.get(key)
        for key in ("available_balance_usd",)
    } if isinstance(balance, dict) else {}
    return stable_hash(
        {
            "account_identity": wallet_snapshot.get("account_identity"),
            "positions": positions,
            "balance": balance_version,
            "open_orders": wallet_snapshot.get("open_orders", []),
        }
    )


def certificate_hash_is_valid(certificate: dict[str, object]) -> bool:
    supplied = str(certificate.get("certificate_hash") or "")
    payload = {key: value for key, value in certificate.items() if key != "certificate_hash"}
    return bool(supplied) and supplied == stable_hash(payload)


def _position_exposure(row: dict[str, object]) -> float:
    return round(max(_number(row.get("current_value_usd")), _number(row.get("exposure_usd"))), 2)


def _action_id(*, run_id: str, plan_inputs_hash: str, action_type: str, market_id: str, ordinal: int) -> str:
    return "b008a-" + stable_hash(
        {
            "run_id": run_id,
            "profile": WORKFLOW_PROFILE,
            "inputs": plan_inputs_hash,
            "action_type": action_type,
            "market_id": market_id,
            "ordinal": ordinal,
        }
    )[:32]


def _make_action(
    *,
    run_id: str,
    plan_inputs_hash: str,
    action_type: str,
    row: dict[str, object],
    position: dict[str, object] | None,
    current_exposure: float,
    target_exposure: float,
    amount_usd: float,
    reason_code: str,
    explanation: str,
    ordinal: int,
    settings: Bullpen008Settings,
) -> dict[str, object]:
    odds = _number(row.get("current_odds"), _number((position or {}).get("current_yes_odds")))
    shares = _number((position or {}).get("shares"))
    if action_type == "buy" and odds > 0:
        shares = round(amount_usd * 100 / odds, 6)
    elif action_type in {"full_exit", "trim"} and current_exposure > 0:
        shares = round(shares * min(1.0, amount_usd / current_exposure), 6)
    market_id = str(row.get("market_id") or (position or {}).get("market_id") or "")
    return {
        "action_id": _action_id(
            run_id=run_id,
            plan_inputs_hash=plan_inputs_hash,
            action_type=action_type,
            market_id=market_id,
            ordinal=ordinal,
        ),
        "run_id": run_id,
        "workflow_profile": WORKFLOW_PROFILE,
        "action_type": action_type,
        "market_id": market_id,
        "condition_id": row.get("condition_id") or (position or {}).get("condition_id"),
        "slug": row.get("slug") or (position or {}).get("slug"),
        "question": row.get("question") or (position or {}).get("market_title"),
        "side": row.get("chosen_side") or (position or {}).get("side"),
        "quantity_shares": round(max(0.0, shares), 6),
        "estimated_usd": round(max(0.0, amount_usd), 2),
        "current_exposure_usd": round(current_exposure, 2),
        "target_exposure_usd": round(target_exposure, 2),
        "strict_cluster_id": row.get("strict_cluster_id"),
        "common_catalyst_cluster_id": row.get("common_catalyst_cluster_id"),
        "reason_code": reason_code,
        "explanation": explanation,
        "priority": ACTION_PRIORITY[action_type],
        "dependency_ids": [],
        "quote_timestamp": row.get("quote_timestamp") or (position or {}).get("quote_timestamp"),
        "quoted_price_cents": odds or None,
        "max_slippage_cents": settings.max_slippage_cents,
        "permitted_price_cents": (
            round(odds + settings.max_slippage_cents, 2)
            if action_type == "buy" and odds
            else round(max(0, odds - settings.max_slippage_cents), 2) if odds else None
        ),
        "stage4_certificate_hash": None,
        "expected_post_action_cash_usd": None,
        "expected_post_action_exposure_usd": round(target_exposure, 2),
        "allowed_after_confirmed_exit_action_id": None,
    }


def _plan_actions(plan: dict[str, object]) -> list[dict[str, object]]:
    return [
        action
        for name in ACTION_ARRAYS
        for action in (plan.get(name) if isinstance(plan.get(name), list) else [])
        if isinstance(action, dict)
    ]


def verify_action_plan(plan: dict[str, object]) -> bool:
    plan_hash = str(plan.get("plan_hash") or "")
    certificate = plan.get("plan_certificate")
    if not isinstance(certificate, dict):
        return False
    certificate_hash = str(certificate.get("certificate_hash") or "")
    cert_payload = {key: value for key, value in certificate.items() if key != "certificate_hash"}
    plan_payload = {key: value for key, value in plan.items() if key not in {"plan_hash", "plan_certificate"}}
    return bool(
        plan_hash
        and plan_hash == stable_hash(plan_payload)
        and certificate_hash
        and certificate_hash == stable_hash(cert_payload)
        and certificate.get("plan_hash") == plan_hash
        and certificate.get("plan_certified") is True
    )


def build_action_plan(
    *,
    run_id: str,
    stage4_allocations: list[dict[str, object]],
    stage4_certificate: dict[str, object],
    stage3_rows: list[dict[str, object]],
    wallet_snapshot: dict[str, object],
    pending_orders: list[dict[str, object]],
    settings: Bullpen008Settings,
    stage4_completed_at: datetime,
    now: datetime | None = None,
) -> dict[str, object]:
    now = (now or datetime.now(UTC)).astimezone(UTC)
    fetched_at = _iso(wallet_snapshot.get("fetched_at"))
    account_identity = str(wallet_snapshot.get("account_identity") or "") or None
    wallet_is_fresh = bool(
        fetched_at and 0 <= (now - fetched_at).total_seconds() <= settings.wallet_freshness_seconds
    )
    target_is_fresh = 0 <= (now - stage4_completed_at.astimezone(UTC)).total_seconds() <= settings.plan_max_age_seconds
    stage4_hash_valid = certificate_hash_is_valid(stage4_certificate)
    portfolio_certified = stage4_hash_valid and stage4_certificate.get("portfolio_certified") is True
    target_account_matches = bool(account_identity) and (
        stage4_certificate.get("account_identity") == account_identity
    )
    clustering_complete = all(
        row.get("adjudication_status") == "resolved"
        and row.get("strict_cluster_id")
        and row.get("common_catalyst_cluster_id")
        for row in stage3_rows
    )
    plan_inputs_hash = stable_hash(
        {
            "run_id": run_id,
            "stage4_allocations": stage4_allocations,
            "stage4_certificate": stage4_certificate,
            "stage3": stage3_rows,
            "wallet": wallet_snapshot,
            "pending_orders": pending_orders,
            "settings": settings.model_dump(mode="json"),
        }
    )
    allocations = {str(row.get("market_id") or ""): dict(row) for row in stage4_allocations if row.get("market_id")}
    clusters = {str(row.get("market_id") or ""): dict(row) for row in stage3_rows if row.get("market_id")}
    positions = {str(row.get("market_id") or ""): dict(row) for row in _rows(wallet_snapshot.get("positions")) if row.get("market_id")}

    active_pending_buys: dict[str, float] = defaultdict(float)
    active_pending_sells: dict[str, float] = defaultdict(float)
    cancel_orders: list[dict[str, object]] = []
    active_statuses = {"planned", "queued", "ready", "submitting", "submitted", "confirming", "partially_filled", "pending"}
    seen_pending: set[tuple[str, str, str]] = set()
    for pending in pending_orders:
        market_id = str(pending.get("market_id") or "")
        action = str(pending.get("action") or "").upper()
        status = str(pending.get("status") or "").lower()
        identity = (market_id, action, str(pending.get("side") or ""))
        stale_or_duplicate = bool(pending.get("stale") or pending.get("conflicting") or identity in seen_pending)
        seen_pending.add(identity)
        amount = _number(pending.get("remaining_usd"), _number(pending.get("current_order_usd"), _number(pending.get("requested_order_usd"))))
        if stale_or_duplicate and status in active_statuses:
            cancel_orders.append(dict(pending))
        elif status in active_statuses:
            if action == "BUY":
                active_pending_buys[market_id] += amount
            elif action in {"SELL", "EXIT", "TRIM"}:
                active_pending_sells[market_id] += amount

    arrays: dict[str, list[dict[str, object]]] = {name: [] for name in ACTION_ARRAYS}
    classified_position_ids: set[str] = set()
    ordinal = 0
    all_market_ids = sorted(set(allocations) | set(positions))
    for market_id in all_market_ids:
        allocation = allocations.get(market_id, {})
        row = {**clusters.get(market_id, {}), **allocation, "market_id": market_id}
        position = positions.get(market_id)
        current = _position_exposure(position) if position else 0.0
        target = round(_number(allocation.get("target_exposure_usd")), 2)
        pending_buy = round(active_pending_buys.get(market_id, 0.0), 2)
        pending_sell = round(active_pending_sells.get(market_id, 0.0), 2)
        gap = round(target - current - pending_buy + pending_sell, 2)
        if position:
            classified_position_ids.add(market_id)
        ordinal += 1
        if position and market_id not in allocations:
            action = _make_action(
                run_id=run_id, plan_inputs_hash=plan_inputs_hash, action_type="blocked", row=row,
                position=position, current_exposure=current, target_exposure=0, amount_usd=current,
                reason_code="STAGE4_TARGET_ROW_MISSING",
                explanation="Stage 5 cannot invent an exit or target for a wallet position omitted by Stage 4.",
                ordinal=ordinal, settings=settings,
            )
            arrays["blocked_untradeable"].append(action)
            continue
        if position and bool(position.get("claimable") or position.get("is_claimable")):
            action = _make_action(
                run_id=run_id, plan_inputs_hash=plan_inputs_hash, action_type="claim", row=row,
                position=position, current_exposure=current, target_exposure=target,
                amount_usd=current, reason_code="RESOLVED_CLAIMABLE", explanation="Resolved balance must be claimed before rebalance actions.",
                ordinal=ordinal, settings=settings,
            )
            arrays["claims"].append(action)
            continue
        deadline = _iso(row.get("deadline") or (position or {}).get("deadline") or (position or {}).get("close_time"))
        expired_not_claimable = bool(deadline and deadline <= now and position and not position.get("claimable"))
        if expired_not_claimable:
            action = _make_action(
                run_id=run_id, plan_inputs_hash=plan_inputs_hash, action_type="blocked", row=row,
                position=position, current_exposure=current, target_exposure=target, amount_usd=abs(gap),
                reason_code="EXPIRED_NOT_CLAIMABLE", explanation="Deadline passed; hold for resolution and freeze new buys.",
                ordinal=ordinal, settings=settings,
            )
            arrays["blocked_untradeable"].append(action)
            continue
        if abs(gap) <= settings.exposure_rounding_tolerance_usd:
            action = _make_action(
                run_id=run_id, plan_inputs_hash=plan_inputs_hash, action_type="hold", row=row,
                position=position, current_exposure=current, target_exposure=target, amount_usd=0,
                reason_code="AT_CERTIFIED_TARGET", explanation="Confirmed and pending exposure already matches the Stage 4 target.",
                ordinal=ordinal, settings=settings,
            )
            arrays["holds"].append(action)
            continue
        if gap < 0:
            amount = abs(gap)
            bid = _number(row.get("current_odds"), _number((position or {}).get("current_yes_odds")))
            if amount < settings.dust_threshold_usd or bid <= 0:
                code = "DUST_POSITION" if amount < settings.dust_threshold_usd else "BID_UNAVAILABLE"
                action = _make_action(
                    run_id=run_id, plan_inputs_hash=plan_inputs_hash, action_type="blocked", row=row,
                    position=position, current_exposure=current, target_exposure=target, amount_usd=amount,
                    reason_code=code, explanation="Position cannot be sold reliably and is not counted as free capacity.",
                    ordinal=ordinal, settings=settings,
                )
                arrays["blocked_untradeable"].append(action)
            else:
                action_type = "full_exit" if target <= settings.exposure_rounding_tolerance_usd else "trim"
                reasons: list[str] = ["STAGE4_TARGET_REDUCTION"]
                held_odds = _number(row.get("current_odds"))
                llm_odds = _number(row.get("llm_odds"))
                if held_odds and held_odds < settings.entry_side_odds_floor_pct:
                    reasons.append("ACTUAL_ODDS_BELOW_80")
                if llm_odds and llm_odds < settings.min_llm_probability_pct:
                    reasons.append("LLM_ODDS_BELOW_80")
                if _number(row.get("edge_pp"), 999) < settings.exit_edge_threshold_pp:
                    reasons.append("EDGE_BELOW_EXIT_THRESHOLD")
                if _number(row.get("risk_score")) >= settings.risk_hard_reject_threshold:
                    reasons.append("RISK_SCORE_AT_LEAST_8")
                action = _make_action(
                    run_id=run_id, plan_inputs_hash=plan_inputs_hash, action_type=action_type, row=row,
                    position=position, current_exposure=current, target_exposure=target, amount_usd=amount,
                    reason_code="+".join(reasons), explanation="Reduce only to the certified Stage 4 target.",
                    ordinal=ordinal, settings=settings,
                )
                arrays["full_exits" if action_type == "full_exit" else "trims"].append(action)
            continue

        # Positive gaps are buys. They may never be invented or enlarged here.
        buy_blockers: list[str] = []
        if not portfolio_certified:
            buy_blockers.append("STAGE4_NOT_CERTIFIED")
        if not clustering_complete:
            buy_blockers.append("STAGE3_INCOMPLETE")
        if not wallet_is_fresh:
            buy_blockers.append("WALLET_STALE")
        if not account_identity:
            buy_blockers.append("ACCOUNT_IDENTITY_MISSING")
        elif not target_account_matches:
            buy_blockers.append("STAGE4_ACCOUNT_IDENTITY_MISMATCH")
        if not target_is_fresh:
            buy_blockers.append("TARGET_EXPIRED")
        if abs(gap / settings.allocation_increment_usd - round(gap / settings.allocation_increment_usd)) > 1e-6:
            buy_blockers.append("BUY_NOT_INCREMENTAL")
        action_type = "blocked" if buy_blockers else "buy"
        action = _make_action(
            run_id=run_id, plan_inputs_hash=plan_inputs_hash, action_type=action_type, row=row,
            position=position, current_exposure=current, target_exposure=target, amount_usd=gap,
            reason_code="+".join(buy_blockers) if buy_blockers else "STAGE4_CERTIFIED_TARGET_GAP",
            explanation=("Buy is frozen until every Stage 3/4/wallet guard passes." if buy_blockers else "Fill only the positive gap in the certified Stage 4 target."),
            ordinal=ordinal, settings=settings,
        )
        arrays["blocked_untradeable" if buy_blockers else "buys"].append(action)

    for pending in cancel_orders:
        ordinal += 1
        market_id = str(pending.get("market_id") or "")
        row = {**clusters.get(market_id, {}), **allocations.get(market_id, {}), "market_id": market_id, "chosen_side": pending.get("side")}
        action = _make_action(
            run_id=run_id, plan_inputs_hash=plan_inputs_hash, action_type="cancel", row=row,
            position=positions.get(market_id), current_exposure=_position_exposure(positions[market_id]) if market_id in positions else 0,
            target_exposure=_number(allocations.get(market_id, {}).get("target_exposure_usd")), amount_usd=_number(pending.get("remaining_usd"), _number(pending.get("current_order_usd"))),
            reason_code="STALE_DUPLICATE_OR_CONFLICTING_ORDER", explanation="Cancel before any position-changing action.", ordinal=ordinal, settings=settings,
        )
        action["remote_order_id"] = pending.get("remote_order_id") or pending.get("order_id")
        arrays["order_cancellations"].append(action)

    stage4_hash = str(stage4_certificate.get("certificate_hash") or "")
    cash = _number((wallet_snapshot.get("balance") if isinstance(wallet_snapshot.get("balance"), dict) else {}).get("available_balance_usd"))
    cash_available_without_unconfirmed_exits = cash
    cash_ledger: list[dict[str, object]] = [{"step": 0, "kind": "opening", "cash_usd": round(cash, 2), "confirmed": True}]
    exit_ids: list[str] = []
    for action in sorted(_plan_actions(arrays), key=lambda value: int(value["priority"])):
        action["stage4_certificate_hash"] = stage4_hash
        kind = str(action["action_type"])
        amount = _number(action.get("estimated_usd"))
        if kind in {"full_exit", "trim", "claim"}:
            cash += amount
            exit_ids.append(str(action["action_id"]))
        elif kind == "buy":
            if amount > cash_available_without_unconfirmed_exits + 1e-9 and exit_ids:
                action["dependency_ids"] = list(exit_ids)
                action["allowed_after_confirmed_exit_action_id"] = exit_ids[-1]
            else:
                cash_available_without_unconfirmed_exits -= amount
            cash -= amount
        action["expected_post_action_cash_usd"] = round(cash, 2)
        cash_ledger.append({
            "step": len(cash_ledger), "action_id": action["action_id"], "kind": kind,
            "delta_usd": round(amount if kind in {"full_exit", "trim", "claim"} else -amount if kind == "buy" else 0, 2),
            "cash_usd": round(cash, 2), "confirmed_required": kind in {"full_exit", "trim", "claim"},
        })

    simulated = {market_id: _position_exposure(row) for market_id, row in positions.items()}
    for market_id, amount in active_pending_buys.items():
        simulated[market_id] = simulated.get(market_id, 0) + amount
    for market_id, amount in active_pending_sells.items():
        simulated[market_id] = max(0, simulated.get(market_id, 0) - amount)
    for action in arrays["claims"]:
        simulated[str(action["market_id"])] = 0.0
    for action in arrays["full_exits"] + arrays["trims"]:
        market_id = str(action["market_id"])
        simulated[market_id] = max(0, simulated.get(market_id, 0) - _number(action["estimated_usd"]))
    for action in arrays["buys"]:
        market_id = str(action["market_id"])
        simulated[market_id] = simulated.get(market_id, 0) + _number(action["estimated_usd"])

    target_match_rows: list[dict[str, object]] = []
    for market_id in sorted(set(allocations) | set(positions)):
        allocation = allocations.get(market_id, {})
        target = _number(allocation.get("target_exposure_usd"))
        actual = simulated.get(market_id, 0)
        target_match_rows.append({
            "market_id": market_id, "target_exposure_usd": round(target, 2),
            "simulated_exposure_usd": round(actual, 2), "difference_usd": round(actual - target, 2),
            "matches": abs(actual - target) <= settings.exposure_rounding_tolerance_usd,
        })
    strict_exposure: dict[str, float] = defaultdict(float)
    catalyst_exposure: dict[str, float] = defaultdict(float)
    contract_max = 0.0
    for market_id, exposure in simulated.items():
        if exposure <= settings.exposure_rounding_tolerance_usd:
            continue
        allocation = allocations.get(market_id, clusters.get(market_id, {}))
        contract_max = max(contract_max, exposure)
        strict_exposure[str(allocation.get("strict_cluster_id") or f"missing:{market_id}")] += exposure
        catalyst_exposure[str(allocation.get("common_catalyst_cluster_id") or f"missing:{market_id}")] += exposure

    actions = _plan_actions(arrays)
    action_ids = [str(action.get("action_id")) for action in actions]
    contradictory = {
        market_id
        for market_id in all_market_ids
        if len({str(action["action_type"]) for action in actions if action.get("market_id") == market_id and action.get("action_type") not in {"cancel", "hold", "blocked"}}) > 1
    }
    cash_nonnegative = all(_number(row.get("cash_usd")) >= -1e-9 for row in cash_ledger)
    every_position_classified = set(positions) == classified_position_ids
    targets_reproduced = all(row["matches"] for row in target_match_rows)
    caps_pass = bool(
        contract_max <= settings.max_contract_exposure_usd + settings.exposure_rounding_tolerance_usd
        and max([*strict_exposure.values(), 0]) <= settings.max_strict_cluster_exposure_usd + settings.exposure_rounding_tolerance_usd
        and max([*catalyst_exposure.values(), 0]) <= settings.max_common_catalyst_exposure_usd + settings.exposure_rounding_tolerance_usd
    )
    increments_pass = all(
        abs(_number(action["estimated_usd"]) / settings.allocation_increment_usd - round(_number(action["estimated_usd"]) / settings.allocation_increment_usd)) <= 1e-6
        for action in arrays["buys"]
    )
    dependencies_pass = all(
        not action.get("allowed_after_confirmed_exit_action_id")
        or action.get("allowed_after_confirmed_exit_action_id") in action.get("dependency_ids", [])
        for action in arrays["buys"]
    )
    unique_actions = len(action_ids) == len(set(action_ids)) and not contradictory
    plan_certified = all((targets_reproduced, cash_nonnegative, caps_pass, increments_pass, dependencies_pass, every_position_classified, unique_actions))

    plan_without_hash: dict[str, object] = {
        "plan_id": "b008p-" + plan_inputs_hash[:32],
        "run_id": run_id,
        "workflow_profile": WORKFLOW_PROFILE,
        "version": ACTION_PLAN_VERSION,
        "created_at": now.isoformat(),
        "stage4_certificate_hash": stage4_hash,
        "stage4_hash_valid": stage4_hash_valid,
        "portfolio_certified": portfolio_certified,
        "clustering_complete": clustering_complete,
        "wallet_snapshot_fresh": wallet_is_fresh,
        "target_fresh": target_is_fresh,
        "account_identity": account_identity,
        "target_account_matches": target_account_matches,
        "wallet_version": wallet_version(wallet_snapshot),
        "plan_inputs_hash": plan_inputs_hash,
        **arrays,
        "cash_ledger": cash_ledger,
        "simulated_final_wallet": target_match_rows,
        "cluster_exposure_before_after": {
            "strict_after": {key: round(value, 2) for key, value in strict_exposure.items()},
            "common_catalyst_after": {key: round(value, 2) for key, value in catalyst_exposure.items()},
        },
        "metrics": {
            "claims": len(arrays["claims"]), "cancellations": len(arrays["order_cancellations"]),
            "sells": len(arrays["full_exits"]), "trims": len(arrays["trims"]), "buys": len(arrays["buys"]),
            "holds": len(arrays["holds"]), "blocked": len(arrays["blocked_untradeable"]),
            "expected_post_plan_cash": round(cash, 2), "plan_certificate_result": "pass" if plan_certified else "fail",
        },
    }
    plan_hash = stable_hash(plan_without_hash)
    plan_certificate: dict[str, object] = {
        "plan_hash": plan_hash,
        "stage4_certificate_hash": stage4_hash,
        "targets_reproduced": targets_reproduced,
        "cash_nonnegative": cash_nonnegative,
        "contract_and_cluster_caps": caps_pass,
        "buy_increments": increments_pass,
        "dependency_ordering": dependencies_pass,
        "all_wallet_positions_classified": every_position_classified,
        "target_account_matches": target_account_matches,
        "no_duplicate_or_contradictory_action": unique_actions,
        "largest_contract_exposure": round(contract_max, 2),
        "largest_strict_cluster_exposure": round(max([*strict_exposure.values(), 0]), 2),
        "largest_common_catalyst_exposure": round(max([*catalyst_exposure.values(), 0]), 2),
        "plan_certified": plan_certified,
    }
    plan_certificate["certificate_hash"] = stable_hash(plan_certificate)
    return {**plan_without_hash, "plan_hash": plan_hash, "plan_certificate": plan_certificate}


def derive_execution_status(*, counters: dict[str, int], execution_mode: str, cancelled: bool = False) -> tuple[str, str]:
    if cancelled:
        return "cancelled", "Operator or scheduler cancellation was durably recorded."
    planned = counters.get("planned", 0)
    if execution_mode != "shadow" and planned > 0 and counters.get("durable_intents", 0) == 0:
        return "failed", "Failed before intent creation."
    outstanding = counters.get("ready", 0) + counters.get("submitted", 0) + counters.get("partially_filled", 0) + counters.get("recoverable", 0)
    unsuccessful = counters.get("blocked", 0) + counters.get("failed", 0)
    if execution_mode == "shadow" and counters.get("risk_certified", 0) == planned and unsuccessful == 0:
        return "completed", "Shadow validation completed; no remote write was permitted."
    if counters.get("reconciled", 0) == planned and outstanding == 0 and unsuccessful == 0:
        return "completed", "Every required action reached its reconciled terminal state."
    if counters.get("submitted", 0) == 0 and counters.get("durable_intents", 0) == 0 and counters.get("blocked", 0):
        return "blocked", "Execution did not begin because a guardrail failed."
    if counters.get("reconciled", 0) or counters.get("confirmed", 0):
        return "partial", "Some actions succeeded while others remain blocked, failed or pending."
    if unsuccessful:
        return "failed", "No valid completion and at least one unrecovered action failed."
    return "partial", "Execution has durable work that is not yet terminal."


def preflight_execution_plan(
    *,
    plan: dict[str, object],
    stage4_certificate: dict[str, object],
    live_wallet_snapshot: dict[str, object],
    quotes_by_market: dict[str, dict[str, object]],
    pending_orders: list[dict[str, object]],
    settings: Bullpen008Settings,
    execution_mode: str = "shadow",
    emergency_stop: bool = False,
    prerequisite_statuses: dict[str, str] | None = None,
) -> dict[str, object]:
    prerequisite_statuses = prerequisite_statuses or {}
    actions = [
        action for name in ("claims", "order_cancellations", "full_exits", "trims", "buys")
        for action in _rows(plan.get(name))
    ]
    all_plan_rows = _plan_actions(plan)
    cluster_by_market = {
        str(row.get("market_id") or ""): (
            str(row.get("strict_cluster_id") or ""),
            str(row.get("common_catalyst_cluster_id") or ""),
        )
        for row in all_plan_rows
        if row.get("market_id")
    }
    exposure_by_market: dict[str, float] = defaultdict(float)
    shares_by_market_side: dict[tuple[str, str], float] = defaultdict(float)
    for row in _rows(live_wallet_snapshot.get("positions")):
        market_id = str(row.get("market_id") or "")
        exposure_by_market[market_id] += _position_exposure(row)
        shares_by_market_side[(market_id, str(row.get("side") or "").upper())] += _number(row.get("shares"))
    for pending in pending_orders:
        if str(pending.get("action") or "").upper() != "BUY":
            continue
        if str(pending.get("status") or "").lower() not in {"planned", "queued", "ready", "submitting", "submitted", "confirming", "partially_filled", "pending"}:
            continue
        market_id = str(pending.get("market_id") or "")
        exposure_by_market[market_id] += _number(pending.get("remaining_usd"), _number(pending.get("current_order_usd"), _number(pending.get("requested_order_usd"))))
    available_cash = _number(
        (live_wallet_snapshot.get("balance") if isinstance(live_wallet_snapshot.get("balance"), dict) else {}).get("available_balance_usd")
    )
    shared_checks = {
        "workflow_profile": plan.get("workflow_profile") == WORKFLOW_PROFILE,
        "plan_hash": verify_action_plan(plan),
        "stage4_hash": certificate_hash_is_valid(stage4_certificate)
        and plan.get("stage4_certificate_hash") == stage4_certificate.get("certificate_hash"),
        "account_identity": bool(plan.get("account_identity"))
        and plan.get("account_identity") == live_wallet_snapshot.get("account_identity"),
        "emergency_stop": not emergency_stop,
    }
    current_wallet_version = wallet_version(live_wallet_snapshot)
    wallet_changed = current_wallet_version != plan.get("wallet_version")
    results: list[dict[str, object]] = []
    counters = {
        "planned": len(actions), "risk_certified": 0, "ready": 0, "durable_intents": 0,
        "submitted": 0, "confirmed": 0, "partially_filled": 0, "blocked": 0,
        "failed": 0, "recoverable": 0, "reconciled": 0,
    }
    for action in sorted(actions, key=lambda row: int(row.get("priority") or 999)):
        action_type = str(action.get("action_type") or "")
        market_id = str(action.get("market_id") or "")
        quote = quotes_by_market.get(market_id, {})
        dependencies = [str(value) for value in action.get("dependency_ids", [])] if isinstance(action.get("dependency_ids"), list) else []
        checks = dict(shared_checks)
        checks["immutable_action_present"] = any(
            candidate.get("action_id") == action.get("action_id") for candidate in actions
        )
        checks["prerequisites_reconciled"] = execution_mode == "shadow" or all(
            prerequisite_statuses.get(dependency) in {"Reconciled", "Filled", "Cancelled"}
            for dependency in dependencies
        )
        checks["wallet_version"] = not wallet_changed or action_type in {"claim", "cancel"}
        checks["market_open"] = action_type in {"claim", "cancel"} or quote.get("open") is True
        current_odds = _number(quote.get("current_odds"), _number(action.get("quoted_price_cents")))
        checks["buy_odds_at_least_80"] = action_type != "buy" or current_odds >= settings.entry_side_odds_floor_pct
        permitted = _number(action.get("permitted_price_cents"), 100 if action_type == "buy" else 0)
        checks["slippage"] = (
            action_type not in {"buy", "full_exit", "trim"}
            or (current_odds <= permitted if action_type == "buy" else current_odds >= permitted)
        )
        spread = _number(quote.get("spread_cents"))
        checks["spread"] = action_type not in {"buy", "full_exit", "trim"} or spread <= settings.max_spread_cents
        checks["liquidity"] = action_type not in {"buy", "full_exit", "trim"} or _number(quote.get("liquidity_usd"), 1) > 0
        proposed_exposure = exposure_by_market.get(market_id, 0) + (_number(action.get("estimated_usd")) if action_type == "buy" else 0)
        strict_id = str(action.get("strict_cluster_id") or "")
        common_id = str(action.get("common_catalyst_cluster_id") or "")
        strict_after = sum(
            exposure
            for candidate_market, exposure in exposure_by_market.items()
            if cluster_by_market.get(candidate_market, ("", ""))[0] == strict_id
        ) + (_number(action.get("estimated_usd")) if action_type == "buy" else 0)
        common_after = sum(
            exposure
            for candidate_market, exposure in exposure_by_market.items()
            if cluster_by_market.get(candidate_market, ("", ""))[1] == common_id
        ) + (_number(action.get("estimated_usd")) if action_type == "buy" else 0)
        checks["capacity_revalidated"] = action_type != "buy" or (execution_mode == "shadow" and bool(dependencies)) or (
            proposed_exposure <= settings.max_contract_exposure_usd + settings.exposure_rounding_tolerance_usd
            and strict_after <= settings.max_strict_cluster_exposure_usd + settings.exposure_rounding_tolerance_usd
            and common_after <= settings.max_common_catalyst_exposure_usd + settings.exposure_rounding_tolerance_usd
        )
        checks["cash_or_shares_available"] = (
            (execution_mode == "shadow" and bool(dependencies))
            or available_cash + 1e-9 >= _number(action.get("estimated_usd"))
            if action_type == "buy"
            else shares_by_market_side[(market_id, str(action.get("side") or "").upper())] + 1e-9 >= _number(action.get("quantity_shares"))
            if action_type in {"full_exit", "trim"}
            else True
        )
        blocker_codes = [key.upper() for key, passed in checks.items() if not passed]
        if blocker_codes:
            counters["blocked"] += 1
            state = "Blocked"
        else:
            counters["risk_certified"] += 1
            state = "RiskCertified" if execution_mode == "shadow" else "Ready"
            if execution_mode != "shadow":
                counters["ready"] += 1
        results.append(
            {
                "action_id": action.get("action_id"), "action_type": action_type, "market_id": market_id,
                "status": state, "pre_submit_checks": checks, "blocker_codes": blocker_codes,
                "wallet_version_planned": plan.get("wallet_version"), "wallet_version_live": current_wallet_version,
                "quote": quote, "remediation": (
                    "Run a new Stage 3/4/5 cycle; never substitute another contract."
                    if blocker_codes else "No remote submission in shadow mode." if execution_mode == "shadow" else "Create the durable intent before submission."
                ),
            }
        )
    status, status_reason = derive_execution_status(counters=counters, execution_mode=execution_mode)
    return {
        "version": EXECUTION_VERSION,
        "execution_mode": execution_mode,
        "shared_checks": shared_checks,
        "wallet_version_changed": wallet_changed,
        "actions": results,
        "counters": counters,
        "terminal_status": status,
        "terminal_reason": status_reason,
        "orders_submitted": 0,
        "remote_writes_permitted": execution_mode == "live" and settings.live_control_armed,
        "pending_order_count_in_capacity": len(pending_orders),
    }
