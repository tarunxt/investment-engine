from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Sequence

from pydantic import BaseModel, Field

ExitStrategy = Literal[
    "OUTSIDE_TOP_10_RETURNS_DAY",
    "LLM_OR_ODDS_FILTER_EXIT",
    "CAPITAL_AWARE_FORCED_EXIT",
]
ExitSeverity = Literal[
    "INFO",
    "WATCH_FAST",
    "PLANNED_EXIT",
    "IMMEDIATE_EXIT",
    "DUST_LOST",
]
ExitReasonCode = Literal[
    "OUTSIDE_TOP_10_BY_RETURNS_DAY",
    "LLM_FILTER_FAILED",
    "ODDS_FILTER_FAILED",
    "ADVERSE_MARKET_99_5",
    "ADVERSE_MARKET_99",
    "HELD_SIDE_BID_BELOW_0_5_CENTS",
    "HELD_SIDE_DROP_10_POINTS_1M",
    "HELD_SIDE_DROP_15_POINTS_1M",
    "HELD_SIDE_DROP_25_POINTS_5M",
    "EVENT_CLOSE_PASSED",
    "LOW_EXECUTABLE_VALUE",
    "NO_BID_AVAILABLE",
]
ExitState = Literal[
    "ACTIVE",
    "WATCH_FAST",
    "EVENT_EXIT_PLANNED",
    "SELL_SUBMITTED",
    "PARTIALLY_FILLED",
    "SOLD",
    "DUST_LOST",
    "FAILED",
]


class ExitSignalMetrics(BaseModel):
    currentYes: float | None = Field(default=None, ge=0, le=1)
    currentNo: float | None = Field(default=None, ge=0, le=1)
    heldProbability: float | None = Field(default=None, ge=0, le=1)
    adverseProbability: float | None = Field(default=None, ge=0, le=1)
    heldBestBid: float | None = Field(default=None, ge=0)
    shares: float | None = Field(default=None, ge=0)
    avgPrice: float | None = Field(default=None, ge=0)
    estimatedFreeableValue: float | None = None
    drop1m: float | None = None
    drop5m: float | None = None
    adverseRise1m: float | None = None
    adverseRise5m: float | None = None
    timeToCloseHours: float | None = None


class ExitSignal(BaseModel):
    strategy: ExitStrategy
    severity: ExitSeverity
    reasonCode: ExitReasonCode
    label: str
    description: str
    score: float | None = None
    createdAt: str
    metrics: ExitSignalMetrics | None = None


class PositionPriceSnapshot(BaseModel):
    positionId: str
    marketId: str
    tokenId: str
    timestamp: str
    currentYes: float
    currentNo: float
    heldProbability: float
    adverseProbability: float
    heldBestBid: float | None = Field(default=None, ge=0)


@dataclass(frozen=True)
class ForcedExitConfig:
    immediate_adverse_probability: float = 0.995
    confirmed_adverse_probability: float = 0.99
    confirmed_held_probability_max: float = 0.01
    held_best_bid_dust_threshold: float = 0.005
    watch_fast_adverse_probability: float = 0.90
    watch_fast_drop_1m: float = -0.10
    momentum_forced_drop_1m: float = -0.15
    momentum_forced_adverse_probability: float = 0.85
    momentum_forced_drop_5m: float = -0.25
    momentum_forced_5m_adverse_probability: float = 0.80
    score_planned_exit: float = 85
    score_watch_fast: float = 60
    min_net_proceeds: float = 0.01
    min_snapshots_for_confirmed_exit: int = 2
    confirmation_window_seconds: int = 15


DEFAULT_FORCED_EXIT_CONFIG = ForcedExitConfig()


@dataclass(frozen=True)
class EventExitSnapshot:
    position_id: str
    market_id: str
    token_id: str
    held_side: str | None
    shares: float
    avg_price: float | None
    current_yes_probability: float | None
    current_no_probability: float | None
    held_best_bid: float | None
    close_time: str | None
    llm_probability_held: float | None = None


