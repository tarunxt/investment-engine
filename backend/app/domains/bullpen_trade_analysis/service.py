from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import Select, and_, desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, selectinload

from app.domains.bullpen_trade_analysis.analytics import (
    build_trade_learning_insights,
    generate_bullpen_post_trade_analysis,
)
from app.domains.bullpen_trade_analysis.helpers import (
    bounded_score,
    build_rule_checks,
    compute_trade_tags,
    confidence_score_from_value,
    extract_execution_summary,
    normalize_title,
    parse_datetime,
    parse_float,
    recursive_find,
    risk_score_from_status,
    safe_json_loads,
    sanitize_json_value,
    utc_now,
)
from app.domains.bullpen_trade_analysis.models import (
    BullpenTradeAnalysisEventLogRecord,
    BullpenTradeAnalysisLlmRecord,
    BullpenTradeAnalysisRecord,
    BullpenTradeAnalysisSnapshotRecord,
)
from app.domains.bullpen_trade_analysis.schemas import (
    BullpenTradeAnalysisActionableLearning,
    BullpenTradeAnalysisComparison,
    BullpenTradeAnalysisDetailResponse,
    BullpenTradeAnalysisEventLog,
    BullpenTradeAnalysisLearningInsights,
    BullpenTradeAnalysisListItem,
    BullpenTradeAnalysisListResponse,
    BullpenTradeAnalysisLlmEntry,
    BullpenTradeAnalysisRecordResponse,
    BullpenTradeAnalysisSnapshot,
    BullpenTradeAnalysisSummaryStats,
)
from app.domains.polymarket.bullpen import BullpenTradeHistoryReader
from app.domains.polymarket.schemas import PolymarketBullpenTradeHistoryItem
from app.infrastructure.database.session import AsyncSessionLocal
from app.infrastructure.database.sync_session import SyncSessionLocal

logger = logging.getLogger(__name__)


def _serialize_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)


