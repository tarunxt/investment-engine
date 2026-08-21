from datetime import UTC, datetime, timedelta

from app.domains.polymarket_auto_live.event_exit import (
    EventExitContext,
    EventExitSnapshot,
    PositionPriceSnapshot,
    RankingAndLlmExitContext,
    dedupe_exit_signals,
    evaluate_capital_aware_forced_exit,
    evaluate_event_exits,
)


def _snapshot(
    *,
    held_side: str,
    current_yes: float,
    current_no: float,
    held_best_bid: float | None = None,
    shares: float = 100,
    avg_price: float = 0.82,
    close_time: str = "2026-07-20T12:00:00+00:00",
    llm_probability_held: float | None = None,
    position_id: str = "position-1",
    market_id: str = "market-1",
) -> EventExitSnapshot:
    return EventExitSnapshot(
        position_id=position_id,
        market_id=market_id,
        token_id=f"token::{position_id}",
        held_side=held_side,
        shares=shares,
        avg_price=avg_price,
        current_yes_probability=current_yes,
        current_no_probability=current_no,
        held_best_bid=held_best_bid,
        close_time=close_time,
        llm_probability_held=llm_probability_held,
    )


def _history_snapshot(
    *,
    position_id: str = "position-1",
    market_id: str = "market-1",
    held_probability: float,
    adverse_probability: float,
    held_best_bid: float | None = None,
    timestamp: datetime,
) -> PositionPriceSnapshot:
    return PositionPriceSnapshot(
        positionId=position_id,
        marketId=market_id,
        tokenId=f"token::{position_id}",
        timestamp=timestamp.astimezone(UTC).isoformat(),
        currentYes=held_probability if adverse_probability <= held_probability else adverse_probability,
        currentNo=adverse_probability if adverse_probability <= held_probability else held_probability,
        heldProbability=held_probability,
        adverseProbability=adverse_probability,
        heldBestBid=held_best_bid,
    )


def _event_exit_context(
    snapshot: EventExitSnapshot,
    *,
    now: datetime,
    top_active_position_keys: set[str] | None = None,
    selected_side: str | None = None,
    price_history: list[PositionPriceSnapshot] | None = None,
):
    position_key = snapshot.position_id
    return EventExitContext(
        ranking=RankingAndLlmExitContext(
            top_active_position_keys=top_active_position_keys or {position_key},
            current_position_key=position_key,
            current_yes_probability=snapshot.current_yes_probability,
            current_no_probability=snapshot.current_no_probability,
            selected_side=selected_side or snapshot.held_side,
            held_side=snapshot.held_side,
            minimum_market_probability=0.05,
            now=now,
        ),
        snapshot=snapshot,
        price_history=price_history or [],
        now=now,
    )


def test_capital_aware_forced_exit_marks_virtually_lost_no_holder_as_immediate_or_dust():
    now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
    snapshot = _snapshot(
        held_side="NO",
        current_yes=0.9995,
        current_no=0.0005,
        held_best_bid=0.0005,
    )

    evaluation = evaluate_event_exits(_event_exit_context(snapshot, now=now))

    assert any(signal.strategy == "CAPITAL_AWARE_FORCED_EXIT" for signal in evaluation.exit_signals)
    assert any(signal.severity in {"IMMEDIATE_EXIT", "DUST_LOST"} for signal in evaluation.exit_signals)
    assert evaluation.exit_state in {"EVENT_EXIT_PLANNED", "DUST_LOST"}
    assert {
        signal.reasonCode for signal in evaluation.exit_signals
    } & {"ADVERSE_MARKET_99_5", "HELD_SIDE_BID_BELOW_0_5_CENTS"}


def test_capital_aware_forced_exit_treats_yes_holder_as_adverse_when_no_reaches_99_6_percent():
    now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
    signals = evaluate_capital_aware_forced_exit(
        _snapshot(
            held_side="YES",
            current_yes=0.004,
            current_no=0.996,
            held_best_bid=0.004,
        ),
        [],
        now=now,
    )

    assert any(signal.reasonCode == "ADVERSE_MARKET_99_5" for signal in signals)
    assert any(signal.severity == "IMMEDIATE_EXIT" for signal in signals)