@dataclass(frozen=True)
class RankingAndLlmExitContext:
    top_active_position_keys: set[str]
    current_position_key: str
    current_yes_probability: float | None
    current_no_probability: float | None
    selected_side: str | None
    held_side: str | None
    minimum_market_probability: float = 0.05
    now: datetime | None = None


@dataclass(frozen=True)
class EventExitContext:
    ranking: RankingAndLlmExitContext
    snapshot: EventExitSnapshot
    price_history: Sequence[PositionPriceSnapshot]
    config: ForcedExitConfig = DEFAULT_FORCED_EXIT_CONFIG
    now: datetime | None = None


@dataclass(frozen=True)
class EventExitEvaluation:
    exit_signals: list[ExitSignal]
    exit_state: ExitState


def _utc_now(value: datetime | None = None) -> datetime:
    if value is None:
        return datetime.now(UTC)
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _iso_now(value: datetime | None = None) -> str:
    return _utc_now(value).astimezone(UTC).isoformat()


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _round_metric(value: float | None, digits: int = 4) -> float | None:
    if value is None:
        return None
    return round(value, digits)


def _clamp_probability(value: float | None) -> float | None:
    if value is None:
        return None
    return min(1.0, max(0.0, value))


def _build_metrics(
    snapshot: EventExitSnapshot,
    *,
    held_probability: float | None,
    adverse_probability: float | None,
    estimated_freeable_value: float | None,
    drop_1m: float | None,
    drop_5m: float | None,
    adverse_rise_1m: float | None,
    adverse_rise_5m: float | None,
    time_to_close_hours: float | None,
) -> ExitSignalMetrics:
    return ExitSignalMetrics(
        currentYes=_round_metric(snapshot.current_yes_probability),
        currentNo=_round_metric(snapshot.current_no_probability),
        heldProbability=_round_metric(held_probability),
        adverseProbability=_round_metric(adverse_probability),
        heldBestBid=_round_metric(snapshot.held_best_bid),
        shares=_round_metric(snapshot.shares, 6),
        avgPrice=_round_metric(snapshot.avg_price),
        estimatedFreeableValue=_round_metric(estimated_freeable_value),
        drop1m=_round_metric(drop_1m),
        drop5m=_round_metric(drop_5m),
        adverseRise1m=_round_metric(adverse_rise_1m),
        adverseRise5m=_round_metric(adverse_rise_5m),
        timeToCloseHours=_round_metric(time_to_close_hours, 2),
    )


def _signal(
    *,
    strategy: ExitStrategy,
    severity: ExitSeverity,
    reason_code: ExitReasonCode,
    label: str,
    description: str,
    created_at: str,
    metrics: ExitSignalMetrics | None,
    score: float | None = None,
) -> ExitSignal:
    return ExitSignal(
        strategy=strategy,
        severity=severity,
        reasonCode=reason_code,
        label=label,
        description=description,
        createdAt=created_at,
        score=_round_metric(score, 2),
        metrics=metrics,
    )


def dedupe_exit_signals(signals: Sequence[ExitSignal]) -> list[ExitSignal]:
    deduped: dict[tuple[str, str], ExitSignal] = {}
    severity_rank = {
        "INFO": 0,
        "WATCH_FAST": 1,
        "PLANNED_EXIT": 2,
        "IMMEDIATE_EXIT": 3,
        "DUST_LOST": 4,
    }
    for signal in signals:
        key = (signal.strategy, signal.reasonCode)
        existing = deduped.get(key)
        if existing is None or severity_rank[signal.severity] > severity_rank[existing.severity]:
            deduped[key] = signal
    return list(deduped.values())