def _safe_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_outcome(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().upper()
    if normalized in {"YES", "NO"}:
        return normalized
    return value.strip() or None


def _normalize_exit_type(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().upper()
    return normalized or None


def _pnl_outcome_tag(net_pnl: float | None, *, closed: bool) -> str:
    if not closed:
        return "OPEN"
    if net_pnl is None:
        return "UNKNOWN"
    if net_pnl > 0.000001:
        return "PROFIT"
    if net_pnl < -0.000001:
        return "LOSS"
    return "BREAKEVEN"


def _final_exit_tag(
    *, exit_type: str | None, sell_reason: str | None, net_pnl: float | None
) -> str:
    normalized_reason = (sell_reason or "").strip().lower()
    normalized_type = (exit_type or "").strip().upper()
    if normalized_type == "REDEEM":
        return "REDEEMED"
    if normalized_type == "FORCED_EXIT":
        return "FORCED_EXIT"
    if normalized_type == "EXPIRY":
        return "EVENT_EXPIRED"
    if normalized_type == "MANUAL":
        return "MANUAL_EXIT"
    if "forced" in normalized_reason:
        return "FORCED_EXIT"
    if "llm" in normalized_reason:
        return "LLM_EXIT"
    if "rule" in normalized_reason or "threshold" in normalized_reason:
        return "RULE_EXIT"
    if net_pnl is not None:
        return _pnl_outcome_tag(net_pnl, closed=True)
    if normalized_type == "SELL":
        return "SOLD"
    return "UNKNOWN"


def _notional(
    amount: float | None, shares: float | None, price: float | None
) -> float | None:
    if amount is not None:
        return round(amount, 6)
    if shares is not None and price is not None:
        return round(shares * price, 6)
    return None


def _holding_period_seconds(
    buy_executed_at: datetime | None,
    closed_at: datetime | None,
) -> int | None:
    if buy_executed_at is None or closed_at is None:
        return None
    normalized_buy = _serialize_datetime(buy_executed_at)
    normalized_closed = _serialize_datetime(closed_at)
    if normalized_buy is None or normalized_closed is None:
        return None
    return max(0, int((normalized_closed - normalized_buy).total_seconds()))


def _requested_shares(amount: float | None, price: float | None) -> float | None:
    if amount is None or price in {None, 0}:
        return None
    return round(amount / price, 6)


def _slippage(
    requested_price: float | None, average_fill_price: float | None
) -> float | None:
    if requested_price is None or average_fill_price is None:
        return None
    return round(average_fill_price - requested_price, 6)


def _numeric_scores(
    *,
    liquidity_usd: float | None,
    volume_usd: float | None,
    spread_cents: float | None,
    volatility_source: float | None = None,
) -> dict[str, float | None]:
    return {
        "liquidity_score": bounded_score(liquidity_usd, lower=250, upper=25_000),
        "volume_score": bounded_score(volume_usd, lower=250, upper=100_000),
        "spread_score": bounded_score(spread_cents, lower=1, upper=15, inverse=True),
        "volatility_score": bounded_score(volatility_source, lower=0, upper=25),
    }


def _llm_entries_for_phase(
    payloads: Sequence[dict[str, object]],
    *,
    phase: str,
    computed_tags: Sequence[str],
) -> list[BullpenTradeAnalysisLlmRecord]:
    records: list[BullpenTradeAnalysisLlmRecord] = []
    for payload in payloads:
        records.append(
            BullpenTradeAnalysisLlmRecord(
                phase=phase,
                provider=_safe_text(payload.get("provider")),
                model=_safe_text(payload.get("model")),
                prompt_version=_safe_text(payload.get("prompt_version")),
                prompt_text=_safe_text(payload.get("prompt_text")),
                raw_output=_safe_text(
                    payload.get("raw_output") or payload.get("rationale")
                ),
                parsed_output_json=sanitize_json_value(dict(payload)),
                confidence=confidence_score_from_value(payload.get("confidence")),
                tags_json=sanitize_json_value(list(payload.get("tags") or [])),
                computed_tags_json=list(computed_tags),
                decision_json=sanitize_json_value(
                    {
                        "rationale": payload.get("rationale"),
                        "confidence": payload.get("confidence"),
                        "evidence_status": payload.get("evidence_status"),
                        "event_state": payload.get("event_state"),
                    }
                ),
            )
        )
    return records


def _build_record_response(
    record: BullpenTradeAnalysisRecord,
) -> BullpenTradeAnalysisRecordResponse:
    return BullpenTradeAnalysisRecordResponse(
        id=record.id,
        entry_reference=record.entry_reference,
        exit_reference=record.exit_reference,
        source_variant=record.source_variant,
        bot_name=record.bot_name,
        strategy_name=record.strategy_name,
        strategy_version=record.strategy_version,
        status=record.status,
        lifecycle_state=record.lifecycle_state,
        final_tag=record.final_tag,
        pnl_outcome_tag=record.pnl_outcome_tag,
        position_key=record.position_key,
        event_id=record.event_id,
        event_slug=record.event_slug,
        bullpen_event_id=record.bullpen_event_id,
        bullpen_market_id=record.bullpen_market_id,
        outcome_id=record.outcome_id,
        outcome_name=record.outcome_name,
        contract_id=record.contract_id,
        run_id=record.run_id,
        title=record.title,
        event_question=record.event_question,
        event_description=record.event_description,
        category=record.category,
        topic=record.topic,
        source_url=record.source_url,
        market_url=record.market_url,
        event_close_time=_serialize_datetime(record.event_close_time),
        event_resolved_at=_serialize_datetime(record.event_resolved_at),
        bought_at=_serialize_datetime(record.bought_at),
        sold_at=_serialize_datetime(record.sold_at),
        redeemed_at=_serialize_datetime(record.redeemed_at),
        closed_at=_serialize_datetime(record.closed_at),
        buy_order_id=record.buy_order_id,
        buy_client_order_id=record.buy_client_order_id,
        buy_submitted_at=_serialize_datetime(record.buy_submitted_at),
        buy_executed_at=_serialize_datetime(record.buy_executed_at),
        buy_requested_amount=record.buy_requested_amount,
        buy_requested_shares=record.buy_requested_shares,
        buy_requested_price=record.buy_requested_price,
        buy_requested_odds=record.buy_requested_odds,
        buy_filled_amount=record.buy_filled_amount,
        buy_filled_shares=record.buy_filled_shares,
        buy_average_fill_price=record.buy_average_fill_price,
        buy_average_fill_odds=record.buy_average_fill_odds,
        buy_fees=record.buy_fees,
        buy_slippage=record.buy_slippage,
        buy_status=record.buy_status,
        buy_failure_reason=record.buy_failure_reason,
        buy_decision_summary=record.buy_decision_summary,
        buy_reason=record.buy_reason,
        buy_confidence=record.buy_confidence,
        buy_risk_score=record.buy_risk_score,
        buy_expected_edge=record.buy_expected_edge,
        buy_expected_value=record.buy_expected_value,
        buy_probability_estimate=record.buy_probability_estimate,
        buy_market_implied_probability=record.buy_market_implied_probability,
        buy_probability_delta=record.buy_probability_delta,
        buy_liquidity_score=record.buy_liquidity_score,
        buy_volume_score=record.buy_volume_score,
        buy_spread_score=record.buy_spread_score,
        buy_volatility_score=record.buy_volatility_score,
        buy_news_recency_score=record.buy_news_recency_score,
        buy_selected_by_rule=record.buy_selected_by_rule,
        buy_selected_by_llm=record.buy_selected_by_llm,
        buy_selected_by_hybrid_decision=record.buy_selected_by_hybrid_decision,
        buy_computed_tags_json=record.buy_computed_tags_json,
        buy_rule_checks_json=record.buy_rule_checks_json,
        exit_type=record.exit_type,
        sell_order_id=record.sell_order_id,
        sell_client_order_id=record.sell_client_order_id,
        sell_submitted_at=_serialize_datetime(record.sell_submitted_at),
        sell_executed_at=_serialize_datetime(record.sell_executed_at),
        sell_requested_amount=record.sell_requested_amount,
        sell_requested_shares=record.sell_requested_shares,
        sell_requested_price=record.sell_requested_price,
        sell_requested_odds=record.sell_requested_odds,
        sell_filled_amount=record.sell_filled_amount,
        sell_filled_shares=record.sell_filled_shares,
        sell_average_fill_price=record.sell_average_fill_price,
        sell_average_fill_odds=record.sell_average_fill_odds,
        sell_fees=record.sell_fees,
        sell_slippage=record.sell_slippage,
        sell_status=record.sell_status,
        sell_failure_reason=record.sell_failure_reason,
        sell_decision_summary=record.sell_decision_summary,
        sell_reason=record.sell_reason,
        sell_confidence=record.sell_confidence,
        sell_risk_score=record.sell_risk_score,
        sell_expected_edge=record.sell_expected_edge,
        sell_expected_value=record.sell_expected_value,
        sell_probability_estimate=record.sell_probability_estimate,
        sell_market_implied_probability=record.sell_market_implied_probability,
        sell_probability_delta=record.sell_probability_delta,
        sell_liquidity_score=record.sell_liquidity_score,
        sell_volume_score=record.sell_volume_score,
        sell_spread_score=record.sell_spread_score,
        sell_volatility_score=record.sell_volatility_score,
        sell_computed_tags_json=record.sell_computed_tags_json,
        sell_rule_checks_json=record.sell_rule_checks_json,
        buy_notional=record.buy_notional,
        exit_notional=record.exit_notional,
        gross_pnl=record.gross_pnl,
        net_pnl=record.net_pnl,
        pnl_percent=record.pnl_percent,
        fees_total=record.fees_total,
        holding_period_seconds=record.holding_period_seconds,
        realized_return=record.realized_return,
        max_favorable_price=record.max_favorable_price,
        max_adverse_price=record.max_adverse_price,
        best_possible_exit_price_after_buy=record.best_possible_exit_price_after_buy,
        worst_price_after_buy=record.worst_price_after_buy,
        missed_profit_amount=record.missed_profit_amount,
        drawdown_while_held=record.drawdown_while_held,
        analysis_summary=record.analysis_summary,
        mistake_category=record.mistake_category,
        improvement_suggestion=record.improvement_suggestion,
        reinforcement_signal=record.reinforcement_signal,
        reinforcement_score=record.reinforcement_score,
        should_avoid_similar_trade=record.should_avoid_similar_trade,
        should_increase_confidence_for_similar_trade=record.should_increase_confidence_for_similar_trade,
        human_review_required=record.human_review_required,
        reviewer_notes=record.reviewer_notes,
        metadata_json=record.metadata_json,
        created_at=_serialize_datetime(record.created_at),
        updated_at=_serialize_datetime(record.updated_at),
    )


def _build_list_item(
    record: BullpenTradeAnalysisRecord,
) -> BullpenTradeAnalysisListItem:
    latest_monitor = record.metadata_json.get("latest_monitor", {})
    current_price = parse_float(latest_monitor.get("current_price_cents"))
    return BullpenTradeAnalysisListItem(
        id=record.id,
        title=record.title,
        status=record.status,
        final_tag=record.final_tag,
        pnl_outcome_tag=record.pnl_outcome_tag,
        category=record.category,
        topic=record.topic,
        run_id=record.run_id,
        strategy_name=record.strategy_name,
        strategy_version=record.strategy_version,
        bought_at=_serialize_datetime(record.bought_at),
        sold_at=_serialize_datetime(record.sold_at),
        redeemed_at=_serialize_datetime(record.redeemed_at),
        closed_at=_serialize_datetime(record.closed_at),
        buy_amount=record.buy_notional or record.buy_requested_amount,
        buy_price=record.buy_average_fill_price or record.buy_requested_price,
        buy_odds=record.buy_average_fill_odds or record.buy_requested_odds,
        current_price=current_price,
        exit_price=record.sell_average_fill_price or record.sell_requested_price,
        exit_odds=record.sell_average_fill_odds or record.sell_requested_odds,
        net_pnl=record.net_pnl,
        pnl_percent=record.pnl_percent,
        holding_period_seconds=record.holding_period_seconds,
        buy_tags=[str(tag) for tag in (record.buy_computed_tags_json or [])[:6]],
        short_reason=record.buy_decision_summary or record.buy_reason,
        exit_reason=record.sell_reason,
        confidence=record.buy_confidence,
        risk_score=record.buy_risk_score,
    )


def _build_summary(
    records: Sequence[BullpenTradeAnalysisRecord],
) -> BullpenTradeAnalysisSummaryStats:
    closed = [record for record in records if record.closed_at is not None]
    wins = [record for record in closed if (record.net_pnl or 0) > 0]
    holding_values = [
        record.holding_period_seconds
        for record in closed
        if record.holding_period_seconds is not None
    ]
    pnl_values = [
        record.pnl_percent for record in closed if record.pnl_percent is not None
    ]
    fees_total = sum(record.fees_total or 0 for record in records)
    return BullpenTradeAnalysisSummaryStats(
        total_executed_trades=len(
            [record for record in records if record.buy_executed_at is not None]
        ),
        open_positions=len([record for record in records if record.closed_at is None]),
        closed_positions=len(closed),
        total_net_pnl=round(sum(record.net_pnl or 0 for record in records), 4),
        win_rate=round(len(wins) / len(closed), 4) if closed else 0,
        average_pnl_percent=(
            round(sum(pnl_values) / len(pnl_values), 4) if pnl_values else None
        ),
        average_holding_period_seconds=(
            round(sum(holding_values) / len(holding_values), 2)
            if holding_values
            else None
        ),
        total_fees=round(fees_total, 4),
    )


def _build_comparison(
    record: BullpenTradeAnalysisRecord,
) -> BullpenTradeAnalysisComparison:
    return BullpenTradeAnalysisComparison(
        buy_price=record.buy_average_fill_price or record.buy_requested_price,
        exit_price=record.sell_average_fill_price or record.sell_requested_price,
        buy_odds=record.buy_average_fill_odds or record.buy_requested_odds,
        exit_odds=record.sell_average_fill_odds or record.sell_requested_odds,
        buy_liquidity_score=record.buy_liquidity_score,
        exit_liquidity_score=record.sell_liquidity_score,
        buy_volume_score=record.buy_volume_score,
        exit_volume_score=record.sell_volume_score,
        buy_spread_score=record.buy_spread_score,
        exit_spread_score=record.sell_spread_score,
        buy_confidence=record.buy_confidence,
        exit_confidence=record.sell_confidence,
        buy_probability_estimate=record.buy_probability_estimate,
        exit_probability_estimate=record.sell_probability_estimate,
        buy_market_implied_probability=record.buy_market_implied_probability,
        exit_market_implied_probability=record.sell_market_implied_probability,
        buy_probability_delta=record.buy_probability_delta,
        exit_probability_delta=record.sell_probability_delta,
    )


def _apply_learning_fields(
    record: BullpenTradeAnalysisRecord,
) -> BullpenTradeAnalysisActionableLearning:
    learning = generate_bullpen_post_trade_analysis(record)
    record.analysis_summary = _safe_text(learning.get("analysis_summary"))
    record.mistake_category = _safe_text(learning.get("mistake_category"))
    record.improvement_suggestion = _safe_text(learning.get("improvement_suggestion"))
    record.reinforcement_signal = _safe_text(learning.get("reinforcement_signal"))
    record.reinforcement_score = parse_float(learning.get("reinforcement_score"))
    record.should_avoid_similar_trade = bool(learning.get("should_avoid_similar_trade"))
    record.should_increase_confidence_for_similar_trade = bool(
        learning.get("should_increase_confidence_for_similar_trade")
    )
    record.human_review_required = bool(learning.get("human_review_required"))
    return BullpenTradeAnalysisActionableLearning.model_validate(learning)


def _record_event_log(
    session: Session,
    trade: BullpenTradeAnalysisRecord,
    *,
    run_id: str | None,
    event_type: str,
    message: str,
    metadata_json: dict[str, object] | None = None,
) -> None:
    existing = (
        session.execute(
            select(BullpenTradeAnalysisEventLogRecord)
            .where(BullpenTradeAnalysisEventLogRecord.trade_analysis_id == trade.id)
            .where(BullpenTradeAnalysisEventLogRecord.event_type == event_type)
            .order_by(desc(BullpenTradeAnalysisEventLogRecord.id))
            .limit(1)
        )
        .scalars()
        .first()
    )
    if existing and existing.message == message and existing.run_id == run_id:
        existing.metadata_json = sanitize_json_value(metadata_json or {})
        return
    session.add(
        BullpenTradeAnalysisEventLogRecord(
            trade_analysis_id=trade.id,
            run_id=run_id,
            event_type=event_type,
            message=message,
            metadata_json=sanitize_json_value(metadata_json or {}),
        )
    )


def _replace_llm_entries(
    session: Session,
    trade: BullpenTradeAnalysisRecord,
    *,
    phase: str,
    payloads: Sequence[dict[str, object]],
    computed_tags: Sequence[str],
) -> None:
    for existing in list(trade.llm_entries):
        if existing.phase != phase:
            continue
        session.delete(existing)
    for entry in _llm_entries_for_phase(
        payloads, phase=phase, computed_tags=computed_tags
    ):
        entry.trade_analysis_id = trade.id
        session.add(entry)


def _upsert_singleton_snapshot(
    session: Session,
    trade: BullpenTradeAnalysisRecord,
    *,
    snapshot_type: str,
    captured_at: datetime,
    bullpen_snapshot_json: dict[str, object] | None = None,
    event_snapshot_json: dict[str, object] | None = None,
    market_snapshot_json: dict[str, object] | None = None,
    order_book_snapshot_json: dict[str, object] | None = None,
    positions_snapshot_json: dict[str, object] | None = None,
    raw_api_response_json: dict[str, object] | None = None,
) -> None:
    existing = (
        session.execute(
            select(BullpenTradeAnalysisSnapshotRecord)
            .where(BullpenTradeAnalysisSnapshotRecord.trade_analysis_id == trade.id)
            .where(BullpenTradeAnalysisSnapshotRecord.snapshot_type == snapshot_type)
            .order_by(desc(BullpenTradeAnalysisSnapshotRecord.id))
            .limit(1)
        )
        .scalars()
        .first()
    )
    if existing is None or snapshot_type == "PERIODIC_MONITOR":
        session.add(
            BullpenTradeAnalysisSnapshotRecord(
                trade_analysis_id=trade.id,
                snapshot_type=snapshot_type,
                captured_at=captured_at,
                bullpen_snapshot_json=sanitize_json_value(bullpen_snapshot_json or {}),
                event_snapshot_json=sanitize_json_value(event_snapshot_json or {}),
                market_snapshot_json=sanitize_json_value(market_snapshot_json or {}),
                order_book_snapshot_json=sanitize_json_value(
                    order_book_snapshot_json or {}
                ),
                positions_snapshot_json=sanitize_json_value(
                    positions_snapshot_json or {}
                ),
                raw_api_response_json=sanitize_json_value(raw_api_response_json or {}),
            )
        )
        return
    existing.captured_at = captured_at
    existing.bullpen_snapshot_json = sanitize_json_value(bullpen_snapshot_json or {})
    existing.event_snapshot_json = sanitize_json_value(event_snapshot_json or {})
    existing.market_snapshot_json = sanitize_json_value(market_snapshot_json or {})
    existing.order_book_snapshot_json = sanitize_json_value(
        order_book_snapshot_json or {}
    )
    existing.positions_snapshot_json = sanitize_json_value(
        positions_snapshot_json or {}
    )
    existing.raw_api_response_json = sanitize_json_value(raw_api_response_json or {})


def _find_open_trade(
    session: Session,
    *,
    user_id: int,
    market_id: str | None,
    outcome_name: str | None,
    title: str | None = None,
) -> BullpenTradeAnalysisRecord | None:
    conditions = [
        BullpenTradeAnalysisRecord.user_id == user_id,
        BullpenTradeAnalysisRecord.closed_at.is_(None),
    ]
    if market_id:
        conditions.append(
            or_(
                BullpenTradeAnalysisRecord.bullpen_market_id == market_id,
                BullpenTradeAnalysisRecord.event_slug == market_id,
                BullpenTradeAnalysisRecord.position_key
                == f"{market_id}::{_normalize_outcome(outcome_name) or ''}",
            )
        )
    if outcome_name:
        conditions.append(
            BullpenTradeAnalysisRecord.outcome_name == _normalize_outcome(outcome_name)
        )
    query = (
        select(BullpenTradeAnalysisRecord)
        .where(and_(*conditions))
        .order_by(
            desc(BullpenTradeAnalysisRecord.buy_executed_at),
            desc(BullpenTradeAnalysisRecord.created_at),
        )
        .limit(1)
    )
    record = session.execute(query).scalars().first()
    if record is not None:
        return record
    if not title:
        return None
    open_records = (
        session.execute(
            select(BullpenTradeAnalysisRecord)
            .where(BullpenTradeAnalysisRecord.user_id == user_id)
            .where(BullpenTradeAnalysisRecord.closed_at.is_(None))
            .order_by(
                desc(BullpenTradeAnalysisRecord.buy_executed_at),
                desc(BullpenTradeAnalysisRecord.created_at),
            )
        )
        .scalars()
        .all()
    )
    normalized_title = normalize_title(title)
    return next(
        (
            item
            for item in open_records
            if normalize_title(item.title) == normalized_title
        ),
        None,
    )


def _find_or_create_trade_by_entry_reference(
    session: Session,
    *,
    user_id: int,
    entry_reference: str,
    title: str,
    event_question: str,
) -> BullpenTradeAnalysisRecord:
    existing = (
        session.execute(
            select(BullpenTradeAnalysisRecord).where(
                BullpenTradeAnalysisRecord.entry_reference == entry_reference
            )
        )
        .scalars()
        .first()
    )
    if existing is not None:
        return existing
    record = BullpenTradeAnalysisRecord(
        id=str(uuid4()),
        user_id=user_id,
        entry_reference=entry_reference,
        title=title,
        event_question=event_question,
    )
    session.add(record)
    return record


def _apply_buy_pre_submit(
    trade: BullpenTradeAnalysisRecord,
    *,
    source_variant: str,
    bot_name: str,
    strategy_name: str | None,
    strategy_version: str | None,
    run_id: str | None,
    event_id: str | None,
    event_slug: str | None,
    market_id: str | None,
    outcome_name: str | None,
    title: str,
    event_question: str,
    event_description: str | None,
    category: str | None,
    topic: str | None,
    source_url: str | None,
    market_url: str | None,
    event_close_time: datetime | None,
    requested_amount: float | None,
    requested_price: float | None,
    buy_probability_estimate: float | None,
    market_probability: float | None,
    confidence: float | None,
    risk_score: float | None,
    expected_edge: float | None,
    expected_value: float | None,
    liquidity_score: float | None,
    volume_score: float | None,
    spread_score: float | None,
    volatility_score: float | None,
    evidence_status: str | None,
    event_state: str | None,
    decision_summary: str | None,
    buy_reason: str | None,
    selected_by_rule: bool,
    selected_by_llm: bool,
    selected_by_hybrid: bool,
) -> list[str]:
    trade.source_variant = source_variant
    trade.bot_name = bot_name
    trade.strategy_name = strategy_name
    trade.strategy_version = strategy_version
    trade.run_id = run_id
    trade.event_id = event_id
    trade.event_slug = event_slug
    trade.bullpen_market_id = market_id
    trade.outcome_name = _normalize_outcome(outcome_name)
    trade.position_key = (
        f"{market_id or event_slug or event_id or title}::{trade.outcome_name or ''}"
    )
    trade.title = title
    trade.event_question = event_question
    trade.event_description = event_description
    trade.category = category
    trade.topic = topic
    trade.source_url = source_url
    trade.market_url = market_url
    trade.event_close_time = event_close_time
    trade.buy_submitted_at = trade.buy_submitted_at or utc_now()
    trade.buy_requested_amount = requested_amount
    trade.buy_requested_price = requested_price
    trade.buy_requested_odds = (
        round(requested_price * 100, 4) if requested_price is not None else None
    )
    trade.buy_requested_shares = _requested_shares(requested_amount, requested_price)
    trade.buy_probability_estimate = buy_probability_estimate
    trade.buy_market_implied_probability = market_probability
    trade.buy_probability_delta = (
        round(buy_probability_estimate - market_probability, 4)
        if buy_probability_estimate is not None and market_probability is not None
        else None
    )
    trade.buy_confidence = confidence
    trade.buy_risk_score = risk_score
    trade.buy_expected_edge = expected_edge
    trade.buy_expected_value = expected_value
    trade.buy_liquidity_score = liquidity_score
    trade.buy_volume_score = volume_score
    trade.buy_spread_score = spread_score
    trade.buy_volatility_score = volatility_score
    trade.buy_decision_summary = decision_summary
    trade.buy_reason = buy_reason
    trade.buy_selected_by_rule = selected_by_rule
    trade.buy_selected_by_llm = selected_by_llm
    trade.buy_selected_by_hybrid_decision = selected_by_hybrid
    computed_tags = compute_trade_tags(
        category=category,
        topic=topic,
        liquidity_score=liquidity_score,
        volume_score=volume_score,
        spread_score=spread_score,
        confidence_score=confidence,
        probability_delta=trade.buy_probability_delta,
        evidence_status=evidence_status,
        event_state=event_state,
    )
    trade.buy_computed_tags_json = computed_tags
    trade.buy_rule_checks_json = build_rule_checks(
        liquidity_score=liquidity_score,
        spread_score=spread_score,
        confidence_score=confidence,
        probability_delta=trade.buy_probability_delta,
        has_llm_output=selected_by_llm,
    )
    trade.metadata_json = sanitize_json_value(
        {
            **(trade.metadata_json or {}),
            "evidence_status": evidence_status,
            "event_state": event_state,
        }
    )
    return computed_tags


def _apply_buy_execution(
    trade: BullpenTradeAnalysisRecord,
    *,
    summary: dict[str, object],
    executed_at: datetime,
) -> None:
    trade.buy_order_id = _safe_text(summary.get("order_id"))
    trade.buy_client_order_id = _safe_text(summary.get("client_order_id"))
    trade.buy_status = _safe_text(summary.get("status")) or "executed"
    trade.buy_filled_amount = (
        parse_float(summary.get("filled_amount")) or trade.buy_requested_amount
    )
    trade.buy_filled_shares = (
        parse_float(summary.get("filled_shares")) or trade.buy_requested_shares
    )
    trade.buy_average_fill_price = (
        parse_float(summary.get("average_fill_price")) or trade.buy_requested_price
    )
    trade.buy_average_fill_odds = (
        parse_float(summary.get("average_fill_odds")) or trade.buy_requested_odds
    )
    trade.buy_fees = parse_float(summary.get("fees"))
    trade.buy_slippage = _slippage(
        trade.buy_requested_price, trade.buy_average_fill_price
    )
    trade.buy_executed_at = executed_at
    trade.bought_at = executed_at
    trade.buy_status = trade.buy_status or "executed"
    trade.buy_notional = _notional(
        trade.buy_filled_amount,
        trade.buy_filled_shares,
        trade.buy_average_fill_price,
    )
    trade.fees_total = round((trade.buy_fees or 0) + (trade.sell_fees or 0), 6)
    trade.status = "BOUGHT"
    trade.lifecycle_state = "BUY_EXECUTED_ONLY"
    trade.final_tag = "OPEN"
    trade.pnl_outcome_tag = "OPEN"


def _apply_exit_pre_submit(
    trade: BullpenTradeAnalysisRecord,
    *,
    exit_reference: str,
    exit_type: str,
    submitted_at: datetime,
    requested_amount: float | None,
    requested_shares: float | None,
    requested_price: float | None,
    probability_estimate: float | None,
    market_probability: float | None,
    confidence: float | None,
    risk_score: float | None,
    expected_edge: float | None,
    expected_value: float | None,
    liquidity_score: float | None,
    volume_score: float | None,
    spread_score: float | None,
    volatility_score: float | None,
    decision_summary: str | None,
    sell_reason: str | None,
    evidence_status: str | None,
    event_state: str | None,
) -> list[str]:
    trade.exit_reference = exit_reference
    trade.exit_type = exit_type
    trade.sell_submitted_at = submitted_at
    trade.sell_requested_amount = requested_amount
    trade.sell_requested_shares = requested_shares
    trade.sell_requested_price = requested_price
    trade.sell_requested_odds = (
        round(requested_price * 100, 4) if requested_price is not None else None
    )
    trade.sell_probability_estimate = probability_estimate
    trade.sell_market_implied_probability = market_probability
    trade.sell_probability_delta = (
        round(probability_estimate - market_probability, 4)
        if probability_estimate is not None and market_probability is not None
        else None
    )
    trade.sell_confidence = confidence
    trade.sell_risk_score = risk_score
    trade.sell_expected_edge = expected_edge
    trade.sell_expected_value = expected_value
    trade.sell_liquidity_score = liquidity_score
    trade.sell_volume_score = volume_score
    trade.sell_spread_score = spread_score
    trade.sell_volatility_score = volatility_score
    trade.sell_decision_summary = decision_summary
    trade.sell_reason = sell_reason
    trade.status = "EXIT_SUBMITTED"
    trade.lifecycle_state = "BUY_EXECUTED_ONLY"
    computed_tags = compute_trade_tags(
        category=trade.category,
        topic=trade.topic,
        liquidity_score=liquidity_score,
        volume_score=volume_score,
        spread_score=spread_score,
        confidence_score=confidence,
        probability_delta=trade.sell_probability_delta,
        evidence_status=evidence_status,
        event_state=event_state,
    )
    trade.sell_computed_tags_json = computed_tags
    trade.sell_rule_checks_json = build_rule_checks(
        liquidity_score=liquidity_score,
        spread_score=spread_score,
        confidence_score=confidence,
        probability_delta=trade.sell_probability_delta,
        has_llm_output=confidence is not None,
        expired=event_state is not None and "expired" in event_state.lower(),
    )
    return computed_tags


def _apply_exit_execution(
    trade: BullpenTradeAnalysisRecord,
    *,
    summary: dict[str, object],
    exit_type: str,
    executed_at: datetime,
    sell_reason: str | None,
) -> BullpenTradeAnalysisActionableLearning:
    trade.exit_type = exit_type
    trade.sell_order_id = _safe_text(summary.get("order_id"))
    trade.sell_client_order_id = _safe_text(summary.get("client_order_id"))
    trade.sell_status = _safe_text(summary.get("status")) or exit_type.lower()
    trade.sell_filled_amount = (
        parse_float(summary.get("filled_amount")) or trade.sell_requested_amount
    )
    trade.sell_filled_shares = (
        parse_float(summary.get("filled_shares")) or trade.sell_requested_shares
    )
    trade.sell_average_fill_price = (
        parse_float(summary.get("average_fill_price")) or trade.sell_requested_price
    )
    trade.sell_average_fill_odds = (
        parse_float(summary.get("average_fill_odds")) or trade.sell_requested_odds
    )
    trade.sell_fees = parse_float(summary.get("fees"))
    trade.sell_slippage = _slippage(
        trade.sell_requested_price, trade.sell_average_fill_price
    )
    trade.sell_executed_at = executed_at
    trade.sell_reason = sell_reason or trade.sell_reason
    trade.exit_notional = _notional(
        trade.sell_filled_amount,
        trade.sell_filled_shares,
        trade.sell_average_fill_price,
    )
    trade.closed_at = executed_at
    trade.sold_at = executed_at if exit_type == "SELL" else trade.sold_at
    trade.redeemed_at = executed_at if exit_type == "REDEEM" else trade.redeemed_at
    trade.status = "REDEEMED" if exit_type == "REDEEM" else "SOLD"
    trade.lifecycle_state = (
        "BUY_AND_REDEEM_EXECUTED" if exit_type == "REDEEM" else "BUY_AND_SELL_EXECUTED"
    )
    trade.buy_notional = trade.buy_notional or _notional(
        trade.buy_filled_amount,
        trade.buy_filled_shares,
        trade.buy_average_fill_price,
    )
    trade.gross_pnl = (
        round((trade.exit_notional or 0) - (trade.buy_notional or 0), 6)
        if trade.exit_notional is not None and trade.buy_notional is not None
        else None
    )
    trade.fees_total = round((trade.buy_fees or 0) + (trade.sell_fees or 0), 6)
    trade.net_pnl = (
        round((trade.gross_pnl or 0) - (trade.fees_total or 0), 6)
        if trade.gross_pnl is not None
        else None
    )
    trade.pnl_percent = (
        round((trade.net_pnl or 0) / trade.buy_notional * 100, 4)
        if trade.buy_notional
        else None
    )
    trade.realized_return = (
        round((trade.net_pnl or 0) / trade.buy_notional, 6)
        if trade.buy_notional
        else None
    )
    trade.holding_period_seconds = _holding_period_seconds(
        trade.buy_executed_at, trade.closed_at
    )
    trade.pnl_outcome_tag = _pnl_outcome_tag(trade.net_pnl, closed=True)
    trade.final_tag = _final_exit_tag(
        exit_type=exit_type,
        sell_reason=trade.sell_reason,
        net_pnl=trade.net_pnl,
    )
    return _apply_learning_fields(trade)


def _apply_failed_exit(
    trade: BullpenTradeAnalysisRecord, *, failure_reason: str
) -> None:
    trade.sell_failure_reason = failure_reason
    trade.sell_status = "failed"
    trade.status = "FAILED"


def _base_trade_query(user_id: int) -> Select[tuple[BullpenTradeAnalysisRecord]]:
    return (
        select(BullpenTradeAnalysisRecord)
        .where(BullpenTradeAnalysisRecord.user_id == user_id)
        .order_by(
            desc(BullpenTradeAnalysisRecord.buy_executed_at),
            desc(BullpenTradeAnalysisRecord.created_at),
        )
    )


def _apply_filters(
    query: Select[tuple[BullpenTradeAnalysisRecord]],
    *,
    status: str | None = None,
    pnl_outcome: str | None = None,
    final_tag: str | None = None,
    from_date: datetime | None = None,
    to_date: datetime | None = None,
    strategy_version: str | None = None,
    category: str | None = None,
    topic: str | None = None,
    include_failed: bool = False,
) -> Select[tuple[BullpenTradeAnalysisRecord]]:
    if status:
        normalized = status.strip().upper()
        if normalized == "OPEN":
            query = query.where(BullpenTradeAnalysisRecord.closed_at.is_(None))
        elif normalized == "CLOSED":
            query = query.where(BullpenTradeAnalysisRecord.closed_at.is_not(None))
        else:
            query = query.where(BullpenTradeAnalysisRecord.status == normalized)
    elif not include_failed:
        query = query.where(
            or_(
                BullpenTradeAnalysisRecord.buy_executed_at.is_not(None),
                BullpenTradeAnalysisRecord.status.in_(["FAILED", "CANCELLED"]),
            )
        )
    if pnl_outcome:
        query = query.where(
            BullpenTradeAnalysisRecord.pnl_outcome_tag == pnl_outcome.strip().upper()
        )
    if final_tag:
        normalized_final_tag = final_tag.strip().upper()
        if normalized_final_tag in {"PROFIT", "LOSS", "BREAKEVEN", "OPEN"}:
            query = query.where(
                BullpenTradeAnalysisRecord.pnl_outcome_tag == normalized_final_tag
            )
        else:
            query = query.where(
                BullpenTradeAnalysisRecord.final_tag == normalized_final_tag
            )
    if from_date:
        query = query.where(
            or_(
                BullpenTradeAnalysisRecord.bought_at.is_(None),
                BullpenTradeAnalysisRecord.bought_at >= from_date,
            )
        )
    if to_date:
        query = query.where(
            or_(
                BullpenTradeAnalysisRecord.bought_at.is_(None),
                BullpenTradeAnalysisRecord.bought_at <= to_date,
            )
        )
    if strategy_version:
        query = query.where(
            BullpenTradeAnalysisRecord.strategy_version == strategy_version
        )
    if category:
        query = query.where(BullpenTradeAnalysisRecord.category == category)
    if topic:
        query = query.where(BullpenTradeAnalysisRecord.topic == topic)
    return query


async def sync_bullpen_trade_history_for_user(user_id: int) -> None:
    try:
        trades = await BullpenTradeHistoryReader().refresh()
    except Exception:
        logger.exception("Bullpen trade-analysis history sync failed")
        return
    if not trades:
        return
    async with AsyncSessionLocal() as session:
        service = BullpenTradeAnalysisService(session)
        await service.sync_external_trade_history(user_id=user_id, trades=trades)


class BullpenTradeAnalysisService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def sync_external_trade_history(
        self, *, user_id: int, trades: Sequence[PolymarketBullpenTradeHistoryItem]
    ) -> None:
        for trade in sorted(trades, key=lambda item: item.timestamp):
            executed_at = parse_datetime(trade.timestamp) or utc_now()
            outcome = _normalize_outcome(trade.outcome) or trade.outcome
            market_id = _safe_text(trade.market_id)
            title = _safe_text(trade.market_title) or "Bullpen prediction trade"
            side = str(trade.side).upper()
            if side == "BUY":
                entry_reference = f"bullpen-history:{trade.id}:BUY"
                existing = (
                    (
                        await self.session.execute(
                            select(BullpenTradeAnalysisRecord).where(
                                BullpenTradeAnalysisRecord.entry_reference
                                == entry_reference
                            )
                        )
                    )
                    .scalars()
                    .first()
                )
                if existing is None:
                    existing = BullpenTradeAnalysisRecord(
                        id=str(uuid4()),
                        user_id=user_id,
                        entry_reference=entry_reference,
                        source_variant="bullpen-history",
                        bot_name="Bullpen",
                        strategy_name="Bullpen Executed History",
                        strategy_version="bullpen_history",
                        status="BOUGHT",
                        lifecycle_state="BUY_EXECUTED_ONLY",
                        final_tag="OPEN",
                        pnl_outcome_tag="OPEN",
                        position_key=f"{market_id or normalize_title(title)}::{outcome}",
                        bullpen_market_id=market_id,
                        outcome_name=outcome,
                        title=title,
                        event_question=title,
                    )
                    self.session.add(existing)
                existing.bought_at = existing.bought_at or executed_at
                existing.buy_executed_at = existing.buy_executed_at or executed_at
                existing.buy_status = "executed"
                existing.buy_filled_amount = existing.buy_filled_amount or trade.amount
                existing.buy_filled_shares = existing.buy_filled_shares or trade.shares
                existing.buy_average_fill_price = (
                    existing.buy_average_fill_price or trade.price
                )
                existing.buy_average_fill_odds = existing.buy_average_fill_odds or (
                    trade.price * 100 if trade.price else None
                )
                existing.buy_notional = existing.buy_notional or _notional(
                    trade.amount, trade.shares, trade.price
                )
                existing.metadata_json = {
                    **(existing.metadata_json or {}),
                    "bullpen_history_buy": sanitize_json_value(trade.raw),
                }
                continue
            if side != "SELL":
                continue
            open_trade = (
                (
                    await self.session.execute(
                        select(BullpenTradeAnalysisRecord)
                        .where(BullpenTradeAnalysisRecord.user_id == user_id)
                        .where(BullpenTradeAnalysisRecord.closed_at.is_(None))
                        .where(BullpenTradeAnalysisRecord.outcome_name == outcome)
                        .where(
                            or_(
                                BullpenTradeAnalysisRecord.bullpen_market_id
                                == market_id,
                                BullpenTradeAnalysisRecord.title == title,
                            )
                        )
                        .order_by(
                            desc(BullpenTradeAnalysisRecord.buy_executed_at),
                            desc(BullpenTradeAnalysisRecord.created_at),
                        )
                        .limit(1)
                    )
                )
                .scalars()
                .first()
            )
            if open_trade is None:
                open_trade = BullpenTradeAnalysisRecord(
                    id=str(uuid4()),
                    user_id=user_id,
                    entry_reference=f"bullpen-history:{trade.id}:SELL:unknown-entry",
                    source_variant="bullpen-history",
                    bot_name="Bullpen",
                    strategy_name="Bullpen Executed History",
                    strategy_version="bullpen_history",
                    position_key=f"{market_id or normalize_title(title)}::{outcome}",
                    bullpen_market_id=market_id,
                    outcome_name=outcome,
                    title=title,
                    event_question=title,
                )
                self.session.add(open_trade)
            open_trade.exit_reference = (
                open_trade.exit_reference or f"bullpen-history:{trade.id}:SELL"
            )
            open_trade.status = "SOLD"
            open_trade.lifecycle_state = "EXIT_EXECUTED"
            open_trade.final_tag = _final_exit_tag(
                exit_type="SELL", sell_reason="Bullpen wallet history", net_pnl=None
            )
            open_trade.pnl_outcome_tag = _pnl_outcome_tag(
                open_trade.net_pnl, closed=True
            )
            open_trade.sold_at = open_trade.sold_at or executed_at
            open_trade.closed_at = open_trade.closed_at or executed_at
            open_trade.sell_executed_at = open_trade.sell_executed_at or executed_at
            open_trade.sell_status = "executed"
            open_trade.sell_filled_amount = (
                open_trade.sell_filled_amount or trade.amount
            )
            open_trade.sell_filled_shares = (
                open_trade.sell_filled_shares or trade.shares
            )
            open_trade.sell_average_fill_price = (
                open_trade.sell_average_fill_price or trade.price
            )
            open_trade.sell_average_fill_odds = open_trade.sell_average_fill_odds or (
                trade.price * 100 if trade.price else None
            )
            open_trade.exit_notional = open_trade.exit_notional or _notional(
                trade.amount, trade.shares, trade.price
            )
            open_trade.holding_period_seconds = _holding_period_seconds(
                open_trade.buy_executed_at, open_trade.closed_at
            )
            open_trade.metadata_json = {
                **(open_trade.metadata_json or {}),
                "bullpen_history_sell": sanitize_json_value(trade.raw),
            }
        await self.session.commit()

    async def list_trades(
        self,
        *,
        user_id: int,
        status: str | None = None,
        pnl_outcome: str | None = None,
        final_tag: str | None = None,
        from_date: datetime | None = None,
        to_date: datetime | None = None,
        strategy_version: str | None = None,
        category: str | None = None,
        topic: str | None = None,
    ) -> BullpenTradeAnalysisListResponse:
        query = _apply_filters(
            _base_trade_query(user_id),
            status=status,
            pnl_outcome=pnl_outcome,
            final_tag=final_tag,
            from_date=from_date,
            to_date=to_date,
            strategy_version=strategy_version,
            category=category,
            topic=topic,
        )
        records = (await self.session.execute(query)).scalars().all()
        return BullpenTradeAnalysisListResponse(
            items=[_build_list_item(record) for record in records],
            summary=_build_summary(records),
            learning_insights=BullpenTradeAnalysisLearningInsights.model_validate(
                build_trade_learning_insights(records)
            ),
        )

    async def get_trade_detail(
        self,
        *,
        user_id: int,
        trade_id: str,
    ) -> BullpenTradeAnalysisDetailResponse | None:
        record = (
            (
                await self.session.execute(
                    select(BullpenTradeAnalysisRecord)
                    .where(BullpenTradeAnalysisRecord.user_id == user_id)
                    .where(BullpenTradeAnalysisRecord.id == trade_id)
                    .options(
                        selectinload(BullpenTradeAnalysisRecord.snapshots),
                        selectinload(BullpenTradeAnalysisRecord.llm_entries),
                        selectinload(BullpenTradeAnalysisRecord.event_logs),
                    )
                )
            )
            .scalars()
            .first()
        )
        if record is None:
            return None
        actionable_learning = _apply_learning_fields(record)
        await self.session.commit()
        return BullpenTradeAnalysisDetailResponse(
            trade=_build_record_response(record),
            comparison=_build_comparison(record),
            actionable_learning=actionable_learning,
            snapshots=[
                BullpenTradeAnalysisSnapshot.model_validate(
                    snapshot, from_attributes=True
                )
                for snapshot in record.snapshots
            ],
            llm_entries=[
                BullpenTradeAnalysisLlmEntry.model_validate(entry, from_attributes=True)
                for entry in record.llm_entries
            ],
            event_logs=[
                BullpenTradeAnalysisEventLog.model_validate(log, from_attributes=True)
                for log in record.event_logs
            ],
        )

    async def recompute_post_trade_analysis(
        self,
        *,
        user_id: int,
        trade_id: str,
    ) -> BullpenTradeAnalysisDetailResponse | None:
        record = (
            (
                await self.session.execute(
                    select(BullpenTradeAnalysisRecord)
                    .where(BullpenTradeAnalysisRecord.user_id == user_id)
                    .where(BullpenTradeAnalysisRecord.id == trade_id)
                )
            )
            .scalars()
            .first()
        )
        if record is None:
            return None
        _apply_learning_fields(record)
        await self.session.commit()
        return await self.get_trade_detail(user_id=user_id, trade_id=trade_id)


async def capture_manual_buy_pre_submit_async(
    *,
    user_id: int,
    entry_reference: str,
    context: dict[str, object],
) -> None:
    with SyncSessionLocal() as session:
        trade = _find_or_create_trade_by_entry_reference(
            session,
            user_id=user_id,
            entry_reference=entry_reference,
            title=str(context["title"]),
            event_question=str(context["event_question"]),
        )
        computed_tags = _apply_buy_pre_submit(
            trade,
            source_variant=str(context["source_variant"]),
            bot_name=str(context.get("bot_name") or "Bullpen x AI"),
            strategy_name=_safe_text(context.get("strategy_name")),
            strategy_version=_safe_text(context.get("strategy_version")),
            run_id=_safe_text(context.get("run_id")),
            event_id=_safe_text(context.get("event_id")),
            event_slug=_safe_text(context.get("event_slug")),
            market_id=_safe_text(context.get("market_id")),
            outcome_name=_safe_text(context.get("outcome_name")),
            title=str(context["title"]),
            event_question=str(context["event_question"]),
            event_description=_safe_text(context.get("event_description")),
            category=_safe_text(context.get("category")),
            topic=_safe_text(context.get("topic")),
            source_url=_safe_text(context.get("source_url")),
            market_url=_safe_text(context.get("market_url")),
            event_close_time=parse_datetime(context.get("event_close_time")),
            requested_amount=parse_float(context.get("requested_amount")),
            requested_price=parse_float(context.get("requested_price")),
            buy_probability_estimate=parse_float(
                context.get("buy_probability_estimate")
            ),
            market_probability=parse_float(context.get("market_probability")),
            confidence=confidence_score_from_value(context.get("confidence")),
            risk_score=risk_score_from_status(context.get("risk_score")),
            expected_edge=parse_float(context.get("expected_edge")),
            expected_value=parse_float(context.get("expected_value")),
            liquidity_score=parse_float(context.get("liquidity_score")),
            volume_score=parse_float(context.get("volume_score")),
            spread_score=parse_float(context.get("spread_score")),
            volatility_score=parse_float(context.get("volatility_score")),
            evidence_status=_safe_text(context.get("evidence_status")),
            event_state=_safe_text(context.get("event_state")),
            decision_summary=_safe_text(context.get("decision_summary")),
            buy_reason=_safe_text(context.get("buy_reason")),
            selected_by_rule=bool(context.get("selected_by_rule")),
            selected_by_llm=bool(context.get("selected_by_llm")),
            selected_by_hybrid=bool(context.get("selected_by_hybrid")),
        )
        _replace_llm_entries(
            session,
            trade,
            phase="BUY_ANALYSIS",
            payloads=list(context.get("llm_payloads") or []),
            computed_tags=computed_tags,
        )
        _upsert_singleton_snapshot(
            session,
            trade,
            snapshot_type="BUY_PRE_SUBMIT",
            captured_at=utc_now(),
            bullpen_snapshot_json=dict(context.get("bullpen_snapshot_json") or {}),
            event_snapshot_json=dict(context.get("event_snapshot_json") or {}),
            market_snapshot_json=dict(context.get("market_snapshot_json") or {}),
            order_book_snapshot_json=dict(
                context.get("order_book_snapshot_json") or {}
            ),
            positions_snapshot_json=dict(context.get("positions_snapshot_json") or {}),
            raw_api_response_json=dict(context.get("raw_api_response_json") or {}),
        )
        _record_event_log(
            session,
            trade,
            run_id=_safe_text(context.get("run_id")),
            event_type="BUY_SUBMITTED",
            message=_safe_text(context.get("decision_summary"))
            or "Buy prepared for submission.",
            metadata_json=dict(context.get("log_metadata") or {}),
        )
        session.commit()


async def capture_manual_buy_result_async(
    *,
    user_id: int,
    entry_reference: str,
    raw_execution_response: str | None,
    failed: bool = False,
    failure_reason: str | None = None,
) -> None:
    with SyncSessionLocal() as session:
        trade = _find_or_create_trade_by_entry_reference(
            session,
            user_id=user_id,
            entry_reference=entry_reference,
            title=entry_reference,
            event_question=entry_reference,
        )
        if failed:
            trade.status = "FAILED"
            trade.buy_status = "failed"
            trade.buy_failure_reason = failure_reason
            _record_event_log(
                session,
                trade,
                run_id=trade.run_id,
                event_type="BUY_FAILED",
                message=failure_reason or "Buy submission failed.",
            )
            session.commit()
            return
        parsed = safe_json_loads(raw_execution_response)
        summary = extract_execution_summary(
            parsed,
            requested_amount=trade.buy_requested_amount,
            requested_shares=trade.buy_requested_shares,
            requested_price=trade.buy_requested_price,
        )
        executed_at = utc_now()
        _apply_buy_execution(trade, summary=summary, executed_at=executed_at)
        _upsert_singleton_snapshot(
            session,
            trade,
            snapshot_type="BUY_POST_EXECUTION",
            captured_at=executed_at,
            raw_api_response_json=parsed,
        )
        _record_event_log(
            session,
            trade,
            run_id=trade.run_id,
            event_type="BUY_EXECUTED",
            message="Buy executed in Bullpen.",
            metadata_json=summary,
        )
        session.commit()


def capture_auto_live_buy_pre_submit_sync(
    *,
    user_id: int,
    entry_reference: str,
    context: dict[str, object],
) -> None:
    with SyncSessionLocal() as session:
        trade = _find_or_create_trade_by_entry_reference(
            session,
            user_id=user_id,
            entry_reference=entry_reference,
            title=str(context["title"]),
            event_question=str(context["event_question"]),
        )
        computed_tags = _apply_buy_pre_submit(
            trade,
            source_variant=str(context["source_variant"]),
            bot_name=str(context.get("bot_name") or "Bullpen x AI"),
            strategy_name=_safe_text(context.get("strategy_name")),
            strategy_version=_safe_text(context.get("strategy_version")),
            run_id=_safe_text(context.get("run_id")),
            event_id=_safe_text(context.get("event_id")),
            event_slug=_safe_text(context.get("event_slug")),
            market_id=_safe_text(context.get("market_id")),
            outcome_name=_safe_text(context.get("outcome_name")),
            title=str(context["title"]),
            event_question=str(context["event_question"]),
            event_description=_safe_text(context.get("event_description")),
            category=_safe_text(context.get("category")),
            topic=_safe_text(context.get("topic")),
            source_url=_safe_text(context.get("source_url")),
            market_url=_safe_text(context.get("market_url")),
            event_close_time=parse_datetime(context.get("event_close_time")),
            requested_amount=parse_float(context.get("requested_amount")),
            requested_price=parse_float(context.get("requested_price")),
            buy_probability_estimate=parse_float(
                context.get("buy_probability_estimate")
            ),
            market_probability=parse_float(context.get("market_probability")),
            confidence=confidence_score_from_value(context.get("confidence")),
            risk_score=risk_score_from_status(context.get("risk_score")),
            expected_edge=parse_float(context.get("expected_edge")),
            expected_value=parse_float(context.get("expected_value")),
            liquidity_score=parse_float(context.get("liquidity_score")),
            volume_score=parse_float(context.get("volume_score")),
            spread_score=parse_float(context.get("spread_score")),
            volatility_score=parse_float(context.get("volatility_score")),
            evidence_status=_safe_text(context.get("evidence_status")),
            event_state=_safe_text(context.get("event_state")),
            decision_summary=_safe_text(context.get("decision_summary")),
            buy_reason=_safe_text(context.get("buy_reason")),
            selected_by_rule=bool(context.get("selected_by_rule")),
            selected_by_llm=bool(context.get("selected_by_llm")),
            selected_by_hybrid=bool(context.get("selected_by_hybrid")),
        )
        _replace_llm_entries(
            session,
            trade,
            phase="BUY_ANALYSIS",
            payloads=list(context.get("llm_payloads") or []),
            computed_tags=computed_tags,
        )
        _upsert_singleton_snapshot(
            session,
            trade,
            snapshot_type="BUY_PRE_SUBMIT",
            captured_at=parse_datetime(context.get("captured_at")) or utc_now(),
            bullpen_snapshot_json=dict(context.get("bullpen_snapshot_json") or {}),
            event_snapshot_json=dict(context.get("event_snapshot_json") or {}),
            market_snapshot_json=dict(context.get("market_snapshot_json") or {}),
            order_book_snapshot_json=dict(
                context.get("order_book_snapshot_json") or {}
            ),
            positions_snapshot_json=dict(context.get("positions_snapshot_json") or {}),
            raw_api_response_json=dict(context.get("raw_api_response_json") or {}),
        )
        _record_event_log(
            session,
            trade,
            run_id=_safe_text(context.get("run_id")),
            event_type="BUY_SUBMITTED",
            message=_safe_text(context.get("decision_summary"))
            or "Auto-Live buy prepared for submission.",
            metadata_json=dict(context.get("log_metadata") or {}),
        )
        session.commit()


def capture_auto_live_buy_result_sync(
    *,
    user_id: int,
    entry_reference: str,
    raw_execution_response: str | None,
    failed: bool = False,
    failure_reason: str | None = None,
) -> None:
    with SyncSessionLocal() as session:
        trade = _find_or_create_trade_by_entry_reference(
            session,
            user_id=user_id,
            entry_reference=entry_reference,
            title=entry_reference,
            event_question=entry_reference,
        )
        if failed:
            trade.status = "FAILED"
            trade.buy_status = "failed"
            trade.buy_failure_reason = failure_reason
            _record_event_log(
                session,
                trade,
                run_id=trade.run_id,
                event_type="BUY_FAILED",
                message=failure_reason or "Auto-Live buy failed.",
            )
            session.commit()
            return
        parsed = safe_json_loads(raw_execution_response)
        summary = extract_execution_summary(
            parsed,
            requested_amount=trade.buy_requested_amount,
            requested_shares=trade.buy_requested_shares,
            requested_price=trade.buy_requested_price,
        )
        executed_at = utc_now()
        _apply_buy_execution(trade, summary=summary, executed_at=executed_at)
        _upsert_singleton_snapshot(
            session,
            trade,
            snapshot_type="BUY_POST_EXECUTION",
            captured_at=executed_at,
            raw_api_response_json=parsed,
        )
        _record_event_log(
            session,
            trade,
            run_id=trade.run_id,
            event_type="BUY_EXECUTED",
            message="Auto-Live buy executed in Bullpen.",
            metadata_json=summary,
        )
        session.commit()


def capture_auto_live_exit_pre_submit_sync(
    *,
    user_id: int,
    exit_reference: str,
    context: dict[str, object],
) -> None:
    with SyncSessionLocal() as session:
        trade = _find_open_trade(
            session,
            user_id=user_id,
            market_id=_safe_text(context.get("market_id")),
            outcome_name=_safe_text(context.get("outcome_name")),
            title=_safe_text(context.get("title")),
        )
        if trade is None:
            trade = _find_or_create_trade_by_entry_reference(
                session,
                user_id=user_id,
                entry_reference=f"backfill-open:{exit_reference}",
                title=str(context["title"]),
                event_question=str(context.get("event_question") or context["title"]),
            )
            trade.status = "BOUGHT"
            trade.lifecycle_state = "BUY_EXECUTED_ONLY"
            trade.analysis_summary = "Backfilled from historical order data; detailed buy/sell snapshots unavailable."
        computed_tags = _apply_exit_pre_submit(
            trade,
            exit_reference=exit_reference,
            exit_type=str(context.get("exit_type") or "SELL"),
            submitted_at=parse_datetime(context.get("captured_at")) or utc_now(),
            requested_amount=parse_float(context.get("requested_amount")),
            requested_shares=parse_float(context.get("requested_shares")),
            requested_price=parse_float(context.get("requested_price")),
            probability_estimate=parse_float(context.get("probability_estimate")),
            market_probability=parse_float(context.get("market_probability")),
            confidence=confidence_score_from_value(context.get("confidence")),
            risk_score=risk_score_from_status(context.get("risk_score")),
            expected_edge=parse_float(context.get("expected_edge")),
            expected_value=parse_float(context.get("expected_value")),
            liquidity_score=parse_float(context.get("liquidity_score")),
            volume_score=parse_float(context.get("volume_score")),
            spread_score=parse_float(context.get("spread_score")),
            volatility_score=parse_float(context.get("volatility_score")),
            decision_summary=_safe_text(context.get("decision_summary")),
            sell_reason=_safe_text(context.get("sell_reason")),
            evidence_status=_safe_text(context.get("evidence_status")),
            event_state=_safe_text(context.get("event_state")),
        )
        _replace_llm_entries(
            session,
            trade,
            phase="EXIT_ANALYSIS",
            payloads=list(context.get("llm_payloads") or []),
            computed_tags=computed_tags,
        )
        _upsert_singleton_snapshot(
            session,
            trade,
            snapshot_type="SELL_PRE_SUBMIT",
            captured_at=parse_datetime(context.get("captured_at")) or utc_now(),
            bullpen_snapshot_json=dict(context.get("bullpen_snapshot_json") or {}),
            event_snapshot_json=dict(context.get("event_snapshot_json") or {}),
            market_snapshot_json=dict(context.get("market_snapshot_json") or {}),
            order_book_snapshot_json=dict(
                context.get("order_book_snapshot_json") or {}
            ),
            positions_snapshot_json=dict(context.get("positions_snapshot_json") or {}),
            raw_api_response_json=dict(context.get("raw_api_response_json") or {}),
        )
        _record_event_log(
            session,
            trade,
            run_id=_safe_text(context.get("run_id") or trade.run_id),
            event_type="SELL_SUBMITTED",
            message=_safe_text(context.get("decision_summary"))
            or "Exit prepared for submission.",
            metadata_json=dict(context.get("log_metadata") or {}),
        )
        session.commit()


def capture_auto_live_exit_result_sync(
    *,
    user_id: int,
    exit_reference: str,
    market_id: str | None,
    outcome_name: str | None,
    title: str | None,
    raw_execution_response: str | None,
    exit_type: str = "SELL",
    failed: bool = False,
    failure_reason: str | None = None,
    sell_reason: str | None = None,
) -> None:
    with SyncSessionLocal() as session:
        trade = (
            session.execute(
                select(BullpenTradeAnalysisRecord)
                .where(BullpenTradeAnalysisRecord.exit_reference == exit_reference)
                .limit(1)
            )
            .scalars()
            .first()
        )
        if trade is None:
            trade = _find_open_trade(
                session,
                user_id=user_id,
                market_id=market_id,
                outcome_name=outcome_name,
                title=title,
            )
        if trade is None:
            return
        if failed:
            _apply_failed_exit(trade, failure_reason=failure_reason or "Exit failed.")
            _record_event_log(
                session,
                trade,
                run_id=trade.run_id,
                event_type="EXIT_FAILED",
                message=failure_reason or "Exit failed.",
            )
            session.commit()
            return
        parsed = safe_json_loads(raw_execution_response)
        summary = extract_execution_summary(
            parsed,
            requested_amount=trade.sell_requested_amount,
            requested_shares=trade.sell_requested_shares,
            requested_price=trade.sell_requested_price,
        )
        executed_at = utc_now()
        learning = _apply_exit_execution(
            trade,
            summary=summary,
            exit_type=exit_type,
            executed_at=executed_at,
            sell_reason=sell_reason,
        )
        _upsert_singleton_snapshot(
            session,
            trade,
            snapshot_type=(
                "REDEEM_POST_EXECUTION"
                if exit_type == "REDEEM"
                else "SELL_POST_EXECUTION"
            ),
            captured_at=executed_at,
            raw_api_response_json=parsed,
        )
        _record_event_log(
            session,
            trade,
            run_id=trade.run_id,
            event_type="REDEEMED" if exit_type == "REDEEM" else "SELL_EXECUTED",
            message=(
                "Redeem executed in Bullpen."
                if exit_type == "REDEEM"
                else "Sell executed in Bullpen."
            ),
            metadata_json={**summary, "learning": learning.model_dump(mode="json")},
        )
        _record_event_log(
            session,
            trade,
            run_id=trade.run_id,
            event_type="POST_TRADE_ANALYSED",
            message=trade.analysis_summary or "Post-trade analysis refreshed.",
            metadata_json=learning.model_dump(mode="json"),
        )
        session.commit()


async def sync_redeemed_trades_async(
    *,
    user_id: int,
    redeemed_trades: Iterable[object],
) -> None:
    with SyncSessionLocal() as session:
        for redeemed in redeemed_trades:
            market_id = _safe_text(getattr(redeemed, "market_id", None))
            title = _safe_text(getattr(redeemed, "market_title", None))
            outcome = _safe_text(getattr(redeemed, "outcome", None))
            trade = _find_open_trade(
                session,
                user_id=user_id,
                market_id=market_id,
                outcome_name=outcome,
                title=title,
            )
            if trade is None:
                continue
            if trade.closed_at is not None and trade.exit_type == "REDEEM":
                continue
            payout_amount = parse_float(getattr(redeemed, "amount", None))
            price = parse_float(getattr(redeemed, "price", None))
            parsed = sanitize_json_value(
                {
                    "id": getattr(redeemed, "id", None),
                    "timestamp": getattr(redeemed, "timestamp", None),
                    "market_id": market_id,
                    "market_title": title,
                    "outcome": outcome,
                    "amount": payout_amount,
                    "shares": getattr(redeemed, "shares", None),
                    "price": price,
                    "profit_loss": getattr(redeemed, "profit_loss", None),
                    "status": getattr(redeemed, "status", None),
                    "detail": getattr(redeemed, "detail", None),
                }
            )
            summary = extract_execution_summary(
                parsed,
                requested_amount=trade.sell_requested_amount or payout_amount,
                requested_shares=parse_float(getattr(redeemed, "shares", None))
                or trade.sell_requested_shares,
                requested_price=price or trade.sell_requested_price or 1,
            )
            executed_at = (
                parse_datetime(getattr(redeemed, "timestamp", None)) or utc_now()
            )
            _apply_exit_execution(
                trade,
                summary=summary,
                exit_type="REDEEM",
                executed_at=executed_at,
                sell_reason=_safe_text(getattr(redeemed, "detail", None))
                or "Redeemed in Bullpen.",
            )
            _upsert_singleton_snapshot(
                session,
                trade,
                snapshot_type="REDEEM_POST_EXECUTION",
                captured_at=executed_at,
                raw_api_response_json=parsed,
            )
            _record_event_log(
                session,
                trade,
                run_id=trade.run_id,
                event_type="REDEEMED",
                message="Redeem synced from Bullpen wallet history.",
                metadata_json=parsed,
            )
        session.commit()


def sync_auto_live_position_snapshots_sync(
    *,
    user_id: int,
    positions: Iterable[object],
) -> None:
    with SyncSessionLocal() as session:
        for position in positions:
            market_id = _safe_text(getattr(position, "market_id", None))
            side = _safe_text(getattr(position, "side", None))
            title = _safe_text(getattr(position, "market_title", None))
            trade = _find_open_trade(
                session,
                user_id=user_id,
                market_id=market_id,
                outcome_name=side,
                title=title,
            )
            if trade is None:
                continue
            price_history = list(getattr(position, "price_history", []) or [])
            latest_price = price_history[-1] if price_history else None
            latest_timestamp = (
                parse_datetime(getattr(latest_price, "timestamp", None)) or utc_now()
            )
            current_price_cents = parse_float(
                getattr(position, "current_price_cents", None)
            )
            held_probability = parse_float(
                getattr(latest_price, "heldProbability", None)
            )
            latest_monitor = {
                "captured_at": latest_timestamp.isoformat(),
                "current_price_cents": (
                    current_price_cents
                    if current_price_cents is not None
                    else (
                        round((held_probability or 0) * 100, 4)
                        if held_probability is not None
                        else None
                    )
                ),
                "held_probability": held_probability,
                "adverse_probability": parse_float(
                    getattr(latest_price, "adverseProbability", None)
                ),
                "held_best_bid": parse_float(
                    getattr(latest_price, "heldBestBid", None)
                ),
            }
            history_prices = [
                parse_float(getattr(item, "heldProbability", None))
                for item in price_history
                if parse_float(getattr(item, "heldProbability", None)) is not None
            ]
            if history_prices:
                trade.max_favorable_price = round(max(history_prices) * 100, 4)
                trade.max_adverse_price = round(min(history_prices) * 100, 4)
                trade.best_possible_exit_price_after_buy = trade.max_favorable_price
                trade.worst_price_after_buy = trade.max_adverse_price
                buy_price = trade.buy_average_fill_odds or trade.buy_requested_odds
                if buy_price is not None:
                    trade.drawdown_while_held = round(
                        (trade.max_adverse_price - buy_price) / max(buy_price, 1),
                        6,
                    )
                    latest_exit = (
                        trade.sell_average_fill_odds or trade.sell_requested_odds
                    )
                    if latest_exit is not None:
                        trade.missed_profit_amount = round(
                            max(trade.max_favorable_price - latest_exit, 0),
                            4,
                        )
            trade.metadata_json = sanitize_json_value(
                {
                    **(trade.metadata_json or {}),
                    "latest_monitor": latest_monitor,
                    "position_snapshot": {
                        "market_id": market_id,
                        "side": side,
                        "shares": getattr(position, "shares", None),
                        "exposure_usd": getattr(position, "exposure_usd", None),
                        "average_price_cents": getattr(
                            position, "average_price_cents", None
                        ),
                        "close_time": getattr(position, "close_time", None),
                        "exit_state": getattr(position, "exit_state", None),
                    },
                }
            )
            _upsert_singleton_snapshot(
                session,
                trade,
                snapshot_type="PERIODIC_MONITOR",
                captured_at=latest_timestamp,
                market_snapshot_json=sanitize_json_value(latest_monitor),
                positions_snapshot_json=sanitize_json_value(
                    trade.metadata_json.get("position_snapshot", {})
                ),
                raw_api_response_json=sanitize_json_value(
                    {
                        "price_history": [
                            getattr(item, "__dict__", item) for item in price_history
                        ]
                    }
                ),
            )
        session.commit()
