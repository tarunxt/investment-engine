from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from statistics import mean
from math import isfinite
from datetime import UTC, datetime
from typing import Any


def _read(item: Mapping[str, Any] | object, key: str) -> Any:
    if isinstance(item, Mapping):
        return item.get(key)
    return getattr(item, key, None)


def _to_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if isfinite(value) else None
    if isinstance(value, str):
        cleaned = value.replace("$", "").replace("%", "").replace(",", "").strip()
        if not cleaned:
            return None
        try:
            numeric = float(cleaned)
            return numeric if isfinite(numeric) else None
        except ValueError:
            return None
    return None


def _to_int(value: Any) -> int | None:
    numeric = _to_float(value)
    if numeric is None:
        return None
    return int(numeric)


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y"}
    return bool(value)


def _normalize_tags(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return []
    tags: list[str] = []
    seen: set[str] = set()
    for item in value:
        if isinstance(item, str):
            label = item.strip()
        elif isinstance(item, Mapping):
            raw = item.get("label") or item.get("tag") or item.get("name")
            label = str(raw).strip() if raw is not None else ""
        else:
            label = str(item).strip()
        if not label:
            continue
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        tags.append(label)
    return tags


def confidence_bucket(value: float | None) -> str:
    if value is None:
        return "Unknown"
    if value < 0.4:
        return "Low"
    if value < 0.7:
        return "Medium"
    return "High"


def spread_bucket(value: float | None) -> str:
    if value is None:
        return "Unknown"
    if value <= 2:
        return "0-2c"
    if value <= 5:
        return "2-5c"
    if value <= 10:
        return "5-10c"
    return "10c+"


def liquidity_bucket(value: float | None) -> str:
    if value is None:
        return "Unknown"
    if value < 1_000:
        return "<$1k"
    if value < 5_000:
        return "$1k-$5k"
    if value < 20_000:
        return "$5k-$20k"
    return "$20k+"


def _bucket_metric(
    trades: Sequence[Mapping[str, Any] | object],
    *,
    value_key: str,
    bucket_fn,
) -> list[dict[str, Any]]:
    grouped: dict[str, list[float]] = defaultdict(list)
    for trade in trades:
        bucket = bucket_fn(_to_float(_read(trade, value_key)))
        pnl = _to_float(_read(trade, "net_pnl"))
        if pnl is None:
            continue
        grouped[bucket].append(pnl)
    return [
        {
            "bucket": bucket,
            "count": len(values),
            "average_pnl": round(mean(values), 4),
            "total_pnl": round(sum(values), 4),
        }
        for bucket, values in grouped.items()
    ]


ANALYSIS_VERSION = "bullpen-descriptive-v2"


def normalize_declared_price(value: Any, unit: str | None) -> float | None:
    """Normalize declared operands only; magnitude never establishes provenance."""
    numeric = _to_float(value)
    if numeric is None or not isinstance(unit, str) or unit not in {"cents", "unit_price"}:
        return None
    normalized = numeric / 100 if unit == "cents" else numeric
    return normalized if 0 <= normalized <= 1 else None


def generate_bullpen_post_trade_analysis(
    trade: Mapping[str, Any] | object,
) -> dict[str, Any]:
    pnl = _to_float(_read(trade, "net_pnl"))
    confidence = _to_float(_read(trade, "buy_confidence"))
    liquidity = _to_float(_read(trade, "buy_liquidity_score"))
    spread = _to_float(_read(trade, "buy_spread_score"))
    known_fees = _to_float(_read(trade, "fees_total"))
    facts = []
    leads = []
    if pnl is None:
        summary = "Net P&L is unknown; outcome not evaluated."
    else:
        outcome = "gain" if pnl > 0 else "loss" if pnl < 0 else "breakeven"
        summary = f"Recorded net P&L {outcome} of {pnl:.2f}."
        if known_fees is None:
            summary += " Execution fee coverage is unknown; complete after-cost result is not verified."
    if confidence is not None:
        facts.append(f"Recorded confidence: {confidence:g}; scale/calibration not evaluated.")
    if confidence is not None and confidence >= .75 and pnl is not None and pnl < 0:
        leads.append("High recorded confidence and a loss co-occurred; this does not establish miscalibration or cause.")
    if liquidity is not None and liquidity < .35:
        leads.append("Low recorded liquidity score; any causal explanation is an unvalidated hypothesis for human review.")
    if spread is not None and spread < .35:
        leads.append("Low recorded spread score; any causal explanation is an unvalidated hypothesis for human review.")
    metadata = _read(trade, "metadata_json") or {}
    contract = metadata.get("analysis_price_contract", {}) if isinstance(metadata, Mapping) else {}
    if not isinstance(contract, Mapping):
        contract = {}
    raw_peak = _to_float(_read(trade, "best_possible_exit_price_after_buy"))
    raw_fill = _to_float(_read(trade, "sell_average_fill_price"))
    return {
        "algorithm_version": ANALYSIS_VERSION,
        "calculated_at": datetime.now(UTC).isoformat(),
        "source_trade_id": str(_read(trade, "id")) if _read(trade, "id") is not None else None,
        "evidence_status": "descriptive_not_validated",
        "analysis_summary": summary,
        "mistake_category": "NOT_EVALUATED",
        "improvement_suggestion": "Review descriptive evidence; no policy change is validated.",
        "reinforcement_signal": "NOT_EVALUATED",
        "reinforcement_score": None,
        "should_avoid_similar_trade": False,
        "should_increase_confidence_for_similar_trade": False,
        "human_review_required": bool(leads),
        "what_worked": facts,
        "what_went_wrong": leads,
        "exit_timing": "not evaluated",
        "entry_too_expensive": False,
        "liquidity_or_spread_issue": bool(leads and ((liquidity is not None and liquidity < .35) or (spread is not None and spread < .35))),
        "llm_confidence_aligned": None,
        "confidence_alignment_status": "not_evaluated",
        "suggested_platform_rule_changes": [],
        "suggested_prompt_changes": [],
        "suggested_risk_management_changes": [],
        "sell_reason": _read(trade, "sell_reason"),
        "exit_analysis": {
            "status": "not_evaluated",
            "reason": "No approved bounded post-exit window or timestamped executable liquidity/cost evidence.",
            "in_hold_maximum_raw": raw_peak,
            "in_hold_maximum_unit": contract.get("in_hold_maximum_unit"),
            "in_hold_maximum_unit_price": normalize_declared_price(raw_peak, contract.get("in_hold_maximum_unit")),
            "fill_raw": raw_fill,
            "fill_unit": contract.get("fill_unit"),
            "fill_unit_price": normalize_declared_price(raw_fill, contract.get("fill_unit")) if contract.get("fill_source") == "verified_execution" else None,
            "fill_source": contract.get("fill_source", "unknown"),
            "requested_price_raw": _to_float(_read(trade, "sell_requested_price")),
            "interpretation": "In-position observation; not an executable post-exit best price.",
        },
    }


def build_trade_learning_insights(
    trades: Sequence[Mapping[str, Any] | object],
) -> dict[str, Any]:
    closed = [trade for trade in trades if _read(trade, "closed_at") is not None]
    tag_population_counts: dict[str, int] = defaultdict(int)
    for trade in closed:
        for tag in _normalize_tags(_read(trade, "buy_computed_tags_json")):
            tag_population_counts[tag] += 1
    tags_stats: dict[str, list[float]] = defaultdict(list)
    strategy_stats: dict[str, list[float]] = defaultdict(list)
    exit_reason_stats: dict[str, list[float]] = defaultdict(list)
    buy_reason_stats: dict[str, list[float]] = defaultdict(list)
    high_confidence_losses = 0
    low_liquidity_losses = 0
    winner_holds: list[int] = []
    loser_holds: list[int] = []

    for trade in closed:
        pnl = _to_float(_read(trade, "net_pnl"))
        if pnl is None:
            continue
        for tag in _normalize_tags(_read(trade, "buy_computed_tags_json")):
            tags_stats[tag].append(pnl)
        strategy = str(_read(trade, "strategy_version") or "unknown").strip()
        strategy_stats[strategy].append(pnl)
        exit_reason = str(_read(trade, "sell_reason") or _read(trade, "exit_type") or "unknown").strip()
        buy_reason = str(_read(trade, "buy_reason") or "unknown").strip()
        exit_reason_stats[exit_reason].append(pnl)
        buy_reason_stats[buy_reason].append(pnl)

        if (_to_float(_read(trade, "buy_confidence")) or 0) >= 0.75 and pnl < 0:
            high_confidence_losses += 1
        if _to_float(_read(trade, "buy_liquidity_score")) is not None and _to_float(_read(trade, "buy_liquidity_score")) < 0.35 and pnl < 0:
            low_liquidity_losses += 1

        hold = _to_int(_read(trade, "holding_period_seconds"))
        if hold is not None:
            if pnl >= 0:
                winner_holds.append(hold)
            else:
                loser_holds.append(hold)

    profitable_tags = sorted(
        (
            {
                "tag": tag,
                "count": len(values),
                "average_pnl": round(mean(values), 4),
                "total_pnl": round(sum(values), 4),
            }
            for tag, values in tags_stats.items()
            if values and mean(values) > 0
        ),
        key=lambda item: (item["average_pnl"], item["total_pnl"]),
        reverse=True,
    )
    unprofitable_tags = sorted(
        (
            {
                "tag": tag,
                "count": len(values),
                "average_pnl": round(mean(values), 4),
                "total_pnl": round(sum(values), 4),
            }
            for tag, values in tags_stats.items()
            if values and mean(values) < 0
        ),
        key=lambda item: (item["average_pnl"], item["total_pnl"]),
    )

    recommendations = ["Descriptive selected-cohort results only; no weight, confidence or risk change is validated."]

    return {
        "tag_population_counts": dict(tag_population_counts),
        "win_rate_by_tag": profitable_tags + unprofitable_tags,
        "average_pnl_by_tag": profitable_tags + unprofitable_tags,
        "total_pnl_by_strategy_version": [
            {
                "strategy_version": strategy,
                "count": len(values),
                "total_pnl": round(sum(values), 4),
                "average_pnl": round(mean(values), 4),
            }
            for strategy, values in strategy_stats.items()
        ],
        "average_pnl_by_confidence_bucket": _bucket_metric(
            closed,
            value_key="buy_confidence",
            bucket_fn=confidence_bucket,
        ),
        "average_pnl_by_spread_bucket": _bucket_metric(
            closed,
            value_key="buy_spread_score",
            bucket_fn=spread_bucket,
        ),
        "average_pnl_by_liquidity_bucket": _bucket_metric(
            closed,
            value_key="buy_liquidity_score",
            bucket_fn=liquidity_bucket,
        ),
        "losses_caused_by_low_liquidity": 0,  # Legacy causal field cannot assert causation.
        "losses_with_low_liquidity": low_liquidity_losses,
        "evidence_status": "insufficient",
        "validated_recommendations": [],
        "closed_count": len(closed),
        "known_outcome_count": sum(_to_float(_read(t, "net_pnl")) is not None for t in closed),
        "unknown_outcome_count": sum(_to_float(_read(t, "net_pnl")) is None for t in closed),
        "limitations": ["Selected cohort; raw-dollar means are not risk/stake matched.", "Event dependence, model versions and effective sample size are not validated.", "Costs/exposure, frozen candidate definitions, uncertainty, multiplicity and untouched chronological test are unverified."],
        "high_confidence_losses": high_confidence_losses,
        "profitable_tags": profitable_tags,
        "unprofitable_tags": unprofitable_tags,
        "average_holding_period_winners_seconds": round(mean(winner_holds), 2)
        if winner_holds
        else None,
        "average_holding_period_losers_seconds": round(mean(loser_holds), 2)
        if loser_holds
        else None,
        "exit_reasons_ranked_by_pnl": sorted(
            (
                {
                    "reason": reason,
                    "count": len(values),
                    "average_pnl": round(mean(values), 4),
                    "total_pnl": round(sum(values), 4),
                }
                for reason, values in exit_reason_stats.items()
            ),
            key=lambda item: (item["average_pnl"], item["total_pnl"]),
            reverse=True,
        ),
        "buy_reasons_ranked_by_pnl": sorted(
            (
                {
                    "reason": reason,
                    "count": len(values),
                    "average_pnl": round(mean(values), 4),
                    "total_pnl": round(sum(values), 4),
                }
                for reason, values in buy_reason_stats.items()
            ),
            key=lambda item: (item["average_pnl"], item["total_pnl"]),
            reverse=True,
        ),
        "recommendations": recommendations,
    }