def derive_exit_state(signals: Sequence[ExitSignal]) -> ExitState:
    if not signals:
        return "ACTIVE"
    severities = {signal.severity for signal in signals}
    if "DUST_LOST" in severities:
        return "DUST_LOST"
    if "IMMEDIATE_EXIT" in severities or "PLANNED_EXIT" in severities:
        return "EVENT_EXIT_PLANNED"
    if severities == {"WATCH_FAST"}:
        return "WATCH_FAST"
    return "ACTIVE"


def summarize_exit_labels(signals: Sequence[ExitSignal]) -> str:
    unique_labels: list[str] = []
    for signal in signals:
        if signal.label not in unique_labels:
            unique_labels.append(signal.label)
    return "; ".join(unique_labels)


def build_position_price_snapshot(
    snapshot: EventExitSnapshot,
    *,
    held_probability: float | None = None,
    adverse_probability: float | None = None,
    timestamp: str | None = None,
) -> PositionPriceSnapshot | None:
    if (
        snapshot.current_yes_probability is None
        or snapshot.current_no_probability is None
        or held_probability is None
        or adverse_probability is None
    ):
        return None
    return PositionPriceSnapshot(
        positionId=snapshot.position_id,
        marketId=snapshot.market_id,
        tokenId=snapshot.token_id,
        timestamp=timestamp or _iso_now(),
        currentYes=round(snapshot.current_yes_probability, 4),
        currentNo=round(snapshot.current_no_probability, 4),
        heldProbability=round(held_probability, 4),
        adverseProbability=round(adverse_probability, 4),
        heldBestBid=_round_metric(snapshot.held_best_bid),
    )


def merge_price_history(
    history: Sequence[PositionPriceSnapshot],
    current: PositionPriceSnapshot | None,
    *,
    max_age_seconds: int = 900,
) -> list[PositionPriceSnapshot]:
    if current is None:
        return list(history)

    now = _parse_iso(current.timestamp)
    if now is None:
        return [*history, current]

    merged = [snapshot for snapshot in history if snapshot.positionId == current.positionId]
    merged.append(current)
    deduped: dict[str, PositionPriceSnapshot] = {
        snapshot.timestamp: snapshot for snapshot in merged
    }
    retained = []
    for snapshot in sorted(
        deduped.values(),
        key=lambda item: _parse_iso(item.timestamp) or datetime.min.replace(tzinfo=UTC),
    ):
        snapshot_at = _parse_iso(snapshot.timestamp)
        if snapshot_at is None:
            continue
        if (now - snapshot_at).total_seconds() <= max_age_seconds:
            retained.append(snapshot)
    return retained


def evaluate_ranking_and_llm_exit(
    context: RankingAndLlmExitContext,
) -> list[ExitSignal]:
    created_at = _iso_now(context.now)
    signals: list[ExitSignal] = []

    if context.current_position_key not in context.top_active_position_keys:
        signals.append(
            _signal(
                strategy="OUTSIDE_TOP_10_RETURNS_DAY",
                severity="PLANNED_EXIT",
                reason_code="OUTSIDE_TOP_10_BY_RETURNS_DAY",
                label="Outside Top 10",
                description="Position is outside the top 10 by Returns/day and may be sold to free capital.",
                created_at=created_at,
                metrics=None,
            )
        )

    if context.held_side and (context.selected_side is None or context.selected_side != context.held_side):
        signals.append(
            _signal(
                strategy="LLM_OR_ODDS_FILTER_EXIT",
                severity="PLANNED_EXIT",
                reason_code="LLM_FILTER_FAILED",
                label="LLM / Odds Filter Exit",
                description="Position no longer passes the LLM or odds requirements for active Bullpen positions.",
                created_at=created_at,
                metrics=None,
            )
        )

    if (
        context.current_yes_probability is None
        or context.current_no_probability is None
        or context.current_yes_probability < context.minimum_market_probability
        or context.current_no_probability < context.minimum_market_probability
    ):
        signals.append(
            _signal(
                strategy="LLM_OR_ODDS_FILTER_EXIT",
                severity="PLANNED_EXIT",
                reason_code="ODDS_FILTER_FAILED",
                label="LLM / Odds Filter Exit",
                description="Position no longer passes the LLM or odds requirements for active Bullpen positions.",
                created_at=created_at,
                metrics=None,
            )
        )

    return dedupe_exit_signals(signals)