def test_capital_aware_forced_exit_does_not_trigger_99_5_override_for_98_5_percent_adverse_market():
    now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
    signals = evaluate_capital_aware_forced_exit(
        _snapshot(
            held_side="NO",
            current_yes=0.985,
            current_no=0.015,
            held_best_bid=0.015,
        ),
        [],
        now=now,
    )

    assert all(signal.reasonCode != "ADVERSE_MARKET_99_5" for signal in signals)
    assert all(signal.severity != "IMMEDIATE_EXIT" for signal in signals)
    assert any(signal.severity == "WATCH_FAST" for signal in signals)


def test_capital_aware_forced_exit_watch_fast_triggers_without_forced_sell_when_adverse_side_not_heavy_enough():
    now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
    signals = evaluate_capital_aware_forced_exit(
        _snapshot(
            held_side="YES",
            current_yes=0.54,
            current_no=0.46,
            held_best_bid=0.54,
        ),
        [
            _history_snapshot(
                held_probability=0.70,
                adverse_probability=0.30,
                held_best_bid=0.70,
                timestamp=now - timedelta(seconds=60),
            )
        ],
        now=now,
    )

    assert any(
        signal.reasonCode == "HELD_SIDE_DROP_10_POINTS_1M" and signal.severity == "WATCH_FAST"
        for signal in signals
    )
    assert all(signal.reasonCode != "HELD_SIDE_DROP_15_POINTS_1M" for signal in signals)
    assert all(signal.severity != "PLANNED_EXIT" for signal in signals)


def test_capital_aware_forced_exit_forces_exit_on_fast_one_minute_collapse():
    now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
    signals = evaluate_capital_aware_forced_exit(
        _snapshot(
            held_side="YES",
            current_yes=0.14,
            current_no=0.86,
            held_best_bid=0.14,
        ),
        [
            _history_snapshot(
                held_probability=0.30,
                adverse_probability=0.70,
                held_best_bid=0.30,
                timestamp=now - timedelta(seconds=60),
            )
        ],
        now=now,
    )

    assert any(
        signal.reasonCode == "HELD_SIDE_DROP_15_POINTS_1M" and signal.severity == "PLANNED_EXIT"
        for signal in signals
    )


def test_ranking_exit_still_marks_position_outside_top_ten_for_event_exit():
    now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
    snapshot = _snapshot(
        held_side="NO",
        current_yes=0.40,
        current_no=0.60,
        held_best_bid=0.60,
    )

    evaluation = evaluate_event_exits(
        _event_exit_context(
            snapshot,
            now=now,
            top_active_position_keys={"another-position"},
        )
    )

    assert any(
        signal.reasonCode == "OUTSIDE_TOP_10_BY_RETURNS_DAY"
        for signal in evaluation.exit_signals
    )
    assert evaluation.exit_state == "EVENT_EXIT_PLANNED"


def test_event_exit_deduplicates_signal_pairs_while_preserving_ranking_and_forced_reasons():
    now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
    snapshot = _snapshot(
        held_side="NO",
        current_yes=0.9995,
        current_no=0.0005,
        held_best_bid=0.02,
    )

    evaluation = evaluate_event_exits(
        _event_exit_context(
            snapshot,
            now=now,
            top_active_position_keys={"another-position"},
        )
    )
    deduped_pairs = {
        (signal.strategy, signal.reasonCode)
        for signal in dedupe_exit_signals(evaluation.exit_signals)
    }

    assert ("OUTSIDE_TOP_10_RETURNS_DAY", "OUTSIDE_TOP_10_BY_RETURNS_DAY") in deduped_pairs
    assert ("CAPITAL_AWARE_FORCED_EXIT", "ADVERSE_MARKET_99_5") in deduped_pairs
    assert len(deduped_pairs) == len(dedupe_exit_signals(evaluation.exit_signals))


def test_capital_aware_forced_exit_uses_executable_bid_for_estimated_freeable_value():
    now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
    signals = evaluate_capital_aware_forced_exit(
        _snapshot(
            held_side="NO",
            current_yes=0.9995,
            current_no=0.0005,
            shares=100,
            avg_price=0.82,
            held_best_bid=0.002,
        ),
        [],
        now=now,
    )

    estimated_freeable_values = [
        signal.metrics.estimatedFreeableValue
        for signal in signals
        if signal.metrics is not None
    ]

    assert 0.2 in estimated_freeable_values
    assert 82.0 not in estimated_freeable_values
