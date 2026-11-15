"""Bullpen 008 held-position alert episodes with hysteresis."""

from __future__ import annotations

from app.domains.bullpen008.engine import stable_hash


def evaluate_held_position_alerts(
    *,
    positions: list[dict[str, object]],
    stage2_rows: list[dict[str, object]],
    active_episodes: set[tuple[str, str]],
    episode_versions: dict[tuple[str, str], int] | None = None,
    threshold: float = 80,
    recovery_hysteresis: float = 2,
) -> dict[str, object]:
    episode_versions = episode_versions or {}
    llm_by_market = {str(row.get("market_id") or ""): row for row in stage2_rows}
    alerts: list[dict[str, object]] = []
    recoveries: list[dict[str, object]] = []
    for position in positions:
        market_id = str(position.get("market_id") or "")
        side = str(position.get("side") or "").upper()
        if not market_id or side not in {"YES", "NO"}:
            continue
        analysis = llm_by_market.get(market_id, {})
        yes_llm = analysis.get("llm_yes_probability")
        no_llm = analysis.get("llm_no_probability")
        llm_odds = yes_llm if side == "YES" else no_llm
        actual_odds = position.get("current_yes_odds") if side == "YES" else position.get("current_no_odds")
        llm_value = float(llm_odds) if isinstance(llm_odds, (int, float)) else None
        actual_value = float(actual_odds) if isinstance(actual_odds, (int, float)) else None
        llm_breach = llm_value is not None and llm_value < threshold
        actual_breach = actual_value is not None and actual_value < threshold
        episode = (market_id, side)
        if llm_breach or actual_breach:
            breach_type = "both" if llm_breach and actual_breach else "llm" if llm_breach else "actual"
            if episode not in active_episodes:
                alerts.append(
                    {
                        "market_id": market_id,
                        "side": side,
                        "question": position.get("market_title") or analysis.get("question") or market_id,
                        "llm_odds": llm_value,
                        "actual_odds": actual_value,
                        "threshold": threshold,
                        "breach_type": breach_type,
                        "idempotency_key": "bullpen008-alert-" + stable_hash(
                            {"market_id": market_id, "side": side, "threshold": threshold, "episode": episode_versions.get(episode, 0) + 1}
                        )[:40],
                    }
                )
        elif episode in active_episodes and (
            (llm_value is None or llm_value >= threshold + recovery_hysteresis)
            and (actual_value is None or actual_value >= threshold + recovery_hysteresis)
        ):
            recoveries.append({"market_id": market_id, "side": side, "llm_odds": llm_value, "actual_odds": actual_value})
    return {"alerts": alerts, "recoveries": recoveries, "threshold": threshold, "recovery_hysteresis": recovery_hysteresis}