def _held_and_adverse_probabilities(snapshot: EventExitSnapshot) -> tuple[float | None, float | None]:
    held_side = (snapshot.held_side or "").upper()
    yes_probability = _clamp_probability(snapshot.current_yes_probability)
    no_probability = _clamp_probability(snapshot.current_no_probability)
    if held_side == "YES":
        return yes_probability, no_probability
    if held_side == "NO":
        return no_probability, yes_probability
    return None, None


def _time_to_close_hours(close_time: str | None, now: datetime) -> float | None:
    parsed = _parse_iso(close_time)
    if parsed is None:
        return None
    return round((parsed - now).total_seconds() / 3600, 4)


def _pick_lookback_snapshot(
    history: Sequence[PositionPriceSnapshot],
    *,
    reference_time: datetime,
    target_seconds: int,
) -> PositionPriceSnapshot | None:
    target_time = reference_time.timestamp() - target_seconds
    eligible: list[tuple[float, PositionPriceSnapshot]] = []
    for snapshot in history:
        parsed = _parse_iso(snapshot.timestamp)
        if parsed is None:
            continue
        delta = reference_time.timestamp() - parsed.timestamp()
        if delta < target_seconds:
            continue
        eligible.append((abs(delta - target_seconds), snapshot))
    if not eligible:
        return None
    eligible.sort(key=lambda item: item[0])
    return eligible[0][1]


def _confirmed_adverse_snapshots(
    history: Sequence[PositionPriceSnapshot],
    *,
    config: ForcedExitConfig,
) -> bool:
    qualifying: list[datetime] = []
    for snapshot in history:
        if (
            snapshot.adverseProbability >= config.confirmed_adverse_probability
            and snapshot.heldProbability <= config.confirmed_held_probability_max
        ):
            parsed = _parse_iso(snapshot.timestamp)
            if parsed is not None:
                qualifying.append(parsed)
    if len(qualifying) < config.min_snapshots_for_confirmed_exit:
        return False
    qualifying.sort()
    return (
        qualifying[-1] - qualifying[0]
    ).total_seconds() >= config.confirmation_window_seconds


def _extract_score_reason(
    *,
    event_close_passed: bool,
    has_bid: bool,
    estimated_freeable_value: float | None,
    adverse_probability: float | None,
) -> ExitReasonCode:
    if not has_bid:
        return "NO_BID_AVAILABLE"
    if estimated_freeable_value is not None and estimated_freeable_value < 0.01:
        return "LOW_EXECUTABLE_VALUE"
    if event_close_passed:
        return "EVENT_CLOSE_PASSED"
    if adverse_probability is not None and adverse_probability >= 0.99:
        return "ADVERSE_MARKET_99"
    return "LOW_EXECUTABLE_VALUE"


