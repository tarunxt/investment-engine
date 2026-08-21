from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from statistics import mean
from typing import Any


def _read(item: Mapping[str, Any] | object, key: str) -> Any:
    if isinstance(item, Mapping):
        return item.get(key)
    return getattr(item, key, None)


def _to_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace("$", "").replace("%", "").replace(",", "").strip()
        if not cleaned:
            return None
        try:
            return float(cleaned)
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


def generate_bullpen_post_trade_analysis(
    trade: Mapping[str, Any] | object,
) -> dict[str, Any]:
    net_pnl = _to_float(_read(trade, "net_pnl")) or 0.0
    buy_notional = _to_float(_read(trade, "buy_notional")) or _to_float(
        _read(trade, "buy_filled_amount")
    )
    fees_total = _to_float(_read(trade, "fees_total")) or 0.0
    buy_spread = _to_float(_read(trade, "buy_spread_score"))
    buy_liquidity = _to_float(_read(trade, "buy_liquidity_score"))
    buy_probability_delta = _to_float(_read(trade, "buy_probability_delta"))
    buy_confidence = _to_float(_read(trade, "buy_confidence"))
    best_possible_exit = _to_float(_read(trade, "best_possible_exit_price_after_buy"))
    exit_price = _to_float(_read(trade, "sell_average_fill_price")) or _to_float(
        _read(trade, "sell_requested_price")
    )
    drawdown = _to_float(_read(trade, "drawdown_while_held"))
    sell_reason = str(_read(trade, "sell_reason") or "").strip()
    final_tag = str(_read(trade, "final_tag") or "").strip()

    reinforcement_signal = "NEUTRAL"
    reinforcement_score = 0.0
    pnl_percent = _to_float(_read(trade, "pnl_percent"))
    if net_pnl > 0:
        reinforcement_signal = "REWARD"
        reinforcement_score = min(1.0, max(0.1, abs(net_pnl) / max(buy_notional or 1, 1)))
    elif net_pnl < 0:
        reinforcement_signal = "PENALTY"
        reinforcement_score = -min(
            1.0,
            max(0.1, abs(net_pnl) / max(buy_notional or 1, 1)),
        )

    what_worked: list[str] = []
    what_went_wrong: list[str] = []
    suggestions: list[str] = []
    mistake_category = "NONE"
    human_review_required = False
    should_avoid_similar_trade = False
    should_increase_confidence = False

    if net_pnl > 0:
        what_worked.append("The trade closed green after fees.")
    elif net_pnl < 0:
        what_went_wrong.append("The trade finished red after fees.")

    if buy_liquidity is not None and buy_liquidity < 0.35:
        mistake_category = "LOW_LIQUIDITY"
        what_went_wrong.append("Entry liquidity was weak.")
        suggestions.append(
            "Require stronger liquidity confirmation before buying low-volume markets."
        )
        should_avoid_similar_trade = net_pnl < 0

    if buy_spread is not None and buy_spread < 0.35:
        mistake_category = "POOR_LIQUIDITY_OR_SPREAD"
        what_went_wrong.append("The spread was wide when the position was opened.")
        suggestions.append("Avoid buying when spreadScore falls below 0.35.")
        should_avoid_similar_trade = net_pnl < 0

    if buy_confidence is not None and buy_confidence >= 0.75 and net_pnl < 0:
        mistake_category = "OVERCONFIDENT_LLM"
        what_went_wrong.append("Model confidence was high, but the outcome still lost.")
        suggestions.append(
            "Reduce confidence weight when the model is highly certain but the market edge is small."
        )
        human_review_required = True

    if (
        buy_probability_delta is not None
        and abs(buy_probability_delta) < 3
        and net_pnl < 0
    ):
        mistake_category = "WEAK_EDGE"
        what_went_wrong.append("The entry edge was narrow relative to market pricing.")
        suggestions.append("Penalize trades where probability delta is smaller than 3 points.")

    if buy_notional and fees_total > 0 and net_pnl >= 0 and fees_total >= max(abs(net_pnl), 0.01):
        mistake_category = "FEE_DRAG"
        what_went_wrong.append("Fees consumed most of the gross edge.")
        suggestions.append("Increase minimum expected value so fees do not erase the trade edge.")

    if drawdown is not None and drawdown <= -0.15 and net_pnl < 0:
        mistake_category = "LATE_EXIT"
        what_went_wrong.append("The trade absorbed a large adverse move before exit.")
        suggestions.append("Increase exit urgency after a fast adverse move exceeds 15%.")

    if (
        best_possible_exit is not None
        and exit_price is not None
        and best_possible_exit > exit_price * 1.2
        and net_pnl >= 0
    ):
        mistake_category = "EARLY_EXIT"
        what_went_wrong.append("The position kept improving after the exit.")
        suggestions.append("Give profitable trades slightly more time before exiting when momentum stays favorable.")

    if net_pnl > 0 and (buy_liquidity or 0) >= 0.6 and (buy_confidence or 0) >= 0.6:
        what_worked.append("Confidence and liquidity were both supportive.")
        suggestions.append("Increase weight for setups that combine solid liquidity with confident LLM agreement.")
        should_increase_confidence = True

    if final_tag in {"REDEEMED", "RULE_EXIT", "LLM_EXIT"}:
        what_worked.append(f"Exit path followed the {final_tag.lower().replace('_', ' ')} workflow.")

    exit_timing = "reasonable"
    if mistake_category == "LATE_EXIT":
        exit_timing = "too late"
    elif mistake_category == "EARLY_EXIT":
        exit_timing = "too early"

    if not suggestions:
        suggestions.append("Keep monitoring more closed trades before changing the rules.")

    analysis_summary = (
        f"Net P&L {'gain' if net_pnl >= 0 else 'loss'} of {net_pnl:.2f}"
        + (f" ({pnl_percent:.2f}%)." if pnl_percent is not None else ".")
    )
    if what_went_wrong:
        analysis_summary += f" Main issue: {what_went_wrong[0]}"
    elif what_worked:
        analysis_summary += f" Main strength: {what_worked[0]}"

    return {
        "analysis_summary": analysis_summary,
        "mistake_category": mistake_category,
        "improvement_suggestion": suggestions[0],
        "reinforcement_signal": reinforcement_signal,
        "reinforcement_score": round(reinforcement_score, 4),
        "should_avoid_similar_trade": should_avoid_similar_trade,
        "should_increase_confidence_for_similar_trade": should_increase_confidence,
        "human_review_required": human_review_required,
        "what_worked": what_worked,
        "what_went_wrong": what_went_wrong,
        "exit_timing": exit_timing,
        "entry_too_expensive": bool(net_pnl < 0 and buy_probability_delta is not None and buy_probability_delta < 0),
        "liquidity_or_spread_issue": bool(
            (buy_liquidity is not None and buy_liquidity < 0.35)
            or (buy_spread is not None and buy_spread < 0.35)
        ),
        "llm_confidence_aligned": bool(
            (buy_confidence is None)
            or (net_pnl >= 0 and buy_confidence >= 0.6)
            or (net_pnl < 0 and buy_confidence < 0.75)
        ),
        "suggested_platform_rule_changes": suggestions,
        "suggested_prompt_changes": [
            "Ask the model to explicitly justify why the edge is large enough after fees."
        ]
        if mistake_category in {"OVERCONFIDENT_LLM", "WEAK_EDGE"}
        else [],
        "suggested_risk_management_changes": [
            "Escalate human review for high-confidence losses and repeated low-liquidity losses."
        ]
        if human_review_required or should_avoid_similar_trade
        else [],
        "sell_reason": sell_reason or None,
    }


def build_trade_learning_insights(
    trades: Sequence[Mapping[str, Any] | object],
) -> dict[str, Any]:
    closed = [trade for trade in trades if _read(trade, "closed_at") is not None]
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
        if (_to_float(_read(trade, "buy_liquidity_score")) or 1) < 0.35 and pnl < 0:
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

    recommendations: list[str] = []
    if low_liquidity_losses > 0:
        recommendations.append(
            "Losses cluster in weak-liquidity entries. Raise the minimum liquidity threshold."
        )
    if high_confidence_losses > 0:
        recommendations.append(
            "High-confidence losses are present. Recalibrate confidence thresholds before scaling size."
        )
    if unprofitable_tags:
        recommendations.append(
            f"Reduce weight for tag {unprofitable_tags[0]['tag']} because it underperformed."
        )
    if profitable_tags:
        recommendations.append(
            f"Increase weight for tag {profitable_tags[0]['tag']} because it produced the best average P&L."
        )

    return {
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
        "losses_caused_by_low_liquidity": low_liquidity_losses,
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