def evaluate_capital_aware_forced_exit(
    snapshot: EventExitSnapshot,
    price_history: Sequence[PositionPriceSnapshot],
    config: ForcedExitConfig = DEFAULT_FORCED_EXIT_CONFIG,
    *,
    now: datetime | None = None,
) -> list[ExitSignal]:
    now = _utc_now(now)
    held_probability, adverse_probability = _held_and_adverse_probabilities(snapshot)
    if held_probability is None or adverse_probability is None:
        return []

    current_snapshot = build_position_price_snapshot(
        snapshot,
        held_probability=held_probability,
        adverse_probability=adverse_probability,
        timestamp=now.isoformat(),
    )
    history = merge_price_history(price_history, current_snapshot)
    snapshot_1m = _pick_lookback_snapshot(history, reference_time=now, target_seconds=60)
    snapshot_5m = _pick_lookback_snapshot(history, reference_time=now, target_seconds=300)
    drop_1m = (
        held_probability - snapshot_1m.heldProbability if snapshot_1m is not None else None
    )
    drop_5m = (
        held_probability - snapshot_5m.heldProbability if snapshot_5m is not None else None
    )
    adverse_rise_1m = (
        adverse_probability - snapshot_1m.adverseProbability
        if snapshot_1m is not None
        else None
    )
    adverse_rise_5m = (
        adverse_probability - snapshot_5m.adverseProbability
        if snapshot_5m is not None
        else None
    )
    time_to_close_hours = _time_to_close_hours(snapshot.close_time, now)
    event_close_passed = time_to_close_hours is not None and time_to_close_hours <= 0
    has_bid = snapshot.held_best_bid is not None and snapshot.held_best_bid > 0
    estimated_freeable_value = (
        round(snapshot.shares * snapshot.held_best_bid, 6)
        if snapshot.held_best_bid is not None
        else None
    )
    metrics = _build_metrics(
        snapshot,
        held_probability=held_probability,
        adverse_probability=adverse_probability,
        estimated_freeable_value=estimated_freeable_value,
        drop_1m=drop_1m,
        drop_5m=drop_5m,
        adverse_rise_1m=adverse_rise_1m,
        adverse_rise_5m=adverse_rise_5m,
        time_to_close_hours=time_to_close_hours,
    )
    created_at = now.isoformat()
    signals: list[ExitSignal] = []

    if adverse_probability >= config.immediate_adverse_probability:
        signals.append(
            _signal(
                strategy="CAPITAL_AWARE_FORCED_EXIT",
                severity="IMMEDIATE_EXIT",
                reason_code="ADVERSE_MARKET_99_5",
                label="Forced Exit: 99.5% Against Us",
                description="Market odds are effectively resolved against the held outcome. Move this position to Event Exits immediately.",
                created_at=created_at,
                metrics=metrics,
            )
        )

    if snapshot.held_best_bid is not None and snapshot.held_best_bid <= config.held_best_bid_dust_threshold:
        signals.append(
            _signal(
                strategy="CAPITAL_AWARE_FORCED_EXIT",
                severity=(
                    "DUST_LOST"
                    if estimated_freeable_value is None
                    or estimated_freeable_value < config.min_net_proceeds
                    else "IMMEDIATE_EXIT"
                ),
                reason_code="HELD_SIDE_BID_BELOW_0_5_CENTS",
                label="Forced Exit: Held Side Below 0.5c",
                description="The held outcome has almost no executable bid value. Exit if executable, otherwise mark as dust.",
                created_at=created_at,
                metrics=metrics,
            )
        )

    if _confirmed_adverse_snapshots(history, config=config):
        signals.append(
            _signal(
                strategy="CAPITAL_AWARE_FORCED_EXIT",
                severity="IMMEDIATE_EXIT",
                reason_code="ADVERSE_MARKET_99",
                label="Forced Exit: Confirmed 99% Against Us",
                description="The position has remained virtually lost across multiple snapshots.",
                created_at=created_at,
                metrics=metrics,
            )
        )

    if (
        (drop_1m is not None and drop_1m <= config.watch_fast_drop_1m)
        or adverse_probability >= config.watch_fast_adverse_probability
    ):
        signals.append(
            _signal(
                strategy="CAPITAL_AWARE_FORCED_EXIT",
                severity="WATCH_FAST",
                reason_code=(
                    "HELD_SIDE_DROP_10_POINTS_1M"
                    if drop_1m is not None and drop_1m <= config.watch_fast_drop_1m
                    else "ADVERSE_MARKET_99"
                ),
                label="Watch Fast",
                description="Held-side odds are deteriorating quickly. Refresh this position more frequently.",
                created_at=created_at,
                metrics=metrics,
            )
        )

    if (
        drop_1m is not None
        and drop_1m <= config.momentum_forced_drop_1m
        and adverse_probability >= config.momentum_forced_adverse_probability
    ):
        signals.append(
            _signal(
                strategy="CAPITAL_AWARE_FORCED_EXIT",
                severity="PLANNED_EXIT",
                reason_code="HELD_SIDE_DROP_15_POINTS_1M",
                label="Forced Exit: Fast 1m Collapse",
                description="Held-side odds dropped by at least 15 percentage points in one minute and the market is now heavily against us.",
                created_at=created_at,
                metrics=metrics,
            )
        )

    if (
        drop_5m is not None
        and drop_5m <= config.momentum_forced_drop_5m
        and adverse_probability >= config.momentum_forced_5m_adverse_probability
    ):
        signals.append(
            _signal(
                strategy="CAPITAL_AWARE_FORCED_EXIT",
                severity="PLANNED_EXIT",
                reason_code="HELD_SIDE_DROP_25_POINTS_5M",
                label="Forced Exit: 5m Collapse",
                description="Held-side odds dropped by at least 25 percentage points in five minutes and the market is now heavily against us.",
                created_at=created_at,
                metrics=metrics,
            )
        )

    score = 0.0
    if adverse_probability >= 0.995:
        score += 100
    elif adverse_probability >= 0.99:
        score += 75
    elif adverse_probability >= 0.95:
        score += 45
    elif adverse_probability >= 0.90:
        score += 25

    if adverse_rise_1m is not None and adverse_rise_1m >= 0.10:
        score += 20
    if adverse_rise_5m is not None and adverse_rise_5m >= 0.20:
        score += 20

    if event_close_passed:
        score += 25
    elif time_to_close_hours is not None and time_to_close_hours <= 6:
        score += 10

    if snapshot.held_best_bid is not None and snapshot.held_best_bid <= config.held_best_bid_dust_threshold:
        score += 20
    if estimated_freeable_value is not None and estimated_freeable_value >= config.min_net_proceeds:
        score += 10
    if not has_bid or (
        estimated_freeable_value is not None
        and estimated_freeable_value < config.min_net_proceeds
    ):
        score -= 15

    if snapshot.llm_probability_held is not None and snapshot.llm_probability_held <= 0.20:
        score += 10

    if score >= config.score_planned_exit:
        signals.append(
            _signal(
                strategy="CAPITAL_AWARE_FORCED_EXIT",
                severity="PLANNED_EXIT",
                reason_code=_extract_score_reason(
                    event_close_passed=event_close_passed,
                    has_bid=has_bid,
                    estimated_freeable_value=estimated_freeable_value,
                    adverse_probability=adverse_probability,
                ),
                label="Capital-Aware Forced Exit",
                description="Position is losing executable value based on adverse odds, momentum, time-to-close, and liquidity.",
                created_at=created_at,
                metrics=metrics,
                score=score,
            )
        )
    elif score >= config.score_watch_fast:
        signals.append(
            _signal(
                strategy="CAPITAL_AWARE_FORCED_EXIT",
                severity="WATCH_FAST",
                reason_code=_extract_score_reason(
                    event_close_passed=event_close_passed,
                    has_bid=has_bid,
                    estimated_freeable_value=estimated_freeable_value,
                    adverse_probability=adverse_probability,
                ),
                label="Capital-Aware Forced Exit",
                description="Position is losing executable value based on adverse odds, momentum, time-to-close, and liquidity.",
                created_at=created_at,
                metrics=metrics,
                score=score,
            )
        )

    return dedupe_exit_signals(signals)


def evaluate_event_exits(
    context: EventExitContext,
) -> EventExitEvaluation:
    ranking_signals = evaluate_ranking_and_llm_exit(context.ranking)
    forced_signals = evaluate_capital_aware_forced_exit(
        context.snapshot,
        context.price_history,
        context.config,
        now=context.now,
    )
    exit_signals = dedupe_exit_signals([*ranking_signals, *forced_signals])
    return EventExitEvaluation(
        exit_signals=exit_signals,
        exit_state=derive_exit_state(exit_signals),
    )
