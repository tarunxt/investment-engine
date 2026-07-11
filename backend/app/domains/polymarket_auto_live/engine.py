from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Callable
from uuid import NAMESPACE_URL, uuid5

from app.core.logging import get_logger
from app.domains.bullpen_trade_analysis.helpers import (
    bounded_score,
    parse_float,
    sanitize_json_value,
)
from app.domains.bullpen_trade_analysis.service import (
    capture_auto_live_buy_pre_submit_sync,
    capture_auto_live_buy_result_sync,
    capture_auto_live_exit_pre_submit_sync,
    capture_auto_live_exit_result_sync,
)
from app.domains.polymarket import bullpen as bullpen_module
from app.domains.polymarket_auto_live.console_profile import (
    DEFAULT_CONSOLE_ORDER_USD,
    CONSOLE_MIN_LLM_STRONG_SIDE_ODDS,
    CONSOLE_MIN_MARKET_ODDS,
    CONSOLE_PROFILE_ID,
    CONSOLE_RANKED_EVENT_LIMIT,
    CONSOLE_SCHEDULE_HOURS,
    CONSOLE_SCAN_WINDOW_DAYS,
    ConsoleWalletPosition,
    ConsoleScanResult,
    apply_scanned_market_to_position,
    candidate_returns_per_day,
    console_market_filter_reasons,
    next_console_schedule_time,
    next_custom_console_schedule_time,
    position_returns_per_day,
    read_console_wallet_positions,
    scan_console_profile_markets,
)
from app.domains.polymarket_auto_live.config import (
    auto_live_backend_allows_execution,
    auto_live_backend_execution_env_detail,
)
from app.domains.polymarket_auto_live.evidence import EvidencePacket, build_evidence_packet
from app.domains.polymarket_auto_live.event_exit import (
    DEFAULT_FORCED_EXIT_CONFIG,
    EventExitContext,
    EventExitSnapshot,
    ExitSignal,
    PositionPriceSnapshot,
    RankingAndLlmExitContext,
    build_position_price_snapshot,
    evaluate_event_exits,
    merge_price_history,
    summarize_exit_labels,
)
from app.domains.polymarket_auto_live.execution import (
    buy_limit_price_cents,
    cents_to_decimal,
    refresh_balance,
    refresh_execution_quote,
    refresh_live_controls,
    refresh_runtime_execution_settings,
    sell_limit_price_cents,
)
from app.domains.polymarket_auto_live.llm import (
    EVIDENCE_RANK,
    LlmConsensus,
    CONFIDENCE_RANK,
    run_llm_consensus,
)
from app.domains.polymarket_auto_live.normalization import (
    normalize_auto_live_confidence,
    normalize_auto_live_evidence_status,
)
from app.domains.polymarket_auto_live.rules import RuleEvaluation, evaluate_market_rules
from app.domains.polymarket_auto_live.scanner import (
    ScanRejectedMarket,
    ScannedMarket,
    fetch_market_by_slug,
    scan_candidate_markets,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveConsoleCandidateInput,
    BullpenAutoLiveDecision,
    BullpenAutoLiveGuardrailCheck,
    BullpenAutoLiveLlmOutput,
    BullpenAutoLiveOrderPlan,
    BullpenAutoLiveRejectedCandidateDiagnostic,
    BullpenAutoLiveRun,
    BullpenAutoLiveSettings,
    BullpenAutoLiveStageResult,
    BullpenAutoLiveState,
)

STAGE_NAMES = {
    1: "Candidate Scan",
    2: "Market Rules & Deadline",
    3: "Evidence + LLM Consensus",
    4: "Scoring",
    5: "Sizing",
    6: "Rebalance & Exit",
    7: "Execution",
}
_DEFAULT_COMPLETED_AT = object()
DECISION_ACTIONABLES = {"BUY_NEW", "ADD_MORE", "TRIM", "EXIT"}
CONFIDENCE_WEIGHT = {"Low": 0.55, "Medium": 0.8, "High": 1.0}
EVIDENCE_WEIGHT = {"Low": 0.55, "Moderate": 0.8, "Strong": 1.0}
HIGH_LLM_PROVIDER_ERROR_RATE = 0.5
SUPPORTED_OUTCOME_SIDES = {"YES", "NO"}
CONSOLE_FRESH_LLM_CANDIDATE_CAP = 50

logger = get_logger("app.domains.polymarket_auto_live.engine")
BULLPEN_ORDER_SUBMISSION_TIMEOUT_SECONDS = 60

ProgressCallback = Callable[[BullpenAutoLiveRun, BullpenAutoLiveState], None]


def utc_now() -> datetime:
    return datetime.now(UTC)


def utc_now_iso() -> str:
    return utc_now().isoformat()


def _auto_live_record_id(
    prefix: str,
    *,
    run_id: str,
    market_id: str,
    action: str,
) -> str:
    raw_action_slug = str(action).strip().lower().replace("_", "-") or "unknown"
    digest = uuid5(
        NAMESPACE_URL,
        f"bullpen-auto-live:{prefix}:{run_id}:{market_id}:{raw_action_slug}",
    ).hex
    # Auto-Live decision and order IDs are persisted in String(64) columns.
    # Keep the full UUID5 digest for uniqueness and trim only the readable
    # action label so long explicit actions cannot crash Stage 3 persistence.
    max_action_length = max(1, 64 - len(prefix) - len(digest) - 2)
    action_slug = raw_action_slug[:max_action_length].rstrip("-") or "unknown"
    return f"{prefix}-{action_slug}-{digest}"


def round_money(value: float | None) -> float | None:
    if value is None:
        return None
    return round(value, 2)


def console_order_usd(settings: BullpenAutoLiveSettings) -> float:
    return round(settings.console_order_usd or DEFAULT_CONSOLE_ORDER_USD, 2)


def score_rank(value: str | None, mapping: dict[str, int]) -> int:
    if not value:
        return -1
    return mapping.get(value, -1)


def build_guardrail_check(
    *,
    check_id: str,
    label: str,
    status: str,
    detail: str,
    value: str | None = None,
    blocking: bool = False,
    checked_at: str | None = None,
) -> BullpenAutoLiveGuardrailCheck:
    return BullpenAutoLiveGuardrailCheck(
        id=check_id,
        label=label,
        status=status,  # type: ignore[arg-type]
        detail=detail,
        value=value,
        blocking=blocking,
        checked_at=checked_at or utc_now_iso(),
    )


def build_stage_result(
    *,
    stage_number: int,
    status: str,
    reason: str,
    inputs: dict[str, object] | None = None,
    outputs: dict[str, object] | None = None,
    guardrails_checked: list[BullpenAutoLiveGuardrailCheck] | None = None,
    hard_block: bool = False,
    started_at: str | None = None,
    completed_at: str | None | object = _DEFAULT_COMPLETED_AT,
) -> BullpenAutoLiveStageResult:
    resolved_completed_at = (
        utc_now_iso() if completed_at is _DEFAULT_COMPLETED_AT else completed_at
    )
    return BullpenAutoLiveStageResult(
        stage_number=stage_number,
        stage_name=STAGE_NAMES[stage_number],
        status=status,  # type: ignore[arg-type]
        reason=reason,
        inputs=inputs or {},
        outputs=outputs or {},
        guardrails_checked=guardrails_checked or [],
        hard_block=hard_block,
        started_at=started_at or utc_now_iso(),
        completed_at=resolved_completed_at,
    )


def build_workflow_stage_result(
    *,
    stage_number: int,
    workflow_stage_key: str,
    phase_status: str,
    status: str,
    reason: str,
    completed_items: int | None = None,
    total_items: int | None = None,
    item_label: str | None = None,
    inputs: dict[str, object] | None = None,
    outputs: dict[str, object] | None = None,
    guardrails_checked: list[BullpenAutoLiveGuardrailCheck] | None = None,
    hard_block: bool = False,
    started_at: str | None = None,
    completed_at: str | None | object = _DEFAULT_COMPLETED_AT,
) -> BullpenAutoLiveStageResult:
    workflow_outputs = dict(outputs or {})
    workflow_outputs["workflow_stage_key"] = workflow_stage_key
    workflow_outputs["phase_status"] = phase_status
    if completed_items is not None:
        workflow_outputs["completed_items"] = completed_items
    if total_items is not None:
        workflow_outputs["total_items"] = total_items
    if item_label is not None:
        workflow_outputs["item_label"] = item_label
    stage_result_kwargs = {
        "stage_number": stage_number,
        "status": status,
        "reason": reason,
        "inputs": inputs,
        "outputs": workflow_outputs,
        "guardrails_checked": guardrails_checked,
        "hard_block": hard_block,
        "started_at": started_at,
    }
    if completed_at is not _DEFAULT_COMPLETED_AT:
        stage_result_kwargs["completed_at"] = completed_at
    return build_stage_result(**stage_result_kwargs)


def set_run_stage_result(
    run: BullpenAutoLiveRun,
    stage_result: BullpenAutoLiveStageResult,
) -> None:
    for index, existing in enumerate(run.stage_results):
        if existing.stage_number == stage_result.stage_number:
            run.stage_results[index] = stage_result
            return
    run.stage_results.append(stage_result)


@dataclass
class PositionSnapshot:
    market_id: str
    slug: str | None
    market_title: str
    market_url: str | None
    theme: str
    side: str
    exposure_usd: float
    shares: float
    average_price_cents: float
    opened_at: datetime
    updated_at: datetime
    close_time: str | None = None
    current_price_cents: float | None = None
    condition_id: str | None = None
    current_yes_odds: float | None = None
    current_no_odds: float | None = None
    best_bid_cents: float | None = None
    best_ask_cents: float | None = None
    price_history: list[PositionPriceSnapshot] = field(default_factory=list)
    exit_signals: list[ExitSignal] = field(default_factory=list)
    exit_state: str = "ACTIVE"
    estimated_freeable_value_usd: float | None = None


@dataclass
class CandidateEvaluation:
    market: ScannedMarket
    current_position: PositionSnapshot | None
    stage_results: list[BullpenAutoLiveStageResult] = field(default_factory=list)
    guardrail_checks: list[BullpenAutoLiveGuardrailCheck] = field(default_factory=list)
    rules: RuleEvaluation | None = None
    evidence_packet: EvidencePacket | None = None
    llm_outputs: list = field(default_factory=list)
    llm_consensus: LlmConsensus | None = None
    side_to_trade: str | None = None
    market_price_percent: float | None = None
    fair_probability_percent: float | None = None
    edge_pp: float = 0
    score: float = 0
    confidence: str = "Low"
    evidence_status: str = "Low"
    event_state: str | None = None
    disagreement_level: str | None = None
    disagreement_category: str | None = None
    current_exposure_usd: float = 0
    target_exposure_usd: float = 0
    order_usd: float = 0
    order_shares: float = 0
    hard_block_reasons: list[str] = field(default_factory=list)
    reason: str = ""
    decision_action: str = "SKIP"
    order_plan: BullpenAutoLiveOrderPlan | None = None
    realized_pnl_usd: float | None = None
    execution_edge_threshold_pp: float | None = None


@dataclass
class EngineResult:
    run: BullpenAutoLiveRun
    decisions: list[BullpenAutoLiveDecision]
    state: BullpenAutoLiveState
    positions: list[PositionSnapshot]


def live_execution_requested(settings: BullpenAutoLiveSettings) -> bool:
    return (
        settings.auto_live_enabled
        and not settings.dry_run
        and settings.allow_live_execution
    )


def live_execution_armed(settings: BullpenAutoLiveSettings) -> bool:
    return live_execution_requested(settings) and auto_live_backend_allows_execution()


def effective_dry_run(settings: BullpenAutoLiveSettings) -> bool:
    return not live_execution_armed(settings)


def _decision_log_level(decision: BullpenAutoLiveDecision) -> str:
    order_status = decision.order_plan.status if decision.order_plan else None
    if decision.decision == "SKIP" or order_status in {"skipped", "failed", "cancelled"}:
        return "warning"
    return "info"


def _decision_log_reason(decision: BullpenAutoLiveDecision) -> str:
    if decision.order_plan and decision.order_plan.detail:
        return decision.order_plan.detail
    return decision.reason


def _liquidity_weight(liquidity_usd: float | None, minimum: float) -> float:
    if liquidity_usd is None or minimum <= 0:
        return 0.8
    if liquidity_usd < minimum:
        return 0.5
    if liquidity_usd < minimum * 2:
        return 0.75
    if liquidity_usd < minimum * 4:
        return 0.9
    return 1.0


def _disagreement_weight(consensus: LlmConsensus | None, settings: BullpenAutoLiveSettings) -> float:
    if consensus is None:
        return 0.7
    if consensus.disagreement_level == "High" or consensus.adjudication_required:
        return 0.4
    if consensus.disagreement_level == "Medium":
        return 0.7
    if consensus.trimmed_range_yes is None:
        return 0.85
    if consensus.trimmed_range_yes > settings.half_size_llm_spread_pp:
        return 0.85
    return 1.0


def _current_price_for_side(market: ScannedMarket, side: str) -> float | None:
    return market.current_yes_odds if side == "YES" else market.current_no_odds


def _probability_from_percent(value: float | None) -> float | None:
    if value is None:
        return None
    return round(min(1.0, max(0.0, value / 100)), 4)


def _held_probability_for_side(
    *,
    held_side: str | None,
    yes_probability: float | None,
    no_probability: float | None,
) -> float | None:
    if held_side == "YES":
        return yes_probability
    if held_side == "NO":
        return no_probability
    return None


def _held_best_bid_for_side(
    *,
    held_side: str | None,
    best_bid_cents: float | None,
    best_ask_cents: float | None,
    fallback_probability: float | None,
) -> float | None:
    if held_side == "YES":
        if best_bid_cents is not None:
            return round(min(1.0, max(0.0, best_bid_cents / 100)), 4)
        return fallback_probability
    if held_side == "NO":
        if best_ask_cents is not None:
            return round(min(1.0, max(0.0, (100 - best_ask_cents) / 100)), 4)
        return fallback_probability
    return None


def _estimated_freeable_value(
    *,
    shares: float,
    held_best_bid: float | None,
) -> float | None:
    if held_best_bid is None:
        return None
    return round(max(0.0, shares * held_best_bid), 6)


def _event_exit_reason(signals: list[ExitSignal], fallback: str) -> str:
    labels = summarize_exit_labels(signals)
    return labels if labels else fallback


def _stronger_probability_side(
    *,
    yes_probability: float | None,
    no_probability: float | None,
    minimum_probability: float,
) -> tuple[str | None, float | None]:
    if yes_probability is None and no_probability is None:
        return None, None

    normalized_yes = yes_probability if yes_probability is not None else float("-inf")
    normalized_no = no_probability if no_probability is not None else float("-inf")
    strongest_probability = max(normalized_yes, normalized_no)
    if strongest_probability == float("-inf"):
        return None, None
    if strongest_probability <= minimum_probability:
        return None, strongest_probability
    if normalized_yes >= normalized_no:
        return "YES", strongest_probability
    return "NO", strongest_probability


def _is_supported_outcome_side(side: str | None) -> bool:
    return side in SUPPORTED_OUTCOME_SIDES


def _evidence_below_minimum(value: str | None, settings: BullpenAutoLiveSettings) -> bool:
    return score_rank(value, EVIDENCE_RANK) < score_rank(settings.min_evidence_status, EVIDENCE_RANK)


def _confidence_below_minimum(value: str | None, settings: BullpenAutoLiveSettings) -> bool:
    return score_rank(value, CONFIDENCE_RANK) < score_rank(settings.min_confidence, CONFIDENCE_RANK)


def _position_by_market(positions: list[PositionSnapshot], market_id: str) -> list[PositionSnapshot]:
    return [position for position in positions if position.market_id == market_id]


def _same_side_position(
    positions: list[PositionSnapshot], market_id: str, side: str
) -> PositionSnapshot | None:
    return next(
        (
            position
            for position in positions
            if position.market_id == market_id and position.side == side
        ),
        None,
    )


def _active_market_count(positions: list[PositionSnapshot]) -> int:
    return len({position.market_id for position in positions if position.exposure_usd > 0})


def _theme_exposure(positions: list[PositionSnapshot], theme: str) -> float:
    return round(sum(position.exposure_usd for position in positions if position.theme == theme), 2)


def _open_exposure(positions: list[PositionSnapshot]) -> float:
    return round(sum(position.exposure_usd for position in positions), 2)


def _position_cooldown_passed(position: PositionSnapshot, settings: BullpenAutoLiveSettings, now: datetime) -> bool:
    return now - position.updated_at >= timedelta(hours=settings.trade_cooldown_hours_per_market)


def _daily_weekly_loss_stops(
    historical_decisions: list[BullpenAutoLiveDecision],
    bankroll_usd: float,
    settings: BullpenAutoLiveSettings,
    *,
    now: datetime,
) -> tuple[bool, bool]:
    daily_floor = -bankroll_usd * (settings.max_daily_loss_pct_bankroll / 100)
    weekly_floor = -bankroll_usd * (settings.max_weekly_loss_pct_bankroll / 100)
    daily_total = 0.0
    weekly_total = 0.0
    for decision in historical_decisions:
        if decision.realized_pnl_usd is None:
            continue
        executed_at = decision.order_plan.executed_at if decision.order_plan else None
        if not executed_at:
            continue
        try:
            executed_dt = datetime.fromisoformat(executed_at)
        except ValueError:
            continue
        if executed_dt.tzinfo is None:
            executed_dt = executed_dt.replace(tzinfo=UTC)
        executed_dt = executed_dt.astimezone(UTC)
        age = now - executed_dt
        if age <= timedelta(days=1):
            daily_total += decision.realized_pnl_usd
        if age <= timedelta(days=7):
            weekly_total += decision.realized_pnl_usd
    return daily_total <= daily_floor, weekly_total <= weekly_floor


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _latest_execution_at(decisions: list[BullpenAutoLiveDecision]) -> str | None:
    latest: datetime | None = None
    latest_raw: str | None = None
    for decision in decisions:
        executed_at = _parse_iso_datetime(
            decision.order_plan.executed_at if decision.order_plan else None
        )
        if executed_at is None or (latest is not None and executed_at <= latest):
            continue
        latest = executed_at
        latest_raw = decision.order_plan.executed_at if decision.order_plan else None
    return latest_raw


def _today_order_counts(
    decisions: list[BullpenAutoLiveDecision],
    *,
    now: datetime,
) -> tuple[int, int]:
    executed = 0
    skipped = 0
    today = now.date()
    for decision in decisions:
        order_plan = decision.order_plan
        if order_plan is None:
            continue
        executed_at = _parse_iso_datetime(order_plan.executed_at)
        created_at = _parse_iso_datetime(decision.created_at)
        if executed_at and executed_at.date() == today and order_plan.status == "submitted":
            executed += 1
            continue
        if (
            created_at
            and created_at.date() == today
            and order_plan.status in {"skipped", "cancelled"}
        ):
            skipped += 1
    return executed, skipped


def _count_consecutive_failed_orders(decisions: list[BullpenAutoLiveDecision]) -> int:
    sortable: list[tuple[datetime, str]] = []
    for decision in decisions:
        order_plan = decision.order_plan
        if order_plan is None:
            continue
        timestamp = _parse_iso_datetime(
            order_plan.executed_at or decision.updated_at or decision.created_at
        )
        if timestamp is None:
            continue
        sortable.append((timestamp, order_plan.status))
    sortable.sort(key=lambda item: item[0], reverse=True)

    streak = 0
    for _, status in sortable:
        if status == "failed":
            streak += 1
            continue
        if status == "submitted":
            break
    return streak


def _fair_probability_for_side(
    candidate: CandidateEvaluation,
    side: str,
) -> float | None:
    if candidate.llm_consensus is None:
        return None
    if side == "YES":
        return candidate.llm_consensus.fair_yes_probability_pct
    return candidate.llm_consensus.fair_no_probability_pct


def _simulation_reason(settings: BullpenAutoLiveSettings) -> str:
    if settings.dry_run:
        return "Dry-run is enabled."
    if not settings.auto_live_enabled:
        return "Auto-live is disabled, so the run stayed in simulation mode."
    if not settings.allow_live_execution:
        return "Live execution is disabled in settings, so the run stayed in simulation mode."
    if not auto_live_backend_allows_execution():
        return "Backend environment does not allow auto-live execution."
    return "Live execution is not armed."


def _decision_stage_result(
    decision: BullpenAutoLiveDecision,
    stage_number: int,
) -> BullpenAutoLiveStageResult | None:
    return next(
        (stage for stage in reversed(decision.stage_results) if stage.stage_number == stage_number),
        None,
    )


def _collect_live_order_issues(
    decisions: list[BullpenAutoLiveDecision],
) -> list[dict[str, object]]:
    issues: list[dict[str, object]] = []
    for decision in decisions:
        order_plan = decision.order_plan
        if order_plan is None or order_plan.dry_run or order_plan.status == "submitted":
            continue
        stage7 = _decision_stage_result(decision, 7)
        detail = order_plan.detail.strip() or "No execution detail was recorded."
        hard_failure = order_plan.status in {"failed", "cancelled"} or (
            stage7 is not None and stage7.status == "fail"
        )
        issues.append(
            {
                "market_id": decision.market_id,
                "market_title": decision.market_title,
                "action": order_plan.action,
                "status": order_plan.status,
                "detail": detail,
                "hard_failure": hard_failure,
            }
        )
    return issues


def _summarize_live_order_issues(
    issue_rows: list[dict[str, object]],
    *,
    planned_orders: int,
    submitted_orders: int,
) -> str | None:
    if not issue_rows:
        return None

    total_issues = len(issue_rows)
    sell_issues = sum(1 for row in issue_rows if row.get("action") == "sell")
    buy_issues = sum(1 for row in issue_rows if row.get("action") == "buy")

    if total_issues == 1:
        row = issue_rows[0]
        action_label = (
            "Event Exit order" if row.get("action") == "sell" else "planned buy order"
        )
        return (
            f"Live execution submitted {submitted_orders} of {planned_orders} planned orders. "
            f"The {action_label} for {row.get('market_title') or 'an unknown market'} "
            f"was not submitted: {row.get('detail') or 'No execution detail was recorded.'}"
        )

    issue_label_parts: list[str] = []
    if sell_issues:
        issue_label_parts.append(f"{sell_issues} Event Exit")
    if buy_issues:
        issue_label_parts.append(f"{buy_issues} planned buy")
    issue_label = " and ".join(issue_label_parts) if issue_label_parts else f"{total_issues} planned"
    issue_label = issue_label[:1].upper() + issue_label[1:]
    example_rows = issue_rows[:2]
    examples = "; ".join(
        f"{row.get('market_title') or 'Unknown market'}: "
        f"{row.get('detail') or 'No execution detail was recorded.'}"
        for row in example_rows
    )
    remaining_count = total_issues - len(example_rows)
    more_suffix = f" ({remaining_count} more)" if remaining_count > 0 else ""
    return (
        f"Live execution submitted {submitted_orders} of {planned_orders} planned orders. "
        f"{issue_label} orders were not submitted. {examples}{more_suffix}"
    )


def _llm_provider_error_rate_high(evaluated: list[CandidateEvaluation]) -> bool:
    return any(
        candidate.llm_consensus is not None
        and candidate.llm_consensus.provider_error_rate >= HIGH_LLM_PROVIDER_ERROR_RATE
        for candidate in evaluated
    )


def _run_guardrails(
    settings: BullpenAutoLiveSettings,
    state: BullpenAutoLiveState,
) -> list[BullpenAutoLiveGuardrailCheck]:
    checked_at = utc_now_iso()
    return [
        build_guardrail_check(
            check_id="auto-live-enabled",
            label="Auto-live enabled",
            status="pass" if settings.auto_live_enabled else "watch",
            detail="The strategy can schedule automatic runs."
            if settings.auto_live_enabled
            else "Automation is disabled, so only manual runs should execute.",
            value="On" if settings.auto_live_enabled else "Off",
            checked_at=checked_at,
        ),
        build_guardrail_check(
            check_id="live-execution-env",
            label="Backend live execution",
            status="pass" if auto_live_backend_allows_execution() else "watch",
            detail="Backend environment allows Auto-Live execution."
            if auto_live_backend_allows_execution()
            else auto_live_backend_execution_env_detail(),
            value="Allowed" if auto_live_backend_allows_execution() else "Blocked",
            checked_at=checked_at,
        ),
        build_guardrail_check(
            check_id="live-armed",
            label="Live armed",
            status="pass" if state.live_armed else "watch",
            detail="Env plus Auto-Live settings are armed for live execution."
            if state.live_armed
            else "Live execution is not armed, so the engine will simulate decisions only.",
            value="Armed" if state.live_armed else "Simulation",
            checked_at=checked_at,
        ),
        build_guardrail_check(
            check_id="limit-orders-only",
            label="Limit orders only",
            status="pass" if settings.limit_orders_only else "fail",
            detail="Live execution is limited to explicit limit orders."
            if settings.limit_orders_only
            else "Live execution is blocked because limit orders only is disabled.",
            value="Required" if settings.limit_orders_only else "Blocked",
            blocking=not settings.limit_orders_only,
            checked_at=checked_at,
        ),
        build_guardrail_check(
            check_id="manual-confirmation",
            label="Manual confirmation",
            status="watch" if settings.require_manual_confirmation else "pass",
            detail="Manual confirmation is still configured, but Auto-Live now relies on explicit live arming, runtime health checks, and any manual lock or emergency stop that is still active."
            if settings.require_manual_confirmation
            else "Manual confirmation is not configured for Auto-Live.",
            value="Required" if settings.require_manual_confirmation else "Cleared",
            checked_at=checked_at,
        ),
        build_guardrail_check(
            check_id="emergency-stop",
            label="Emergency stop",
            status="fail" if settings.emergency_stop else "pass",
            detail="Emergency stop is active and blocks trading."
            if settings.emergency_stop
            else "Emergency stop is clear.",
            value="Active" if settings.emergency_stop else "Clear",
            blocking=settings.emergency_stop,
            checked_at=checked_at,
        ),
        build_guardrail_check(
            check_id="runtime-status",
            label="Runtime status",
            status="watch" if state.paused else "pass",
            detail="Auto-Live is paused."
            if state.paused
            else "Auto-Live can evaluate markets.",
            value="Paused" if state.paused else "Ready",
            blocking=state.paused,
            checked_at=checked_at,
        ),
    ]


def _skip_remaining_stages(
    candidate: CandidateEvaluation,
    *,
    from_stage: int,
    reason: str,
) -> None:
    for stage_number in range(from_stage, 8):
        candidate.stage_results.append(
            build_stage_result(
                stage_number=stage_number,
                status="skipped",
                reason=reason,
                hard_block=True,
            )
        )


def _record_rejected_candidate(
    rejected: dict[str, BullpenAutoLiveRejectedCandidateDiagnostic],
    *,
    market: ScannedMarket,
    reason: str,
) -> None:
    normalized_reason = reason.strip()
    if not normalized_reason:
        return
    entry = rejected.setdefault(
        market.market_id,
        BullpenAutoLiveRejectedCandidateDiagnostic(
            market_id=market.market_id,
            market_title=market.question,
            slug=market.slug,
            market_url=market.market_url,
            reasons=[],
        ),
    )
    if normalized_reason not in entry.reasons:
        entry.reasons.append(normalized_reason)


def _manual_console_market(
    row: BullpenAutoLiveConsoleCandidateInput,
) -> ScannedMarket:
    return ScannedMarket(
        market_id=row.market_id,
        question=row.market_title,
        market_url=row.market_url,
        slug=row.slug,
        close_time=row.close_time,
        theme=row.theme,
        current_yes_odds=row.current_yes_odds,
        current_no_odds=row.current_no_odds,
        volume_usd=row.volume_usd,
        liquidity_usd=row.liquidity_usd,
        description=row.event_description or row.rules,
        outcome_labels=["Yes", "No"],
        event_slug=None,
        best_bid_cents=row.best_bid_cents,
        best_ask_cents=row.best_ask_cents,
        spread_cents=row.spread_cents,
        force_include=False,
        raw={
            "question_id": row.question_id,
            "market_context": row.market_context,
            "resolution_source": row.resolution_source,
            "preflight_evidence_block": row.preflight_evidence_block,
        },
    )


def _manual_console_consensus(
    row: BullpenAutoLiveConsoleCandidateInput,
) -> LlmConsensus:
    fair_yes = row.llm_yes_odds
    fair_no = row.llm_no_odds
    if fair_yes is None and fair_no is not None:
        fair_yes = round(100 - fair_no, 2)
    if fair_no is None and fair_yes is not None:
        fair_no = round(100 - fair_yes, 2)
    return LlmConsensus(
        fair_yes_probability_pct=fair_yes,
        fair_no_probability_pct=fair_no,
        average_yes=fair_yes,
        median_yes=fair_yes,
        trimmed_mean_yes=fair_yes,
        iqr_yes=0,
        trimmed_range_yes=0,
        min_yes=fair_yes,
        max_yes=fair_yes,
        spread_yes=0,
        disagreement_level=row.llm_disagreement_level,
        disagreement_category=row.llm_disagreement_category,
        adjudication_required=row.adjudication_required,
        consensus_method="manual-console-selection",
        rationale_mismatch_count=0,
        confidence=normalize_auto_live_confidence(row.confidence),
        evidence_status=normalize_auto_live_evidence_status(row.evidence_status),
        event_state=row.event_state,
        provider_error_rate=0,
    )


def _serialize_scan_candidate(
    market: ScannedMarket,
) -> dict[str, object]:
    return {
        "market_id": market.market_id,
        "question": market.question,
        "market_title": market.question,
        "market_url": market.market_url,
        "slug": market.slug,
        "close_time": market.close_time,
        "theme": market.theme,
        "current_yes_odds": market.current_yes_odds,
        "current_no_odds": market.current_no_odds,
        "volume_usd": market.volume_usd,
        "liquidity_usd": market.liquidity_usd,
        "force_include": market.force_include,
    }


def _serialize_manual_console_candidate(
    row: BullpenAutoLiveConsoleCandidateInput,
    market: ScannedMarket,
) -> dict[str, object]:
    serialized = _serialize_scan_candidate(market)
    serialized.update(
        {
            "question_id": row.question_id,
            "selected": row.selected,
            "llm_yes_odds": row.llm_yes_odds,
            "llm_no_odds": row.llm_no_odds,
            "returns_per_day": row.returns_per_day,
            "amount_to_be_invested": row.amount_to_be_invested,
            "llm_disagreement_level": row.llm_disagreement_level,
            "llm_disagreement_category": row.llm_disagreement_category,
            "adjudication_required": row.adjudication_required,
            "confidence": row.confidence,
            "evidence_status": row.evidence_status,
            "event_state": row.event_state,
            "rules": row.rules,
        }
    )
    return serialized


def _serialize_rejected_scan_candidate(
    rejected: ScanRejectedMarket,
) -> dict[str, object]:
    return {
        "market_id": rejected.market_id,
        "question": rejected.question,
        "market_title": rejected.question,
        "market_url": rejected.market_url,
        "slug": rejected.slug,
        "reasons": list(rejected.reasons),
        "force_included_position": rejected.force_included_position,
    }


def _serialize_active_wallet_position(
    position: ConsoleWalletPosition,
) -> dict[str, object]:
    return {
        "position_key": f"{position.market_id}::{position.side}",
        "market_id": position.market_id,
        "question": position.market_title,
        "market_title": position.market_title,
        "market_url": position.market_url,
        "slug": position.slug,
        "theme": position.theme,
        "side": position.side,
        "shares": position.shares,
        "exposure_usd": position.exposure_usd,
        "average_price_cents": position.average_price_cents,
        "current_price_cents": position.current_price_cents,
        "current_yes_odds": position.current_yes_odds,
        "current_no_odds": position.current_no_odds,
        "close_time": position.close_time,
        "condition_id": position.condition_id,
        "is_claimable": position.is_claimable,
    }


def _active_position_market(
    position: ConsoleWalletPosition,
    *,
    market_by_slug: dict[str, ScannedMarket],
    market_by_id: dict[str, ScannedMarket],
) -> ScannedMarket:
    matched_market = market_by_slug.get(position.slug) or market_by_id.get(position.market_id)
    if matched_market is not None:
        return matched_market

    return ScannedMarket(
        market_id=position.market_id,
        question=position.market_title,
        market_url=position.market_url,
        slug=position.slug,
        close_time=position.close_time,
        theme=position.theme,
        current_yes_odds=position.current_yes_odds,
        current_no_odds=position.current_no_odds,
        volume_usd=None,
        liquidity_usd=None,
        description=None,
        outcome_labels=["Yes", "No"],
        event_slug=None,
        best_bid_cents=None,
        best_ask_cents=None,
        spread_cents=None,
        force_include=True,
        raw=None,
    )


async def _hydrate_missing_active_position_markets(
    positions: list[ConsoleWalletPosition],
    *,
    market_by_slug: dict[str, ScannedMarket],
    market_by_id: dict[str, ScannedMarket],
) -> tuple[dict[str, ScannedMarket], dict[str, ScannedMarket]]:
    missing_positions_by_slug: dict[str, ConsoleWalletPosition] = {}
    for position in positions:
        if not position.slug:
            continue
        if position.slug in market_by_slug or position.market_id in market_by_id:
            continue
        missing_positions_by_slug.setdefault(position.slug, position)

    if not missing_positions_by_slug:
        return market_by_slug, market_by_id

    async def fetch_position_market(
        slug: str,
    ) -> tuple[str, ScannedMarket | None]:
        try:
            return slug, await fetch_market_by_slug(slug)
        except Exception:
            logger.warning(
                "Failed to hydrate active Bullpen position market for slug %s.",
                slug,
                exc_info=True,
            )
            return slug, None

    fetched_markets = await asyncio.gather(
        *[
            fetch_position_market(slug)
            for slug in missing_positions_by_slug
        ]
    )
    next_market_by_slug = dict(market_by_slug)
    next_market_by_id = dict(market_by_id)

    for slug, market in fetched_markets:
        position = missing_positions_by_slug[slug]
        if market is None:
            continue
        next_market_by_slug.setdefault(slug, market)
        if market.slug:
            next_market_by_slug.setdefault(market.slug, market)
        next_market_by_id.setdefault(position.market_id, market)
        next_market_by_id.setdefault(market.market_id, market)

    return next_market_by_slug, next_market_by_id


def _serialize_llm_review_context(
    context: dict[str, object],
) -> dict[str, object]:
    market = context["market"]
    llm_consensus = context["llm_consensus"]
    rules = context.get("rules")
    llm_outputs = context.get("llm_outputs") or []

    if not isinstance(market, ScannedMarket):
        raise TypeError("Expected ScannedMarket in LLM review context.")

    payload: dict[str, object] = {
        "market_id": market.market_id,
        "question": market.question,
        "market_url": market.market_url,
        "slug": market.slug,
        "close_time": market.close_time,
        "returns_per_day": context.get("returns_per_day"),
        "qualified": bool(context.get("qualified")),
        "reason": str(context.get("reason") or ""),
        "selected_side": context.get("selected_side"),
        "fair_yes_probability_pct": (
            getattr(llm_consensus, "fair_yes_probability_pct", None)
            if llm_consensus
            else None
        ),
        "fair_no_probability_pct": (
            getattr(llm_consensus, "fair_no_probability_pct", None)
            if llm_consensus
            else None
        ),
        "disagreement_level": (
            getattr(llm_consensus, "disagreement_level", None)
            if llm_consensus
            else None
        ),
        "disagreement_category": (
            getattr(llm_consensus, "disagreement_category", None)
            if llm_consensus
            else None
        ),
        "adjudication_required": (
            getattr(llm_consensus, "adjudication_required", None)
            if llm_consensus
            else None
        ),
        "confidence": getattr(llm_consensus, "confidence", None) if llm_consensus else None,
        "evidence_status": (
            getattr(llm_consensus, "evidence_status", None) if llm_consensus else None
        ),
        "event_state": getattr(llm_consensus, "event_state", None) if llm_consensus else None,
        "yes_definition": getattr(rules, "yes_definition", None) if rules else None,
        "deadline_et": getattr(rules, "deadline_et", None) if rules else None,
        "hours_remaining": getattr(rules, "hours_remaining", None) if rules else None,
        "rules_fail_reason": getattr(rules, "fail_reason", None) if rules else None,
        "llm_outputs": [
            item.model_dump(mode="json")
            for item in llm_outputs
            if isinstance(item, BullpenAutoLiveLlmOutput)
        ],
        "source_kind": context.get("source_kind") or "candidate",
    }
    if context.get("position_key") is not None:
        payload["position_key"] = context["position_key"]
    if context.get("position_side") is not None:
        payload["position_side"] = context["position_side"]
    return payload


def _serialize_stage3_decision_row(
    decision: BullpenAutoLiveDecision,
) -> dict[str, object]:
    return {
        "id": decision.id,
        "run_id": decision.run_id,
        "created_at": decision.created_at,
        "updated_at": decision.updated_at,
        "market_id": decision.market_id,
        "market_title": decision.market_title,
        "market_url": decision.market_url,
        "slug": decision.slug,
        "close_time": decision.close_time,
        "theme": decision.theme,
        "side": decision.side,
        "decision": decision.decision,
        "risk_status": decision.risk_status,
        "price_cents": decision.price_cents,
        "current_yes_odds": decision.current_yes_odds,
        "current_no_odds": decision.current_no_odds,
        "fair_probability_pct": decision.fair_probability_pct,
        "fair_yes_probability_pct": decision.fair_yes_probability_pct,
        "fair_no_probability_pct": decision.fair_no_probability_pct,
        "edge_pp": decision.edge_pp,
        "score": decision.score,
        "confidence": decision.confidence,
        "evidence_status": decision.evidence_status,
        "event_state": decision.event_state,
        "adjudication_required": decision.adjudication_required,
        "disagreement_level": decision.disagreement_level,
        "current_exposure_usd": decision.current_exposure_usd,
        "target_exposure_usd": decision.target_exposure_usd,
        "realized_pnl_usd": decision.realized_pnl_usd,
        "hours_remaining": decision.hours_remaining,
        "key_evidence": list(decision.key_evidence),
        "red_flags": list(decision.red_flags),
        "rationale": decision.rationale,
        "reason": decision.reason,
        "summary": decision.summary,
        "order_plan": (
            decision.order_plan.model_dump(mode="json") if decision.order_plan else None
        ),
        "exit_signals": [
            signal.model_dump(mode="json")
            for signal in decision.exit_signals
        ],
        "exit_state": decision.exit_state,
        "llm_outputs": [],
        "stage_results": [],
        "guardrail_checks": [],
    }


def _trade_analysis_llm_payloads(
    outputs: list[BullpenAutoLiveLlmOutput],
) -> list[dict[str, object]]:
    return [item.model_dump(mode="json") for item in outputs]


def _trade_analysis_event_snapshot(market: ScannedMarket) -> dict[str, object]:
    raw = market.raw if isinstance(market.raw, dict) else {}
    return sanitize_json_value(
        {
            "market_id": market.market_id,
            "question": market.question,
            "slug": market.slug,
            "market_url": market.market_url,
            "theme": market.theme,
            "close_time": market.close_time,
            "event_slug": market.event_slug,
            "description": market.description,
            "market_context": raw.get("market_context"),
            "resolution_source": raw.get("resolution_source"),
            "preflight_evidence_block": raw.get("preflight_evidence_block"),
            "raw": raw,
        }
    )


def _trade_analysis_market_snapshot(market: ScannedMarket) -> dict[str, object]:
    return sanitize_json_value(
        {
            "market_id": market.market_id,
            "question": market.question,
            "current_yes_odds": market.current_yes_odds,
            "current_no_odds": market.current_no_odds,
            "volume_usd": market.volume_usd,
            "liquidity_usd": market.liquidity_usd,
            "description": market.description,
            "outcome_labels": market.outcome_labels,
            "raw": market.raw or {},
        }
    )


def _trade_analysis_order_book_snapshot(market: ScannedMarket) -> dict[str, object]:
    return sanitize_json_value(
        {
            "best_bid_cents": market.best_bid_cents,
            "best_ask_cents": market.best_ask_cents,
            "spread_cents": market.spread_cents,
        }
    )


def _trade_analysis_event_snapshot_from_decision(
    decision: BullpenAutoLiveDecision,
    refreshed_market: ScannedMarket | None,
) -> dict[str, object]:
    if refreshed_market is not None:
        return _trade_analysis_event_snapshot(refreshed_market)
    return sanitize_json_value(
        {
            "market_id": decision.market_id,
            "question": decision.market_title,
            "slug": decision.slug,
            "market_url": decision.market_url,
            "theme": decision.theme,
            "close_time": decision.close_time,
            "event_slug": decision.slug,
            "description": None,
            "raw": {},
        }
    )


def _trade_analysis_market_snapshot_from_decision(
    decision: BullpenAutoLiveDecision,
    refreshed_market: ScannedMarket | None,
) -> dict[str, object]:
    if refreshed_market is not None:
        return _trade_analysis_market_snapshot(refreshed_market)
    return sanitize_json_value(
        {
            "market_id": decision.market_id,
            "question": decision.market_title,
            "current_yes_odds": decision.current_yes_odds,
            "current_no_odds": decision.current_no_odds,
            "volume_usd": None,
            "liquidity_usd": None,
            "description": None,
            "outcome_labels": ["Yes", "No"],
            "raw": {},
        }
    )


def _trade_analysis_order_book_snapshot_from_decision(
    decision: BullpenAutoLiveDecision,
    refreshed_market: ScannedMarket | None,
    *,
    quote_price_cents: float | None,
    limit_price_cents: float | None,
) -> dict[str, object]:
    if refreshed_market is not None:
        snapshot = dict(_trade_analysis_order_book_snapshot(refreshed_market))
    else:
        snapshot = {}
    snapshot.setdefault("current_price_cents", quote_price_cents)
    snapshot.setdefault("limit_price_cents", limit_price_cents)
    return sanitize_json_value(snapshot)


def _trade_analysis_exit_type_from_signals(
    signals: list[ExitSignal],
) -> str:
    for signal in signals:
        if signal.reasonCode == "EVENT_CLOSE_PASSED":
            return "EXPIRY"
        if signal.strategy == "CAPITAL_AWARE_FORCED_EXIT":
            return "FORCED_EXIT"
    return "SELL"


def _trade_analysis_position_snapshot(
    position: PositionSnapshot | None,
) -> dict[str, object]:
    if position is None:
        return {}
    return sanitize_json_value(
        {
            "market_id": position.market_id,
            "side": position.side,
            "shares": position.shares,
            "exposure_usd": position.exposure_usd,
            "average_price_cents": position.average_price_cents,
            "current_price_cents": position.current_price_cents,
            "close_time": position.close_time,
            "exit_state": position.exit_state,
            "estimated_freeable_value_usd": position.estimated_freeable_value_usd,
            "price_history": [
                snapshot.model_dump(mode="json") for snapshot in position.price_history
            ],
        }
    )


def _trade_analysis_buy_context_from_candidate(
    *,
    run_id: str,
    settings: BullpenAutoLiveSettings,
    candidate: CandidateEvaluation,
    order_plan: BullpenAutoLiveOrderPlan,
) -> dict[str, object]:
    market = candidate.market
    market_probability = (
        market.current_yes_odds if order_plan.side == "YES" else market.current_no_odds
    )
    fair_probability = (
        candidate.llm_consensus.fair_yes_probability_pct
        if candidate.llm_consensus and order_plan.side == "YES"
        else candidate.llm_consensus.fair_no_probability_pct
        if candidate.llm_consensus
        else None
    )
    return {
        "source_variant": "auto-live-console-profile",
        "bot_name": "Bullpen x AI",
        "strategy_name": "Bullpen Console Top 10",
        "strategy_version": settings.strategy_profile,
        "run_id": run_id,
        "event_id": market.market_id,
        "event_slug": market.slug,
        "market_id": market.market_id,
        "outcome_name": order_plan.side,
        "title": market.question,
        "event_question": market.question,
        "event_description": market.description,
        "category": market.theme,
        "topic": market.theme,
        "source_url": market.market_url,
        "market_url": market.market_url,
        "event_close_time": market.close_time,
        "requested_amount": order_plan.order_size_usd,
        "requested_price": cents_to_decimal(order_plan.limit_price_cents),
        "requested_shares": order_plan.shares,
        "buy_probability_estimate": fair_probability,
        "market_probability": market_probability,
        "confidence": candidate.confidence,
        "risk_score": candidate.evidence_status,
        "expected_edge": candidate.edge_pp,
        "expected_value": (
            round(((fair_probability or 0) - (market_probability or 0)) * order_plan.order_size_usd / 100, 6)
            if fair_probability is not None and market_probability is not None
            else None
        ),
        "liquidity_score": bounded_score(market.liquidity_usd, lower=250, upper=25_000),
        "volume_score": bounded_score(market.volume_usd, lower=250, upper=100_000),
        "spread_score": bounded_score(market.spread_cents, lower=1, upper=15, inverse=True),
        "volatility_score": bounded_score(
            candidate.llm_consensus.spread_yes if candidate.llm_consensus else None,
            lower=0,
            upper=25,
        ),
        "evidence_status": candidate.evidence_status,
        "event_state": candidate.event_state,
        "decision_summary": candidate.reason,
        "buy_reason": candidate.reason,
        "selected_by_rule": candidate.rules is not None and not candidate.rules.ambiguous,
        "selected_by_llm": bool(candidate.llm_outputs),
        "selected_by_hybrid": bool(candidate.llm_outputs),
        "llm_payloads": _trade_analysis_llm_payloads(candidate.llm_outputs),
        "bullpen_snapshot_json": {"run_id": run_id, "decision_action": candidate.decision_action},
        "event_snapshot_json": _trade_analysis_event_snapshot(market),
        "market_snapshot_json": _trade_analysis_market_snapshot(market),
        "order_book_snapshot_json": _trade_analysis_order_book_snapshot(market),
        "positions_snapshot_json": _trade_analysis_position_snapshot(candidate.current_position),
        "raw_api_response_json": {},
        "log_metadata": {
            "decision_action": candidate.decision_action,
            "order_plan_id": order_plan.id,
            "edge_pp": candidate.edge_pp,
            "score": candidate.score,
        },
    }


def _trade_analysis_buy_context_from_decision(
    *,
    run_id: str,
    settings: BullpenAutoLiveSettings,
    decision: BullpenAutoLiveDecision,
    order_plan: BullpenAutoLiveOrderPlan,
    market_snapshot: dict[str, object],
    event_snapshot: dict[str, object],
    order_book_snapshot: dict[str, object],
    positions_snapshot: dict[str, object],
) -> dict[str, object]:
    market_probability = (
        decision.current_yes_odds if order_plan.side == "YES" else decision.current_no_odds
    )
    fair_probability = (
        decision.fair_yes_probability_pct
        if order_plan.side == "YES"
        else decision.fair_no_probability_pct
    )
    return {
        "source_variant": "auto-live-stage3",
        "bot_name": "Bullpen x AI",
        "strategy_name": "Bullpen x AI Auto-Live",
        "strategy_version": settings.strategy_profile,
        "run_id": run_id,
        "event_id": decision.market_id,
        "event_slug": decision.slug,
        "market_id": decision.market_id,
        "outcome_name": order_plan.side,
        "title": decision.market_title,
        "event_question": decision.market_title,
        "event_description": None,
        "category": decision.theme,
        "topic": decision.theme,
        "source_url": decision.market_url,
        "market_url": decision.market_url,
        "event_close_time": decision.close_time,
        "requested_amount": order_plan.order_size_usd,
        "requested_price": cents_to_decimal(order_plan.limit_price_cents),
        "requested_shares": order_plan.shares,
        "buy_probability_estimate": fair_probability,
        "market_probability": market_probability,
        "confidence": decision.confidence,
        "risk_score": decision.risk_status,
        "expected_edge": decision.edge_pp,
        "expected_value": (
            round(((fair_probability or 0) - (market_probability or 0)) * order_plan.order_size_usd / 100, 6)
            if fair_probability is not None and market_probability is not None
            else None
        ),
        "liquidity_score": bounded_score(
            parse_float(market_snapshot.get("liquidity_usd")),
            lower=250,
            upper=25_000,
        ),
        "volume_score": bounded_score(
            parse_float(market_snapshot.get("volume_usd")),
            lower=250,
            upper=100_000,
        ),
        "spread_score": bounded_score(
            parse_float(order_book_snapshot.get("spread_cents")),
            lower=1,
            upper=15,
            inverse=True,
        ),
        "volatility_score": bounded_score(
            15 if decision.disagreement_level else None,
            lower=0,
            upper=25,
        ),
        "evidence_status": decision.evidence_status,
        "event_state": decision.event_state,
        "decision_summary": decision.reason,
        "buy_reason": decision.reason,
        "selected_by_rule": True,
        "selected_by_llm": bool(decision.llm_outputs),
        "selected_by_hybrid": bool(decision.llm_outputs),
        "llm_payloads": _trade_analysis_llm_payloads(decision.llm_outputs),
        "bullpen_snapshot_json": {"run_id": run_id, "decision_id": decision.id},
        "event_snapshot_json": event_snapshot,
        "market_snapshot_json": market_snapshot,
        "order_book_snapshot_json": order_book_snapshot,
        "positions_snapshot_json": positions_snapshot,
        "raw_api_response_json": {},
        "log_metadata": {
            "decision_id": decision.id,
            "decision": decision.decision,
            "order_plan_id": order_plan.id,
        },
    }


def _trade_analysis_exit_context_from_candidate(
    *,
    run_id: str,
    candidate: CandidateEvaluation,
    order_plan: BullpenAutoLiveOrderPlan,
    market_snapshot: dict[str, object],
    event_snapshot: dict[str, object],
    order_book_snapshot: dict[str, object],
    positions_snapshot: dict[str, object],
) -> dict[str, object]:
    market_probability = (
        candidate.market.current_yes_odds
        if order_plan.side == "YES"
        else candidate.market.current_no_odds
    )
    fair_probability = (
        candidate.llm_consensus.fair_yes_probability_pct
        if candidate.llm_consensus and order_plan.side == "YES"
        else candidate.llm_consensus.fair_no_probability_pct
        if candidate.llm_consensus
        else None
    )
    return {
        "run_id": run_id,
        "market_id": candidate.market.market_id,
        "outcome_name": order_plan.side,
        "title": candidate.market.question,
        "event_question": candidate.market.question,
        "requested_amount": order_plan.order_size_usd,
        "requested_shares": order_plan.shares,
        "requested_price": cents_to_decimal(order_plan.limit_price_cents),
        "probability_estimate": fair_probability,
        "market_probability": market_probability,
        "confidence": candidate.confidence,
        "risk_score": candidate.evidence_status,
        "expected_edge": candidate.edge_pp,
        "expected_value": (
            round(((fair_probability or 0) - (market_probability or 0)) * order_plan.order_size_usd / 100, 6)
            if fair_probability is not None and market_probability is not None
            else None
        ),
        "liquidity_score": bounded_score(
            parse_float(market_snapshot.get("liquidity_usd")),
            lower=250,
            upper=25_000,
        ),
        "volume_score": bounded_score(
            parse_float(market_snapshot.get("volume_usd")),
            lower=250,
            upper=100_000,
        ),
        "spread_score": bounded_score(
            parse_float(order_book_snapshot.get("spread_cents")),
            lower=1,
            upper=15,
            inverse=True,
        ),
        "volatility_score": bounded_score(
            candidate.llm_consensus.spread_yes if candidate.llm_consensus else None,
            lower=0,
            upper=25,
        ),
        "decision_summary": candidate.reason,
        "sell_reason": candidate.reason,
        "evidence_status": candidate.evidence_status,
        "event_state": candidate.event_state,
        "llm_payloads": _trade_analysis_llm_payloads(candidate.llm_outputs),
        "bullpen_snapshot_json": {"run_id": run_id, "decision_action": candidate.decision_action},
        "event_snapshot_json": event_snapshot,
        "market_snapshot_json": market_snapshot,
        "order_book_snapshot_json": order_book_snapshot,
        "positions_snapshot_json": positions_snapshot,
        "raw_api_response_json": {},
        "log_metadata": {
            "decision_action": candidate.decision_action,
            "order_plan_id": order_plan.id,
            "edge_pp": candidate.edge_pp,
            "score": candidate.score,
        },
    }


def _trade_analysis_exit_context_from_decision(
    *,
    decision: BullpenAutoLiveDecision,
    order_plan: BullpenAutoLiveOrderPlan,
    market_snapshot: dict[str, object],
    event_snapshot: dict[str, object],
    order_book_snapshot: dict[str, object],
    positions_snapshot: dict[str, object],
) -> dict[str, object]:
    market_probability = (
        decision.current_yes_odds if order_plan.side == "YES" else decision.current_no_odds
    )
    fair_probability = (
        decision.fair_yes_probability_pct
        if order_plan.side == "YES"
        else decision.fair_no_probability_pct
    )
    return {
        "market_id": decision.market_id,
        "outcome_name": order_plan.side,
        "title": decision.market_title,
        "event_question": decision.market_title,
        "requested_amount": order_plan.order_size_usd,
        "requested_shares": order_plan.shares,
        "requested_price": cents_to_decimal(order_plan.limit_price_cents),
        "probability_estimate": fair_probability,
        "market_probability": market_probability,
        "confidence": decision.confidence,
        "risk_score": decision.risk_status,
        "expected_edge": decision.edge_pp,
        "expected_value": (
            round(((fair_probability or 0) - (market_probability or 0)) * order_plan.order_size_usd / 100, 6)
            if fair_probability is not None and market_probability is not None
            else None
        ),
        "liquidity_score": bounded_score(
            parse_float(market_snapshot.get("liquidity_usd")),
            lower=250,
            upper=25_000,
        ),
        "volume_score": bounded_score(
            parse_float(market_snapshot.get("volume_usd")),
            lower=250,
            upper=100_000,
        ),
        "spread_score": bounded_score(
            parse_float(order_book_snapshot.get("spread_cents")),
            lower=1,
            upper=15,
            inverse=True,
        ),
        "volatility_score": bounded_score(
            15 if decision.disagreement_level else None,
            lower=0,
            upper=25,
        ),
        "decision_summary": decision.reason,
        "sell_reason": decision.reason,
        "evidence_status": decision.evidence_status,
        "event_state": decision.event_state,
        "llm_payloads": _trade_analysis_llm_payloads(decision.llm_outputs),
        "bullpen_snapshot_json": {"run_id": decision.run_id, "decision_id": decision.id},
        "event_snapshot_json": event_snapshot,
        "market_snapshot_json": market_snapshot,
        "order_book_snapshot_json": order_book_snapshot,
        "positions_snapshot_json": positions_snapshot,
        "raw_api_response_json": {},
        "log_metadata": {
            "decision_id": decision.id,
            "decision": decision.decision,
            "order_plan_id": order_plan.id,
            "exit_state": decision.exit_state,
            "exit_signals": [
                signal.model_dump(mode="json") for signal in decision.exit_signals
            ],
        },
    }


def _safe_trade_analysis_capture(
    action: str,
    capture_fn: Callable[..., None],
    **kwargs,
) -> None:
    try:
        capture_fn(**kwargs)
    except Exception:
        logger.warning(
            "Bullpen trade-analysis capture failed during %s.",
            action,
            exc_info=True,
        )


class BullpenAutoLiveEngine:
    @staticmethod
    def _report_progress(
        progress_callback: ProgressCallback | None,
        run: BullpenAutoLiveRun,
        state: BullpenAutoLiveState,
    ) -> None:
        if progress_callback is not None:
            progress_callback(run, state)

    async def execute(
        self,
        *,
        user_id: int,
        settings: BullpenAutoLiveSettings,
        state: BullpenAutoLiveState,
        run: BullpenAutoLiveRun,
        positions: list[PositionSnapshot],
        historical_decisions: list[BullpenAutoLiveDecision],
        progress_callback: ProgressCallback | None = None,
    ) -> EngineResult:
        now = utc_now()
        state.dry_run = effective_dry_run(settings)
        state.live_armed = live_execution_armed(settings)
        state.live_execution_allowed = False
        state.emergency_stopped = settings.emergency_stop
        run.dry_run = state.dry_run
        state.last_execution_at = _latest_execution_at(historical_decisions)
        (
            state.today_executed_orders,
            state.today_skipped_orders,
        ) = _today_order_counts(historical_decisions, now=now)
        state.trades_today = state.today_executed_orders
        state.consecutive_failed_orders = _count_consecutive_failed_orders(historical_decisions)
        global_guardrails = _run_guardrails(settings, state)
        state.latest_guardrail_checks = global_guardrails
        if settings.strategy_profile == CONSOLE_PROFILE_ID:
            return await self._execute_console_top10(
                user_id=user_id,
                settings=settings,
                state=state,
                run=run,
                positions=positions,
                historical_decisions=historical_decisions,
                global_guardrails=global_guardrails,
                now=now,
                progress_callback=progress_callback,
            )
        daily_loss_stop_hit, weekly_loss_stop_hit = _daily_weekly_loss_stops(
            historical_decisions,
            settings.bankroll_usd,
            settings,
            now=now,
        )

        scan = await scan_candidate_markets(
            min_liquidity_usd=settings.min_liquidity_usd,
            existing_position_slugs={position.slug for position in positions if position.slug},
        )
        sorted_candidates = sorted(
            scan.accepted,
            key=lambda market: (
                0 if market.force_include else 1,
                -(market.liquidity_usd or 0),
                -(market.volume_usd or 0),
                market.question,
            ),
        )
        set_run_stage_result(
            run,
            build_stage_result(
                stage_number=1,
                status="pass" if sorted_candidates else "warning",
                reason="Candidate scan completed."
                if sorted_candidates
                else "Candidate scan completed but no markets passed the initial filters.",
                inputs={
                    "min_liquidity_usd": settings.min_liquidity_usd,
                    "existing_position_slugs": [position.slug for position in positions if position.slug],
                },
                outputs={
                    "source_label": scan.source_label,
                    "source_url": scan.source_url,
                    "accepted_candidates": [
                        {
                            "question": market.question,
                            "market_url": market.market_url,
                            "slug": market.slug,
                            "close_time": market.close_time,
                            "theme": market.theme,
                            "current_yes_odds": market.current_yes_odds,
                            "current_no_odds": market.current_no_odds,
                            "volume_usd": market.volume_usd,
                            "liquidity_usd": market.liquidity_usd,
                            "force_include": market.force_include,
                        }
                        for market in sorted_candidates
                    ],
                    "rejected_candidates": [
                        {
                            "question": rejected.question,
                            "market_url": rejected.market_url,
                            "slug": rejected.slug,
                            "reasons": rejected.reasons,
                        }
                        for rejected in scan.rejected
                    ],
                },
                guardrails_checked=global_guardrails,
            ),
        )
        self._report_progress(progress_callback, run, state)

        evaluated: list[CandidateEvaluation] = []
        for market in sorted_candidates:
            current_position = None
            market_positions = _position_by_market(positions, market.market_id)
            if market_positions:
                current_position = market_positions[0]
            candidate = CandidateEvaluation(
                market=market,
                current_position=current_position,
                current_exposure_usd=current_position.exposure_usd if current_position else 0,
            )
            candidate.stage_results.append(
                build_stage_result(
                    stage_number=1,
                    status="warning" if market.force_include else "pass",
                    reason="Market was included because an active position already exists."
                    if market.force_include
                    else "Market passed the initial scan filters.",
                    outputs={
                        "question": market.question,
                        "market_url": market.market_url,
                        "slug": market.slug,
                        "close_time": market.close_time,
                        "theme": market.theme,
                        "current_yes_odds": market.current_yes_odds,
                        "current_no_odds": market.current_no_odds,
                        "volume_usd": market.volume_usd,
                        "liquidity_usd": market.liquidity_usd,
                    },
                )
            )

            rules = evaluate_market_rules(market, now=now)
            candidate.rules = rules
            stage2_fail = rules.fail_reason is not None
            candidate.stage_results.append(
                build_stage_result(
                    stage_number=2,
                    status="fail" if stage2_fail else "pass",
                    reason=rules.fail_reason or "Market rules and deadline are clear.",
                    inputs={"market_url": market.market_url},
                    outputs={
                        "yes_definition": rules.yes_definition,
                        "deadline_et": rules.deadline_et,
                        "hours_remaining": rules.hours_remaining,
                        "resolution_criteria": rules.resolution_criteria,
                    },
                    hard_block=stage2_fail,
                )
            )
            if stage2_fail:
                candidate.reason = rules.fail_reason or "Market rules failed."
                candidate.hard_block_reasons.append(candidate.reason)
                _skip_remaining_stages(candidate, from_stage=3, reason=candidate.reason)
                evaluated.append(candidate)
                continue

            evidence_packet = build_evidence_packet(
                market,
                rules,
                built_at=utc_now_iso(),
            )
            candidate.evidence_packet = evidence_packet
            llm_outputs, llm_consensus = run_llm_consensus(market, rules, evidence_packet)
            candidate.llm_outputs = llm_outputs
            candidate.llm_consensus = llm_consensus
            candidate.confidence = normalize_auto_live_confidence(
                llm_consensus.confidence,
            )
            candidate.evidence_status = normalize_auto_live_evidence_status(
                llm_consensus.evidence_status,
            )
            candidate.event_state = llm_consensus.event_state
            candidate.disagreement_level = llm_consensus.disagreement_level
            candidate.disagreement_category = llm_consensus.disagreement_category
            stage3_fail = llm_consensus.fair_yes_probability_pct is None
            stage3_warning = (
                llm_consensus.provider_error_rate > 0
                or llm_consensus.disagreement_level in {"Medium", "High"}
            )
            candidate.stage_results.append(
                build_stage_result(
                    stage_number=3,
                    status="fail" if stage3_fail else "warning" if stage3_warning else "pass",
                    reason="No usable LLM probabilities were returned."
                    if stage3_fail
                    else "LLM consensus completed with disagreement or provider warnings."
                    if stage3_warning
                    else "LLM consensus completed.",
                    inputs={
                        "queries": evidence_packet.queries,
                        "warning_count": len(evidence_packet.warnings),
                    },
                    outputs={
                        "evidence_packet": {
                            "built_at": evidence_packet.built_at,
                            "results": [
                                {
                                    "title": item.title,
                                    "url": item.url,
                                    "content": item.content,
                                    "published_date": item.published_date,
                                }
                                for item in evidence_packet.results
                            ],
                            "warnings": evidence_packet.warnings,
                        },
                        "llm_outputs": [item.model_dump(mode="json") for item in llm_outputs],
                        "average_yes": llm_consensus.average_yes,
                        "median_yes": llm_consensus.median_yes,
                        "trimmed_mean_yes": llm_consensus.trimmed_mean_yes,
                        "iqr_yes": llm_consensus.iqr_yes,
                        "trimmed_range_yes": llm_consensus.trimmed_range_yes,
                        "min_yes": llm_consensus.min_yes,
                        "max_yes": llm_consensus.max_yes,
                        "spread_yes": llm_consensus.spread_yes,
                        "disagreement_level": llm_consensus.disagreement_level,
                        "disagreement_category": llm_consensus.disagreement_category,
                        "adjudication_required": llm_consensus.adjudication_required,
                        "consensus_method": llm_consensus.consensus_method,
                        "rationale_mismatch_count": llm_consensus.rationale_mismatch_count,
                    },
                    hard_block=stage3_fail,
                )
            )
            if stage3_fail:
                candidate.reason = "All LLM outputs failed or were unparsable."
                candidate.hard_block_reasons.append(candidate.reason)
                _skip_remaining_stages(candidate, from_stage=4, reason=candidate.reason)
                evaluated.append(candidate)
                continue

            fair_yes = llm_consensus.fair_yes_probability_pct or 0
            fair_no = llm_consensus.fair_no_probability_pct or max(0, 100 - fair_yes)
            yes_price = market.current_yes_odds
            no_price = market.current_no_odds
            yes_edge = fair_yes - yes_price if yes_price is not None else float("-inf")
            no_edge = fair_no - no_price if no_price is not None else float("-inf")
            candidate.side_to_trade = "YES" if yes_edge >= no_edge else "NO"
            candidate.market_price_percent = yes_price if candidate.side_to_trade == "YES" else no_price
            candidate.fair_probability_percent = fair_yes if candidate.side_to_trade == "YES" else fair_no
            candidate.edge_pp = round(
                max(yes_edge, no_edge) if max(yes_edge, no_edge) != float("-inf") else 0,
                2,
            )
            evidence_weight = EVIDENCE_WEIGHT.get(candidate.evidence_status, 0.55)
            confidence_weight = CONFIDENCE_WEIGHT.get(candidate.confidence, 0.55)
            liquidity_weight = _liquidity_weight(market.liquidity_usd, settings.min_liquidity_usd)
            disagreement_weight = _disagreement_weight(llm_consensus, settings)
            candidate.score = round(
                candidate.edge_pp
                * evidence_weight
                * confidence_weight
                * liquidity_weight
                * disagreement_weight,
                2,
            )

            stage4_blockers: list[str] = []
            if candidate.market_price_percent is None:
                stage4_blockers.append("Current market price is unavailable.")
            if candidate.edge_pp < settings.min_edge_pp:
                stage4_blockers.append(
                    f"Edge {candidate.edge_pp:.2f} is below the minimum {settings.min_edge_pp:.2f}."
                )
            if candidate.score < settings.min_score:
                stage4_blockers.append(
                    f"Score {candidate.score:.2f} is below the minimum {settings.min_score:.2f}."
                )
            if _evidence_below_minimum(candidate.evidence_status, settings):
                stage4_blockers.append("Evidence is below the configured minimum.")
            if _confidence_below_minimum(candidate.confidence, settings):
                stage4_blockers.append("Confidence is below the configured minimum.")
            if candidate.event_state == "conflicting":
                stage4_blockers.append("Evidence is conflicting, so trading is blocked.")
            if llm_consensus.disagreement_level == "High":
                stage4_blockers.append("LLM disagreement is above the configured maximum.")
            if (
                market.liquidity_usd is not None
                and market.liquidity_usd < settings.min_liquidity_usd
            ):
                stage4_blockers.append("Liquidity is below the configured minimum.")
            if (
                llm_consensus.adjudication_required
                and settings.adjudication_required_blocks_trade
            ):
                stage4_blockers.append("LLM adjudication is required, so trading is blocked.")

            candidate.stage_results.append(
                build_stage_result(
                    stage_number=4,
                    status="fail" if stage4_blockers else "pass",
                    reason="; ".join(stage4_blockers) if stage4_blockers else "Market scored above the entry thresholds.",
                    outputs={
                        "side_to_trade": candidate.side_to_trade,
                        "market_price_percent": candidate.market_price_percent,
                        "fair_probability_percent": candidate.fair_probability_percent,
                        "edge_pp": candidate.edge_pp,
                        "evidence_weight": evidence_weight,
                        "confidence_weight": confidence_weight,
                        "liquidity_weight": liquidity_weight,
                        "disagreement_weight": disagreement_weight,
                        "score": candidate.score,
                    },
                    hard_block=bool(stage4_blockers),
                )
            )
            if stage4_blockers:
                candidate.hard_block_reasons.extend(stage4_blockers)

            current_market_exposure = round(
                sum(position.exposure_usd for position in _position_by_market(positions, market.market_id)),
                2,
            )
            current_theme_exposure = _theme_exposure(positions, market.theme)
            current_open_exposure = _open_exposure(positions)
            available_cash = max(
                0.0,
                settings.bankroll_usd
                - current_open_exposure
                - settings.bankroll_usd * (settings.min_cash_reserve_pct_bankroll / 100),
            )
            p = (candidate.fair_probability_percent or 0) / 100
            price_decimal = (candidate.market_price_percent or 0) / 100
            full_kelly = max(0.0, (p - price_decimal) / max(0.0001, 1 - price_decimal))
            safe_kelly = settings.kelly_fraction * full_kelly
            remaining_single_market_capacity = max(
                0.0,
                (settings.max_single_market_pct_bankroll / 100)
                - (current_market_exposure / settings.bankroll_usd),
            )
            remaining_theme_capacity = max(
                0.0,
                (settings.max_theme_exposure_pct_bankroll / 100)
                - (current_theme_exposure / settings.bankroll_usd),
            )
            remaining_open_exposure_capacity = max(
                0.0,
                (settings.max_open_exposure_pct_bankroll / 100)
                - (current_open_exposure / settings.bankroll_usd),
            )
            remaining_cash_reserve_capacity = max(
                0.0,
                available_cash / settings.bankroll_usd,
            )
            target_pct = min(
                safe_kelly,
                settings.max_single_trade_pct_bankroll / 100,
                remaining_single_market_capacity,
                remaining_theme_capacity,
                remaining_open_exposure_capacity,
                remaining_cash_reserve_capacity,
            )
            if (
                rules.hours_remaining is not None
                and rules.hours_remaining <= settings.no_new_trade_under_hours_to_deadline
                and candidate.current_position is None
            ):
                candidate.hard_block_reasons.append("New trade is too close to the deadline.")
            elif (
                rules.hours_remaining is not None
                and rules.hours_remaining <= settings.half_size_under_hours_to_deadline
            ):
                target_pct *= 0.5

            candidate.target_exposure_usd = round(settings.bankroll_usd * max(target_pct, 0.0), 2)
            same_side_position = (
                _same_side_position(positions, market.market_id, candidate.side_to_trade or "YES")
                if candidate.side_to_trade
                else None
            )
            if same_side_position is None:
                candidate.order_usd = min(
                    settings.max_order_usd,
                    round(candidate.target_exposure_usd * (settings.initial_tranche_pct / 100), 2),
                )
            else:
                candidate.order_usd = min(
                    settings.max_order_usd,
                    round(max(0.0, candidate.target_exposure_usd - same_side_position.exposure_usd), 2),
                )

            stage5_blockers: list[str] = []
            if candidate.order_usd and candidate.order_usd < settings.min_order_usd:
                stage5_blockers.append("Order size is below the minimum order USD.")
            if candidate.target_exposure_usd <= 0:
                stage5_blockers.append("Target exposure is zero after Kelly and capacity caps.")
            candidate.stage_results.append(
                build_stage_result(
                    stage_number=5,
                    status="fail" if stage5_blockers else "pass",
                    reason="; ".join(stage5_blockers) if stage5_blockers else "Position sizing completed.",
                    outputs={
                        "p": round(p, 4),
                        "price": round(price_decimal, 4),
                        "full_kelly": round(full_kelly, 4),
                        "safe_kelly": round(safe_kelly, 4),
                        "target_pct": round(target_pct, 4),
                        "target_usd": candidate.target_exposure_usd,
                        "order_usd": candidate.order_usd,
                        "current_exposure_usd": candidate.current_exposure_usd,
                        "remaining_single_market_capacity": round(remaining_single_market_capacity, 4),
                        "remaining_theme_capacity": round(remaining_theme_capacity, 4),
                        "remaining_open_exposure_capacity": round(remaining_open_exposure_capacity, 4),
                        "remaining_cash_reserve_capacity": round(remaining_cash_reserve_capacity, 4),
                    },
                    hard_block=bool(stage5_blockers),
                )
            )
            if stage5_blockers:
                candidate.hard_block_reasons.extend(stage5_blockers)

            opposite_positions = [
                position
                for position in _position_by_market(positions, market.market_id)
                if position.side != candidate.side_to_trade
            ]
            same_side_position = (
                _same_side_position(positions, market.market_id, candidate.side_to_trade or "YES")
                if candidate.side_to_trade
                else None
            )
            active_market_count = _active_market_count(positions)
            action_reason = ""
            if settings.emergency_stop:
                candidate.decision_action = "SKIP"
                action_reason = "Emergency stop is active."
            elif opposite_positions:
                candidate.decision_action = "EXIT"
                candidate.current_position = opposite_positions[0]
                candidate.current_exposure_usd = opposite_positions[0].exposure_usd
                candidate.target_exposure_usd = 0
                candidate.order_usd = opposite_positions[0].exposure_usd
                candidate.order_shares = opposite_positions[0].shares
                action_reason = "Existing position is on the opposite side, so the engine exits it."
            elif same_side_position is None:
                if candidate.hard_block_reasons:
                    candidate.decision_action = "SKIP"
                    action_reason = "; ".join(candidate.hard_block_reasons)
                elif active_market_count >= settings.max_active_markets:
                    candidate.decision_action = "SKIP"
                    action_reason = "Maximum active market count reached."
                elif candidate.order_usd < settings.min_order_usd:
                    candidate.decision_action = "SKIP"
                    action_reason = "Initial tranche is below the minimum order size."
                else:
                    candidate.decision_action = "BUY_NEW"
                    candidate.execution_edge_threshold_pp = settings.min_edge_pp
                    action_reason = "No current position exists and all entry guardrails passed."
            else:
                candidate.current_position = same_side_position
                candidate.current_exposure_usd = same_side_position.exposure_usd
                target_delta = candidate.target_exposure_usd - same_side_position.exposure_usd
                add_threshold_value = same_side_position.exposure_usd * (
                    settings.add_more_threshold_pct / 100
                )
                exit_conditions = []
                if candidate.edge_pp <= settings.exit_edge_pp:
                    exit_conditions.append("Edge is at or below the exit threshold.")
                if (
                    candidate.llm_consensus
                    and candidate.llm_consensus.disagreement_level == "High"
                ):
                    exit_conditions.append("LLM disagreement rose above the configured maximum.")
                if candidate.evidence_status == "Low":
                    exit_conditions.append("Evidence fell to Low.")
                if daily_loss_stop_hit:
                    exit_conditions.append("Daily loss stop is hit.")
                if weekly_loss_stop_hit:
                    exit_conditions.append("Weekly loss stop is hit.")
                if exit_conditions:
                    candidate.decision_action = "EXIT"
                    candidate.target_exposure_usd = 0
                    candidate.order_usd = same_side_position.exposure_usd
                    candidate.order_shares = same_side_position.shares
                    if exit_conditions == ["Edge is at or below the exit threshold."]:
                        candidate.execution_edge_threshold_pp = settings.exit_edge_pp
                    action_reason = "; ".join(exit_conditions)
                elif target_delta > max(add_threshold_value, settings.min_order_usd):
                    if _position_cooldown_passed(same_side_position, settings, now):
                        candidate.decision_action = "ADD_MORE"
                        candidate.order_usd = min(settings.max_order_usd, round(target_delta, 2))
                        candidate.execution_edge_threshold_pp = settings.min_edge_pp
                        action_reason = "Target exposure materially exceeds the current exposure."
                    else:
                        candidate.decision_action = "HOLD"
                        candidate.order_usd = 0
                        action_reason = "Cooldown is still active for this market."
                elif target_delta < -max(add_threshold_value, settings.min_order_usd):
                    candidate.decision_action = "TRIM" if candidate.target_exposure_usd > 0 else "EXIT"
                    candidate.order_usd = abs(round(target_delta, 2))
                    candidate.order_shares = round(
                        same_side_position.shares
                        * min(1.0, candidate.order_usd / max(0.01, same_side_position.exposure_usd)),
                        6,
                    )
                    if candidate.decision_action == "TRIM":
                        candidate.execution_edge_threshold_pp = settings.trim_edge_pp
                    action_reason = "Current exposure exceeds the target by the trim threshold."
                else:
                    candidate.decision_action = "HOLD"
                    candidate.order_usd = 0
                    action_reason = "Position remains valid but the delta is too small to trade."

            candidate.reason = action_reason
            candidate.stage_results.append(
                build_stage_result(
                    stage_number=6,
                    status="pass" if candidate.decision_action != "SKIP" else "warning",
                    reason=action_reason or "Rebalance decision completed.",
                    outputs={
                        "decision": candidate.decision_action,
                        "current_exposure_usd": candidate.current_exposure_usd,
                        "target_exposure_usd": candidate.target_exposure_usd,
                        "order_usd": candidate.order_usd,
                    },
                    hard_block=candidate.decision_action == "SKIP" and bool(candidate.hard_block_reasons),
                )
            )
            evaluated.append(candidate)

        executable_candidates = [
            candidate
            for candidate in evaluated
            if candidate.decision_action in DECISION_ACTIONABLES
        ]
        requested_live_execution = live_execution_requested(settings)
        armed_live_execution = live_execution_armed(settings)
        simulation_reason = _simulation_reason(settings)
        llm_provider_error_rate_high = _llm_provider_error_rate_high(evaluated)
        live_controls = None
        execution_block_reasons: list[str] = []
        execution_pause_reason: str | None = None

        if armed_live_execution and executable_candidates:
            live_controls = await refresh_live_controls(user_id=user_id)
            state.doctor_status = "pass" if live_controls.doctor.ok else "fail"
            state.balance_status = (
                "pass" if live_controls.balance.status == "ready" else "fail"
            )
            state.emergency_stopped = (
                settings.emergency_stop or live_controls.emergency_stopped
            )
        else:
            state.doctor_status = "watch"
            state.balance_status = "watch"

        if settings.emergency_stop:
            execution_block_reasons.append("Emergency stop is active.")
        if live_controls and live_controls.emergency_stopped:
            execution_block_reasons.append("Bullpen live emergency stop is active.")
        if live_controls and not live_controls.unlocked:
            execution_block_reasons.append(
                live_controls.locked_reason or "Dashboard live unlock is required."
            )
        if live_controls and not live_controls.doctor.ok:
            execution_block_reasons.append("Bullpen doctor failed.")
            if settings.pause_if_doctor_fails:
                state.paused = True
                execution_pause_reason = "Bullpen doctor failed. Auto-Live paused."
        if live_controls and live_controls.balance.status != "ready":
            execution_block_reasons.append("Bullpen balance is not ready.")
            if settings.pause_if_balance_unavailable:
                state.paused = True
                execution_pause_reason = (
                    "Bullpen balance was unavailable. Auto-Live paused."
                )
        if daily_loss_stop_hit:
            execution_block_reasons.append("Daily loss stop is hit.")
            state.paused = True
            execution_pause_reason = "Daily loss stop is hit. Auto-Live paused."
        if weekly_loss_stop_hit:
            execution_block_reasons.append("Weekly loss stop is hit.")
            state.paused = True
            execution_pause_reason = "Weekly loss stop is hit. Auto-Live paused."
        if llm_provider_error_rate_high:
            execution_block_reasons.append("LLM provider error rate is too high.")
            if settings.pause_if_llm_provider_error_rate_high:
                state.paused = True
                execution_pause_reason = (
                    "LLM provider error rate is too high. Auto-Live paused."
                )

        state.live_execution_allowed = (
            armed_live_execution and not execution_block_reasons and not state.paused
        )
        guardrail_checked_at = utc_now_iso()
        global_guardrails.extend(
            [
                build_guardrail_check(
                    check_id="dashboard-live-unlock",
                    label="Dashboard live unlock",
                    status=(
                        "pass"
                        if live_controls and live_controls.unlocked
                        else "fail"
                        if armed_live_execution
                        else "watch"
                    ),
                    detail=(
                        "Dashboard live unlock check passed."
                        if live_controls and live_controls.unlocked
                        else (live_controls.locked_reason or "Dashboard live unlock is required.")
                        if live_controls
                        else "Live execution is not armed, so unlock was not required."
                    ),
                    value=(
                        live_controls.unlock_mode.title()
                        if live_controls
                        else "Simulation"
                    ),
                    blocking=armed_live_execution and not (live_controls and live_controls.unlocked),
                    checked_at=guardrail_checked_at,
                ),
                build_guardrail_check(
                    check_id="doctor-health",
                    label="Bullpen doctor",
                    status=state.doctor_status,
                    detail=(
                        live_controls.doctor.message
                        if live_controls
                        else "Doctor was not required because the run stayed in simulation mode."
                    ),
                    value=(
                        "Pass"
                        if state.doctor_status == "pass"
                        else "Blocked"
                        if state.doctor_status == "fail"
                        else "Simulation"
                    ),
                    blocking=state.doctor_status == "fail",
                    checked_at=guardrail_checked_at,
                ),
                build_guardrail_check(
                    check_id="balance-health",
                    label="Bullpen balance",
                    status=state.balance_status,
                    detail=(
                        live_controls.balance.message
                        if live_controls
                        else "Balance was not required because the run stayed in simulation mode."
                    ),
                    value=(
                        "Ready"
                        if state.balance_status == "pass"
                        else "Blocked"
                        if state.balance_status == "fail"
                        else "Simulation"
                    ),
                    blocking=state.balance_status == "fail",
                    checked_at=guardrail_checked_at,
                ),
                build_guardrail_check(
                    check_id="daily-loss-stop",
                    label="Daily loss stop",
                    status="fail" if daily_loss_stop_hit else "pass",
                    detail=(
                        "Daily realized-loss guardrail is hit."
                        if daily_loss_stop_hit
                        else "Daily realized-loss guardrail is clear."
                    ),
                    value="Hit" if daily_loss_stop_hit else "Clear",
                    blocking=daily_loss_stop_hit,
                    checked_at=guardrail_checked_at,
                ),
                build_guardrail_check(
                    check_id="weekly-loss-stop",
                    label="Weekly loss stop",
                    status="fail" if weekly_loss_stop_hit else "pass",
                    detail=(
                        "Weekly realized-loss guardrail is hit."
                        if weekly_loss_stop_hit
                        else "Weekly realized-loss guardrail is clear."
                    ),
                    value="Hit" if weekly_loss_stop_hit else "Clear",
                    blocking=weekly_loss_stop_hit,
                    checked_at=guardrail_checked_at,
                ),
                build_guardrail_check(
                    check_id="llm-provider-health",
                    label="LLM provider health",
                    status="fail" if llm_provider_error_rate_high else "pass",
                    detail=(
                        "A majority of configured LLM providers failed during consensus."
                        if llm_provider_error_rate_high
                        else "LLM provider error rate stayed below the pause threshold."
                    ),
                    value="High" if llm_provider_error_rate_high else "Healthy",
                    blocking=llm_provider_error_rate_high
                    and settings.pause_if_llm_provider_error_rate_high,
                    checked_at=guardrail_checked_at,
                ),
            ]
        )

        executor = bullpen_module.BullpenLiveExecutor()
        submitted_orders = 0
        planned_orders = 0
        new_positions = positions[:]
        new_markets_opened = 0
        failed_orders = 0
        running_failed_orders = state.consecutive_failed_orders
        execution_halted_reason: str | None = execution_pause_reason
        for candidate in evaluated:
            if candidate.decision_action not in DECISION_ACTIONABLES:
                candidate.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="skipped",
                        reason="No execution was needed for this decision.",
                    )
                )
                continue
            if execution_halted_reason:
                candidate.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="skipped",
                        reason=execution_halted_reason,
                        hard_block=True,
                    )
                )
                continue

            if (
                candidate.decision_action == "BUY_NEW"
                and new_markets_opened >= settings.max_new_markets_per_rebalance
            ):
                candidate.decision_action = "SKIP"
                candidate.reason = "Maximum new markets per rebalance has been reached."
                candidate.stage_results[-1] = build_stage_result(
                    stage_number=6,
                    status="warning",
                    reason=candidate.reason,
                    outputs={
                        "decision": candidate.decision_action,
                        "current_exposure_usd": candidate.current_exposure_usd,
                        "target_exposure_usd": candidate.target_exposure_usd,
                        "order_usd": candidate.order_usd,
                    },
                    hard_block=True,
                )
                candidate.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="skipped",
                        reason="Execution was skipped because the new-market rebalance cap was hit.",
                    )
                )
                continue

            planned_orders += 1
            order_action = (
                "buy" if candidate.decision_action in {"BUY_NEW", "ADD_MORE"} else "sell"
            )
            order_side = (
                candidate.side_to_trade
                if order_action == "buy"
                else (
                    candidate.current_position.side
                    if candidate.current_position is not None
                    else (candidate.side_to_trade or "YES")
                )
            )
            initial_price_cents = _current_price_for_side(candidate.market, order_side)
            order_plan = BullpenAutoLiveOrderPlan(
                id=_auto_live_record_id(
                    "order",
                    run_id=run.id,
                    market_id=candidate.market.market_id,
                    action=candidate.decision_action,
                ),
                action=order_action,  # type: ignore[arg-type]
                side=order_side,  # type: ignore[arg-type]
                market_id=candidate.market.market_id,
                market_title=candidate.market.question,
                order_size_usd=round(candidate.order_usd, 2),
                shares=round(candidate.order_shares, 6),
                limit_price_cents=round(initial_price_cents or 0, 2),
                max_slippage_cents=settings.max_slippage_cents,
                dry_run=state.dry_run,
                detail="Order planned but not yet validated against the live quote.",
                created_at=utc_now_iso(),
            )
            if order_plan.action == "sell" and order_plan.shares <= 0 and candidate.current_position:
                order_plan.shares = round(candidate.current_position.shares, 6)

            if not state.dry_run:
                runtime_settings = await refresh_runtime_execution_settings(user_id=user_id)
                if runtime_settings.emergency_stop:
                    state.paused = True
                    state.emergency_stopped = True
                    execution_halted_reason = (
                        "Emergency stop activated during execution. No further orders were started."
                    )
                elif runtime_settings.paused:
                    execution_halted_reason = (
                        "Auto-Live is paused, so no further live orders were started."
                    )
                elif (
                    not runtime_settings.auto_live_enabled
                    or runtime_settings.dry_run
                    or not runtime_settings.allow_live_execution
                ):
                    execution_halted_reason = (
                        "Auto-Live settings changed during execution, so no further live orders were started."
                    )
                if execution_halted_reason:
                    order_plan.status = "skipped"
                    order_plan.detail = execution_halted_reason
                    candidate.order_plan = order_plan
                    candidate.stage_results.append(
                        build_stage_result(
                            stage_number=7,
                            status="fail",
                            reason=order_plan.detail,
                            outputs=order_plan.model_dump(mode="json"),
                            hard_block=True,
                        )
                    )
                    continue

            hard_block_reasons: list[str] = []
            fair_probability_for_order_side = _fair_probability_for_side(
                candidate, order_plan.side
            )
            quote = await refresh_execution_quote(
                slug=candidate.market.slug,
                side=order_plan.side,
            )
            if not state.dry_run:
                hard_block_reasons.extend(execution_block_reasons)
            if quote.current_price_cents is None:
                hard_block_reasons.append("Could not refresh the current market price.")
            if (
                order_plan.action != "sell"
                and quote.spread_cents is not None
                and quote.spread_cents > settings.max_bid_ask_spread_cents
            ):
                hard_block_reasons.append("Bid/ask spread exceeds the configured maximum.")
            is_console_buy_order = (
                settings.strategy_profile == CONSOLE_PROFILE_ID
                and candidate.decision_action == "BUY_NEW"
            )
            if not is_console_buy_order and candidate.order_usd < settings.min_order_usd:
                hard_block_reasons.append("Order is below the minimum order size.")
            if not is_console_buy_order and candidate.order_usd > settings.max_order_usd:
                hard_block_reasons.append("Order exceeds the maximum order size.")

            if order_plan.action == "buy" and quote.current_price_cents is not None:
                original_price_cents = initial_price_cents or quote.current_price_cents
                if quote.current_price_cents > original_price_cents + settings.max_slippage_cents:
                    hard_block_reasons.append("Refreshed buy price exceeds the slippage cap.")
                refreshed_edge_pp = (
                    round(fair_probability_for_order_side - quote.current_price_cents, 2)
                    if fair_probability_for_order_side is not None
                    else None
                )
                if (
                    refreshed_edge_pp is not None
                    and candidate.execution_edge_threshold_pp is not None
                    and refreshed_edge_pp < candidate.execution_edge_threshold_pp
                ):
                    hard_block_reasons.append(
                        "Price moved enough to erase the minimum entry edge."
                    )
                order_plan.limit_price_cents = buy_limit_price_cents(
                    current_price_cents=quote.current_price_cents,
                    original_price_cents=original_price_cents,
                    max_slippage_cents=settings.max_slippage_cents,
                )
                order_plan.shares = round(
                    candidate.order_usd / max(0.01, cents_to_decimal(order_plan.limit_price_cents)),
                    6,
                )
            elif order_plan.action == "sell":
                # Exits are risk-reduction orders.  Do not let wide spreads,
                # slippage caps, or recovered model edge strand an existing
                # position; submit an aggressive sell limit at the exchange
                # floor so it behaves like an immediate marketable exit.
                order_plan.limit_price_cents = 1
                if order_plan.shares <= 0 and candidate.current_position:
                    order_plan.shares = candidate.current_position.shares

            order_plan.refreshed_market_price_cents = quote.current_price_cents
            if hard_block_reasons:
                order_plan.status = "skipped"
                order_plan.detail = "; ".join(hard_block_reasons)
                candidate.order_plan = order_plan
                logger.warning(
                    "Auto-Live skipped order user=%s market=%s action=%s reason=%s",
                    user_id,
                    candidate.market.market_id,
                    candidate.decision_action,
                    order_plan.detail,
                )
                candidate.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="fail",
                        reason=order_plan.detail,
                        outputs=order_plan.model_dump(mode="json"),
                        hard_block=True,
                    )
                )
                failed_orders += 1
                continue

            if state.dry_run:
                order_plan.status = "skipped"
                order_plan.detail = f"Simulation only: {simulation_reason}"
                candidate.order_plan = order_plan
                candidate.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="skipped",
                        reason=order_plan.detail,
                        outputs=order_plan.model_dump(mode="json"),
                    )
                )
                continue

            trade_analysis_reference = f"auto-live-order:{order_plan.id}"
            refreshed_market = quote.market or candidate.market
            exit_type = _trade_analysis_exit_type_from_signals(
                candidate.current_position.exit_signals
                if candidate.current_position is not None
                else []
            )
            if order_plan.action == "buy":
                buy_context = _trade_analysis_buy_context_from_candidate(
                    run_id=run.id,
                    settings=settings,
                    candidate=candidate,
                    order_plan=order_plan,
                )
                buy_context.update(
                    {
                        "captured_at": utc_now_iso(),
                        "event_close_time": refreshed_market.close_time,
                        "market_probability": (
                            refreshed_market.current_yes_odds
                            if order_plan.side == "YES"
                            else refreshed_market.current_no_odds
                        ),
                        "event_snapshot_json": _trade_analysis_event_snapshot(refreshed_market),
                        "market_snapshot_json": _trade_analysis_market_snapshot(refreshed_market),
                        "order_book_snapshot_json": _trade_analysis_order_book_snapshot(refreshed_market),
                        "positions_snapshot_json": _trade_analysis_position_snapshot(candidate.current_position),
                    }
                )
                _safe_trade_analysis_capture(
                    "auto-live buy pre-submit",
                    capture_auto_live_buy_pre_submit_sync,
                    user_id=user_id,
                    entry_reference=trade_analysis_reference,
                    context=buy_context,
                )
            else:
                exit_context = _trade_analysis_exit_context_from_candidate(
                    run_id=run.id,
                    candidate=candidate,
                    order_plan=order_plan,
                    market_snapshot=_trade_analysis_market_snapshot(refreshed_market),
                    event_snapshot=_trade_analysis_event_snapshot(refreshed_market),
                    order_book_snapshot=_trade_analysis_order_book_snapshot(refreshed_market),
                    positions_snapshot=_trade_analysis_position_snapshot(candidate.current_position),
                )
                exit_context.update(
                    {
                        "captured_at": utc_now_iso(),
                        "exit_type": exit_type,
                        "market_probability": (
                            refreshed_market.current_yes_odds
                            if order_plan.side == "YES"
                            else refreshed_market.current_no_odds
                        ),
                    }
                )
                _safe_trade_analysis_capture(
                    "auto-live exit pre-submit",
                    capture_auto_live_exit_pre_submit_sync,
                    user_id=user_id,
                    exit_reference=trade_analysis_reference,
                    context=exit_context,
                )

            try:
                if order_plan.action == "buy":
                    order_plan.execution_response = await executor.buy_limit(
                        market_id=candidate.market.market_id,
                        outcome="Yes" if order_plan.side == "YES" else "No",
                        amount_usd=order_plan.order_size_usd,
                        max_price=cents_to_decimal(order_plan.limit_price_cents),
                    )
                else:
                    order_plan.execution_response = await executor.sell_limit(
                        market_id=candidate.market.market_id,
                        outcome="Yes" if order_plan.side == "YES" else "No",
                        shares=order_plan.shares,
                        min_price=cents_to_decimal(order_plan.limit_price_cents),
                        max_reprice_attempts=settings.max_reprice_attempts,
                    )
                order_plan.status = "submitted"
                order_plan.executed_at = utc_now_iso()
                order_plan.detail = "Limit order submitted successfully."
                candidate.order_plan = order_plan
                candidate.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="pass",
                        reason=order_plan.detail,
                        outputs=order_plan.model_dump(mode="json"),
                    )
                )
                submitted_orders += 1
                running_failed_orders = 0
                if order_plan.action == "buy":
                    _safe_trade_analysis_capture(
                        "auto-live buy execution",
                        capture_auto_live_buy_result_sync,
                        user_id=user_id,
                        entry_reference=trade_analysis_reference,
                        raw_execution_response=order_plan.execution_response,
                    )
                else:
                    _safe_trade_analysis_capture(
                        "auto-live exit execution",
                        capture_auto_live_exit_result_sync,
                        user_id=user_id,
                        exit_reference=trade_analysis_reference,
                        market_id=candidate.market.market_id,
                        outcome_name=order_plan.side,
                        title=candidate.market.question,
                        raw_execution_response=order_plan.execution_response,
                        exit_type=exit_type,
                        sell_reason=candidate.reason,
                    )
                if candidate.decision_action == "BUY_NEW":
                    new_markets_opened += 1
                self._apply_position_update(new_positions, candidate, order_plan)
                logger.info(
                    "Auto-Live submitted order user=%s market=%s action=%s side=%s usd=%.2f shares=%.6f",
                    user_id,
                    candidate.market.market_id,
                    candidate.decision_action,
                    order_plan.side,
                    order_plan.order_size_usd,
                    order_plan.shares,
                )
                refreshed_balance = await refresh_balance()
                state.balance_status = (
                    "pass" if refreshed_balance.status == "ready" else "fail"
                )
                if refreshed_balance.status != "ready":
                    state.live_execution_allowed = False
                    if settings.pause_if_balance_unavailable:
                        state.paused = True
                        execution_halted_reason = (
                            "Post-trade balance refresh failed. Auto-Live paused."
                        )
                    else:
                        execution_halted_reason = (
                            "Post-trade balance refresh failed. No further live orders were started."
                        )
            except TimeoutError:
                order_plan.status = "failed"
                order_plan.detail = (
                    f"Bullpen order submission timed out after "
                    f"{BULLPEN_ORDER_SUBMISSION_TIMEOUT_SECONDS} seconds. "
                    "The worker will continue with the next planned order and surface this row in the progress log."
                )
                candidate.order_plan = order_plan
                running_failed_orders += 1
                if order_plan.action == "buy":
                    _safe_trade_analysis_capture(
                        "auto-live buy timeout",
                        capture_auto_live_buy_result_sync,
                        user_id=user_id,
                        entry_reference=trade_analysis_reference,
                        raw_execution_response=None,
                        failed=True,
                        failure_reason=order_plan.detail,
                    )
                else:
                    _safe_trade_analysis_capture(
                        "auto-live exit timeout",
                        capture_auto_live_exit_result_sync,
                        user_id=user_id,
                        exit_reference=trade_analysis_reference,
                        market_id=candidate.market.market_id,
                        outcome_name=order_plan.side,
                        title=candidate.market.question,
                        raw_execution_response=None,
                        exit_type=exit_type,
                        failed=True,
                        failure_reason=order_plan.detail,
                        sell_reason=candidate.reason,
                    )
                candidate.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="fail",
                        reason=order_plan.detail,
                        outputs=order_plan.model_dump(mode="json"),
                        hard_block=True,
                    )
                )
            except Exception as exc:
                order_plan.status = "failed"
                order_plan.detail = str(exc)
                candidate.order_plan = order_plan
                running_failed_orders += 1
                if order_plan.action == "buy":
                    _safe_trade_analysis_capture(
                        "auto-live buy failure",
                        capture_auto_live_buy_result_sync,
                        user_id=user_id,
                        entry_reference=trade_analysis_reference,
                        raw_execution_response=None,
                        failed=True,
                        failure_reason=order_plan.detail,
                    )
                else:
                    _safe_trade_analysis_capture(
                        "auto-live exit failure",
                        capture_auto_live_exit_result_sync,
                        user_id=user_id,
                        exit_reference=trade_analysis_reference,
                        market_id=candidate.market.market_id,
                        outcome_name=order_plan.side,
                        title=candidate.market.question,
                        raw_execution_response=None,
                        exit_type=exit_type,
                        failed=True,
                        failure_reason=order_plan.detail,
                        sell_reason=candidate.reason,
                    )
                candidate.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="fail",
                        reason=order_plan.detail,
                        outputs=order_plan.model_dump(mode="json"),
                        hard_block=True,
                    )
                )
                failed_orders += 1
                logger.warning(
                    "Auto-Live order failed user=%s market=%s action=%s error=%s",
                    user_id,
                    candidate.market.market_id,
                    candidate.decision_action,
                    order_plan.detail,
                )
                if (
                    settings.pause_after_consecutive_failed_orders > 0
                    and running_failed_orders
                    >= settings.pause_after_consecutive_failed_orders
                ):
                    state.paused = True
                    state.live_execution_allowed = False
                    execution_halted_reason = (
                        "Consecutive failed orders exceeded the configured threshold. Auto-Live paused."
                    )

        state.consecutive_failed_orders = running_failed_orders

        decisions = [self._to_decision(run.id, candidate) for candidate in evaluated]
        for decision in decisions:
            log_method = getattr(logger, _decision_log_level(decision))
            log_method(
                "Auto-Live decision user=%s run=%s market=%s action=%s risk=%s order_status=%s dry_run=%s reason=%s",
                user_id,
                run.id,
                decision.market_id,
                decision.decision,
                decision.risk_status,
                decision.order_plan.status if decision.order_plan else "none",
                decision.order_plan.dry_run if decision.order_plan else state.dry_run,
                _decision_log_reason(decision),
            )
        historical_and_current_decisions = [*historical_decisions, *decisions]
        (
            state.today_executed_orders,
            state.today_skipped_orders,
        ) = _today_order_counts(historical_and_current_decisions, now=now)
        state.last_execution_at = _latest_execution_at(historical_and_current_decisions)
        run.decisions_count = len(decisions)
        run.decision_ids = [decision.id for decision in decisions]
        run.orders_planned = planned_orders
        run.orders_submitted = submitted_orders
        run.live_execution_requested = bool(executable_candidates and requested_live_execution)
        run.live_execution_attempted = bool(
            executable_candidates and armed_live_execution and not state.dry_run
        )
        run.completed_at = utc_now_iso()
        blocked_live_run = bool(
            executable_candidates
            and armed_live_execution
            and not state.dry_run
            and execution_block_reasons
            and submitted_orders == 0
        )
        degraded_live_run = bool(
            execution_halted_reason and not state.dry_run and submitted_orders < planned_orders
        )
        run.status = "failed" if state.paused or blocked_live_run or degraded_live_run else "completed"
        if state.dry_run:
            run.summary = (
                f"Auto-Live simulated {len(decisions)} decisions with {planned_orders} planned orders. "
                f"{simulation_reason}"
            )
        elif state.paused:
            run.summary = execution_halted_reason or execution_pause_reason or "Auto-Live paused."
        elif blocked_live_run:
            run.summary = (
                "Live execution was blocked: " + "; ".join(execution_block_reasons)
            )
        elif degraded_live_run:
            run.summary = execution_halted_reason or (
                "Auto-Live stopped submitting new orders before the run completed."
            )
        else:
            run.summary = (
                f"Auto-Live completed with {len(decisions)} decisions, "
                f"{planned_orders} planned orders, and {submitted_orders} submitted orders."
            )

        state.last_run_id = run.id
        state.last_run_at = run.completed_at
        state.last_scan_at = run.completed_at
        state.last_llm_run_at = run.completed_at
        state.last_rebalance_at = run.completed_at
        state.last_error = None if run.status == "completed" else run.summary
        state.last_action = run.summary
        state.latest_guardrail_checks = global_guardrails
        state.live_execution_allowed = (
            armed_live_execution
            and not execution_block_reasons
            and not state.paused
            and execution_halted_reason is None
        )
        state.next_run_at = (
            now + timedelta(seconds=settings.active_price_refresh_seconds)
        ).isoformat() if state.running else None
        state.next_scan_at = (
            now + timedelta(minutes=settings.new_scan_interval_minutes)
        ).isoformat() if state.running else None
        state.next_llm_run_at = (
            now + timedelta(minutes=settings.llm_rerun_interval_minutes)
        ).isoformat() if state.running else None
        state.next_rebalance_at = (
            now + timedelta(minutes=settings.rebalance_interval_minutes)
        ).isoformat() if state.running else None
        state.invested_usd = round(sum(position.exposure_usd for position in new_positions), 2)
        state.current_value_usd = round(sum(position.exposure_usd for position in new_positions), 2)
        state.pnl_usd = round(state.current_value_usd - state.invested_usd, 2)
        state.active_positions = _active_market_count(new_positions)
        state.trades_today = state.today_executed_orders

        return EngineResult(run=run, decisions=decisions, state=state, positions=new_positions)

    async def _execute_console_top10(
        self,
        *,
        user_id: int,
        settings: BullpenAutoLiveSettings,
        state: BullpenAutoLiveState,
        run: BullpenAutoLiveRun,
        positions: list[PositionSnapshot],
        historical_decisions: list[BullpenAutoLiveDecision],
        global_guardrails: list[BullpenAutoLiveGuardrailCheck],
        now: datetime,
        progress_callback: ProgressCallback | None = None,
    ) -> EngineResult:
        saved_console_order_usd = console_order_usd(settings)
        live_wallet_positions_task = asyncio.create_task(read_console_wallet_positions())
        manual_console_context = (
            run.request_context.console_profile
            if run.request_context and run.request_context.console_profile
            else None
        )
        manual_console_rows = (
            manual_console_context.candidate_rows if manual_console_context else []
        )
        manual_console_rows_prefiltered = (
            manual_console_context.candidate_rows_prefiltered
            if manual_console_context is not None
            else False
        )
        manual_console_rows_used = manual_console_context is not None and (
            manual_console_rows_prefiltered or bool(manual_console_rows)
        )
        manual_console_reuse_saved_llm_outputs = (
            manual_console_context.reuse_saved_llm_outputs
            if manual_console_context is not None
            else True
        )
        manual_console_rows_have_reusable_llm = False
        selected_manual_candidate_ids: list[str] = []
        selected_manual_candidate_id_set: set[str] = set()
        rejected_candidate_map: dict[str, BullpenAutoLiveRejectedCandidateDiagnostic] = {}
        scan_source_label = (
            manual_console_context.source_label
            if manual_console_context and manual_console_context.source_label
            else None
        )
        scan_source_url = (
            manual_console_context.source_url
            if manual_console_context and manual_console_context.source_url
            else None
        )
        stage1_accepted_candidates: list[dict[str, object]] = []
        stage1_rejected_candidates: list[dict[str, object]] = []
        candidate_rows_before_llm = 0
        active_position_rows_before_llm = 0
        llm_candidate_count = 0
        scanned_total_candidates = 0
        active_position_contexts: list[dict[str, object]] = []
        candidate_contexts: list[dict[str, object]] = []
        scan_seed_markets: list[ScannedMarket] | None = None
        market_by_slug: dict[str, ScannedMarket] = {}
        market_by_id: dict[str, ScannedMarket] = {}

        if manual_console_rows_used:
            scan_source_label = scan_source_label or "Bullpen x AI manual table"
            scan_source_url = scan_source_url or CONSOLE_PROFILE_ID
            scanned_total_candidates = max(
                manual_console_context.total_candidates,
                len(manual_console_rows),
            )
            manual_markets = [_manual_console_market(row) for row in manual_console_rows]
            if manual_console_rows_prefiltered:
                accepted_manual_pairs = list(
                    zip(manual_console_rows, manual_markets, strict=False)
                )
            else:
                accepted_manual_pairs = []
                for row, market in zip(manual_console_rows, manual_markets, strict=False):
                    rejection_reasons = console_market_filter_reasons(market, now=now)
                    if rejection_reasons:
                        rejected = ScanRejectedMarket(
                            market_id=market.market_id,
                            question=market.question,
                            slug=market.slug,
                            market_url=market.market_url,
                            reasons=rejection_reasons,
                        )
                        stage1_rejected_candidates.append(
                            _serialize_rejected_scan_candidate(rejected)
                        )
                        for reason in rejection_reasons:
                            _record_rejected_candidate(
                                rejected_candidate_map,
                                market=market,
                                reason=reason,
                            )
                        continue
                    accepted_manual_pairs.append((row, market))
            accepted_manual_rows = [row for row, _ in accepted_manual_pairs]
            manual_markets = [market for _, market in accepted_manual_pairs]
            manual_console_rows_have_reusable_llm = (
                manual_console_reuse_saved_llm_outputs
                and bool(accepted_manual_rows)
                and all(
                    row.llm_yes_odds is not None or row.llm_no_odds is not None
                    for row in accepted_manual_rows
                )
            )
            selected_manual_candidate_ids = [
                row.market_id for row in accepted_manual_rows if row.selected
            ]
            selected_manual_candidate_id_set = set(selected_manual_candidate_ids)
            stage1_accepted_candidates = [
                _serialize_manual_console_candidate(row, market)
                for row, market in accepted_manual_pairs
            ]
            market_by_slug = {market.slug: market for market in manual_markets if market.slug}
            market_by_id = {market.market_id: market for market in manual_markets}
            if manual_console_rows_have_reusable_llm:
                candidate_rows_before_llm = len(accepted_manual_rows)
                llm_candidate_count = sum(
                    1
                    for row in accepted_manual_rows
                    if row.llm_yes_odds is not None or row.llm_no_odds is not None
                )
                for row, market in accepted_manual_pairs:
                    returns_per_day = row.returns_per_day
                    llm_outputs = row.llm_outputs
                    llm_consensus = (
                        _manual_console_consensus(row)
                        if row.llm_yes_odds is not None or row.llm_no_odds is not None
                        else None
                    )
                    stage_results = [
                        build_stage_result(
                            stage_number=1,
                            status="pass",
                            reason="Candidate came from the visible Bullpen x AI table.",
                            outputs={
                                "question_id": row.question_id,
                                "selected": row.selected,
                                "close_time": row.close_time,
                                "current_no_odds": row.current_no_odds,
                                "returns_per_day": returns_per_day,
                                "source_label": scan_source_label,
                            },
                        ),
                        build_stage_result(
                            stage_number=2,
                            status="pass",
                            reason="Using the current Bullpen x AI table row instead of rerunning a separate scan.",
                            outputs={
                                "rules_available": bool(row.rules),
                                "market_url": row.market_url,
                            },
                        ),
                    ]

                    if llm_consensus is None:
                        reason = "Candidate is missing LLM output in the current Bullpen x AI table."
                        stage_results.append(
                            build_stage_result(
                                stage_number=3,
                                status="fail",
                                reason=reason,
                                hard_block=True,
                            )
                        )
                        _record_rejected_candidate(
                            rejected_candidate_map,
                            market=market,
                            reason=reason,
                        )
                        candidate_contexts.append(
                            {
                                "market": market,
                                "returns_per_day": returns_per_day,
                                "rules": None,
                                "llm_outputs": llm_outputs,
                                "llm_consensus": None,
                                "stage_results": stage_results,
                                "qualified": False,
                                "selected_for_auto_invest": row.selected,
                                "reason": reason,
                            }
                        )
                        continue

                    selected_side, strongest_llm_odds = _stronger_probability_side(
                        yes_probability=llm_consensus.fair_yes_probability_pct,
                        no_probability=llm_consensus.fair_no_probability_pct,
                        minimum_probability=CONSOLE_MIN_LLM_STRONG_SIDE_ODDS,
                    )
                    qualified_by_table = bool(
                        returns_per_day is not None
                        and selected_side is not None
                    )
                    stage_results.append(
                        build_stage_result(
                            stage_number=3,
                            status="warning"
                            if row.llm_disagreement_level in {"Medium", "High"}
                            else "pass",
                            reason="Using the current Bullpen x AI LLM output for this candidate.",
                            outputs={
                                "fair_yes_probability_pct": llm_consensus.fair_yes_probability_pct,
                                "fair_no_probability_pct": llm_consensus.fair_no_probability_pct,
                                "disagreement_level": llm_consensus.disagreement_level,
                                "adjudication_required": llm_consensus.adjudication_required,
                                "confidence": llm_consensus.confidence,
                                "evidence_status": llm_consensus.evidence_status,
                            },
                        )
                    )

                    qualification_reason = (
                        "Candidate qualifies for the Events to invest in table."
                        if qualified_by_table
                        else "Candidate did not pass the Events to invest in table thresholds."
                    )
                    stage_results.append(
                        build_stage_result(
                            stage_number=4,
                            status="pass"
                            if qualified_by_table
                            else "warning",
                            reason=qualification_reason,
                            outputs={
                                "returns_per_day": returns_per_day,
                                "selected_side": selected_side,
                                "strongest_llm_odds": strongest_llm_odds,
                                "fair_yes_probability_pct": llm_consensus.fair_yes_probability_pct,
                                "fair_no_probability_pct": llm_consensus.fair_no_probability_pct,
                                "min_strongest_llm_odds": CONSOLE_MIN_LLM_STRONG_SIDE_ODDS,
                                "selected": row.selected,
                            },
                            hard_block=not qualified_by_table,
                        )
                    )
                    if not qualified_by_table:
                        _record_rejected_candidate(
                            rejected_candidate_map,
                            market=market,
                            reason=qualification_reason,
                        )
                    candidate_contexts.append(
                        {
                            "market": market,
                            "returns_per_day": returns_per_day,
                            "rules": None,
                            "llm_outputs": llm_outputs,
                            "llm_consensus": llm_consensus,
                            "stage_results": stage_results,
                            "qualified": qualified_by_table and row.selected,
                            "selected_for_auto_invest": row.selected,
                            "selected_side": selected_side,
                            "reason": qualification_reason,
                        }
                    )
            else:
                scan_seed_markets = manual_markets
        else:
            scanned = await scan_console_profile_markets(now=now)
            scan_source_label = scanned.source_label
            scan_source_url = scanned.source_url
            scanned_total_candidates = scanned.total_candidates
            stage1_accepted_candidates = [
                _serialize_scan_candidate(market) for market in scanned.accepted
            ]
            stage1_rejected_candidates = [
                _serialize_rejected_scan_candidate(rejected)
                for rejected in scanned.rejected
            ]
            market_by_slug = {market.slug: market for market in scanned.accepted if market.slug}
            market_by_id = {market.market_id: market for market in scanned.accepted}
            scan_seed_markets = scanned.accepted
            for rejected in scanned.rejected:
                for reason in rejected.reasons:
                    _record_rejected_candidate(
                        rejected_candidate_map,
                        market=ScannedMarket(
                            market_id=rejected.market_id,
                            question=rejected.question,
                            market_url=rejected.market_url,
                            slug=rejected.slug,
                            close_time=None,
                            theme="Uncategorized",
                            current_yes_odds=None,
                            current_no_odds=None,
                            volume_usd=None,
                            liquidity_usd=None,
                            description=None,
                            outcome_labels=[],
                            event_slug=None,
                            best_bid_cents=None,
                            best_ask_cents=None,
                            spread_cents=None,
                            force_include=False,
                            raw=None,
                        ),
                        reason=reason,
                    )

        live_wallet_positions = await live_wallet_positions_task
        unsupported_live_wallet_positions = [
            position
            for position in live_wallet_positions
            if not _is_supported_outcome_side(position.side)
        ]
        if unsupported_live_wallet_positions:
            logger.warning(
                "Skipping %s unsupported Bullpen wallet position(s) for Auto-Live console profile: %s",
                len(unsupported_live_wallet_positions),
                [
                    {
                        "market_id": position.market_id,
                        "market_title": position.market_title,
                        "side": position.side,
                    }
                    for position in unsupported_live_wallet_positions
                ],
            )
        live_wallet_positions = [
            position
            for position in live_wallet_positions
            if _is_supported_outcome_side(position.side)
        ]
        market_by_slug, market_by_id = await _hydrate_missing_active_position_markets(
            live_wallet_positions,
            market_by_slug=market_by_slug,
            market_by_id=market_by_id,
        )

        enriched_wallet_positions = [
            apply_scanned_market_to_position(
                position,
                market_by_slug.get(position.slug) or market_by_id.get(position.market_id),
            )
            for position in live_wallet_positions
        ]
        persisted_positions_by_key = {
            f"{position.market_id}::{position.side}": position for position in positions
        }
        position_snapshots: list[PositionSnapshot] = []
        for position in enriched_wallet_positions:
            if position.is_claimable:
                continue
            position_key = f"{position.market_id}::{position.side}"
            persisted_position = persisted_positions_by_key.get(position_key)
            matched_market = market_by_slug.get(position.slug) or market_by_id.get(position.market_id)
            position_snapshots.append(
                PositionSnapshot(
                    market_id=position.market_id,
                    slug=position.slug,
                    market_title=position.market_title,
                    market_url=position.market_url,
                    theme=position.theme,
                    side=position.side,
                    exposure_usd=position.exposure_usd,
                    shares=position.shares,
                    average_price_cents=position.average_price_cents,
                    opened_at=now,
                    updated_at=now,
                    close_time=position.close_time,
                    current_price_cents=position.current_price_cents,
                    condition_id=position.condition_id,
                    current_yes_odds=(
                        matched_market.current_yes_odds
                        if matched_market is not None
                        else position.current_yes_odds
                    ),
                    current_no_odds=(
                        matched_market.current_no_odds
                        if matched_market is not None
                        else position.current_no_odds
                    ),
                    best_bid_cents=(
                        matched_market.best_bid_cents
                        if matched_market is not None
                        else persisted_position.best_bid_cents
                        if persisted_position is not None
                        else None
                    ),
                    best_ask_cents=(
                        matched_market.best_ask_cents
                        if matched_market is not None
                        else persisted_position.best_ask_cents
                        if persisted_position is not None
                        else None
                    ),
                    price_history=(
                        list(persisted_position.price_history)
                        if persisted_position is not None
                        else []
                    ),
                    exit_signals=(
                        list(persisted_position.exit_signals)
                        if persisted_position is not None
                        else []
                    ),
                    exit_state=persisted_position.exit_state if persisted_position is not None else "ACTIVE",
                    estimated_freeable_value_usd=(
                        persisted_position.estimated_freeable_value_usd
                        if persisted_position is not None
                        else None
                    ),
                )
            )
        claimable_wallet_positions = [
            position for position in enriched_wallet_positions if position.is_claimable
        ]
        active_position_rows_before_llm = len(position_snapshots) + len(
            claimable_wallet_positions
        )

        set_run_stage_result(
            run,
            build_workflow_stage_result(
                stage_number=1,
                workflow_stage_key="scan",
                phase_status="completed",
                status="pass",
                reason="Bullpen console profile synced live wallet positions and prepared the candidate set.",
                completed_items=scanned_total_candidates,
                total_items=scanned_total_candidates,
                item_label="events",
                outputs={
                    "live_wallet_positions": len(enriched_wallet_positions),
                    "active_wallet_positions": active_position_rows_before_llm,
                    "active_positions_found": [
                        _serialize_active_wallet_position(position)
                        for position in enriched_wallet_positions
                    ],
                    "claimable_wallet_positions": len(claimable_wallet_positions),
                    "scanned_candidates": scanned_total_candidates,
                    "active_position_rows_before_llm": active_position_rows_before_llm,
                    "candidate_rows_before_llm": candidate_rows_before_llm,
                    "llm_candidate_count": llm_candidate_count,
                    "unsupported_wallet_positions_skipped": len(unsupported_live_wallet_positions),
                    "unsupported_wallet_positions": [
                        {
                            "market_id": position.market_id,
                            "market_title": position.market_title,
                            "side": position.side,
                        }
                        for position in unsupported_live_wallet_positions
                    ],
                    "accepted_candidates": stage1_accepted_candidates,
                    "accepted_candidates_count": len(stage1_accepted_candidates),
                    "rejected_candidates": stage1_rejected_candidates,
                    "rejected_candidates_count": len(stage1_rejected_candidates),
                    "scan_source_label": scan_source_label,
                    "scan_source_url": scan_source_url,
                    "used_manual_console_rows": manual_console_rows_used,
                    "selected_manual_candidate_ids": selected_manual_candidate_ids,
                    "selected_manual_candidate_count": len(selected_manual_candidate_ids),
                    "snapshot_id": manual_console_context.snapshot_id
                    if manual_console_context and manual_console_context.snapshot_id
                    else None,
                    "mode": manual_console_context.mode
                    if manual_console_context and manual_console_context.mode
                    else None,
                    "scanned_at": manual_console_context.scanned_at
                    if manual_console_context and manual_console_context.scanned_at
                    else now.isoformat(),
                    "fixed_schedule_timezone": "Asia/Kolkata",
                    "fixed_schedule_hours": list(CONSOLE_SCHEDULE_HOURS),
                },
                guardrails_checked=global_guardrails,
            ),
        )
        self._report_progress(progress_callback, run, state)
        llm_stage_started_at = utc_now_iso()
        stage1_accepted_candidate_count = len(stage1_accepted_candidates)

        def report_llm_stage_progress(
            *,
            phase_status: str,
            reason: str,
            completed_items: int,
            current_candidate_index: int | None = None,
            current_market: ScannedMarket | None = None,
            last_completed_market: ScannedMarket | None = None,
            reviewed_contexts: list[dict[str, object]] | None = None,
            qualified_candidate_count: int | None = None,
            reused_existing_llm_outputs: bool = False,
            completed_at: str | None | object = _DEFAULT_COMPLETED_AT,
        ) -> None:
            stage_outputs: dict[str, object] = {
                "scan_source_label": scan_source_label,
                "scan_source_url": scan_source_url,
                "used_manual_console_rows": manual_console_rows_used,
                "active_position_rows_before_llm": active_position_rows_before_llm,
                "candidate_rows_before_llm": candidate_rows_before_llm,
                "llm_candidate_count": llm_candidate_count,
                "stage1_accepted_candidate_count": stage1_accepted_candidate_count,
            }
            if "llm_candidate_count_before_cap" in locals():
                stage_outputs["llm_candidate_count_before_cap"] = llm_candidate_count_before_cap
                stage_outputs["max_llm_candidates_per_run"] = max_llm_candidates
                stage_outputs["llm_candidates_skipped_by_cap"] = len(skipped_llm_markets)
                stage_outputs["fresh_llm_candidate_cap"] = fresh_llm_candidate_cap
                stage_outputs["fresh_llm_candidate_count_before_cap"] = (
                    fresh_llm_candidate_count_before_cap
                )
                stage_outputs["fresh_llm_candidates_skipped_by_cap"] = len(
                    skipped_fresh_llm_markets
                )
            if reused_existing_llm_outputs:
                stage_outputs["reused_existing_llm_outputs"] = True
            if current_candidate_index is not None:
                stage_outputs["current_candidate_index"] = current_candidate_index
            if current_market is not None:
                stage_outputs["current_candidate_market_id"] = current_market.market_id
                stage_outputs["current_candidate_question"] = current_market.question
                stage_outputs["current_candidate_market_url"] = current_market.market_url
            if last_completed_market is not None:
                stage_outputs["last_completed_candidate_market_id"] = (
                    last_completed_market.market_id
                )
                stage_outputs["last_completed_candidate_question"] = (
                    last_completed_market.question
                )
                stage_outputs["last_completed_candidate_market_url"] = (
                    last_completed_market.market_url
                )
            if reviewed_contexts is not None:
                reviewed_candidates = [
                    _serialize_llm_review_context(context) for context in reviewed_contexts
                ]
                qualifying_reviewed_candidates = [
                    candidate
                    for candidate in reviewed_candidates
                    if candidate.get("source_kind") == "candidate"
                    and bool(candidate.get("qualified"))
                ]
                stage_outputs["llm_reviewed_candidates"] = reviewed_candidates
                stage_outputs["llm_reviewed_candidate_count_so_far"] = len(
                    reviewed_candidates
                )
                stage_outputs["qualified_candidate_count_so_far"] = len(
                    qualifying_reviewed_candidates
                )
                stage_outputs["qualified_candidate_count"] = len(
                    qualifying_reviewed_candidates
                )
                stage_outputs["qualified_candidate_market_ids"] = [
                    candidate["market_id"]
                    for candidate in qualifying_reviewed_candidates
                    if candidate.get("market_id")
                ]
            elif qualified_candidate_count is not None:
                stage_outputs["qualified_candidate_count_so_far"] = qualified_candidate_count
            set_run_stage_result(
                run,
                build_workflow_stage_result(
                    stage_number=2,
                    workflow_stage_key="llm",
                    phase_status=phase_status,
                    status="pass" if llm_candidate_count > 0 else "warning",
                    reason=reason,
                    completed_items=completed_items,
                    total_items=llm_candidate_count,
                    item_label="events",
                    outputs=stage_outputs,
                    guardrails_checked=global_guardrails,
                    started_at=llm_stage_started_at,
                    completed_at=completed_at,
                ),
            )
            self._report_progress(progress_callback, run, state)

        if manual_console_rows_have_reusable_llm:
            report_llm_stage_progress(
                phase_status="running",
                reason=(
                    f"Stage 2 started. Reusing existing LLM outputs for {llm_candidate_count} Stage 1 events."
                    if llm_candidate_count > 0
                    else "No candidate events qualified for Stage 2 LLM review."
                ),
                completed_items=0,
                reused_existing_llm_outputs=True,
                completed_at=None,
            )

        if scan_seed_markets is not None:
            positioned_market_ids = {position.market_id for position in position_snapshots}
            candidate_rows: list[tuple[ScannedMarket, float | None]] = []
            for market in scan_seed_markets:
                if market.market_id in positioned_market_ids:
                    continue
                returns_per_day = candidate_returns_per_day(market, now=now)
                candidate_rows.append((market, returns_per_day))
            active_llm_rows: list[dict[str, object]] = [
                {
                    "kind": "active_position",
                    "position": position,
                    "market": _active_position_market(
                        position,
                        market_by_slug=market_by_slug,
                        market_by_id=market_by_id,
                    ),
                    "returns_per_day": position_returns_per_day(position, now=now),
                }
                for position in enriched_wallet_positions
                if not position.is_claimable
            ]
            candidate_rows.sort(
                key=lambda item: (
                    0 if item[0].market_id in selected_manual_candidate_id_set else 1,
                    -(item[1] if item[1] is not None else float("-inf")),
                    item[0].close_time or "",
                    item[0].question,
                )
            )
            candidate_rows_before_llm = len(candidate_rows)
            fresh_llm_rows = [
                {
                    "kind": "candidate",
                    "market": market,
                    "returns_per_day": returns_per_day,
                }
                for market, returns_per_day in candidate_rows
            ]
            fresh_llm_candidate_count_before_cap = len(fresh_llm_rows)
            configured_max_llm_candidates = max(1, settings.max_llm_candidates_per_run)
            fresh_llm_candidate_cap = min(
                configured_max_llm_candidates,
                CONSOLE_FRESH_LLM_CANDIDATE_CAP,
            )
            skipped_fresh_llm_markets = fresh_llm_rows[fresh_llm_candidate_cap:]
            fresh_llm_rows = fresh_llm_rows[:fresh_llm_candidate_cap]
            llm_candidate_count_before_cap = (
                len(active_llm_rows) + fresh_llm_candidate_count_before_cap
            )
            llm_markets = [*active_llm_rows, *fresh_llm_rows]
            max_llm_candidates = max(
                len(active_llm_rows) + fresh_llm_candidate_cap,
                configured_max_llm_candidates,
            )
            skipped_llm_markets = skipped_fresh_llm_markets
            llm_candidate_count = len(llm_markets)
            set_run_stage_result(
                run,
                build_workflow_stage_result(
                    stage_number=1,
                    workflow_stage_key="scan",
                    phase_status="completed",
                    status="pass",
                    reason="Bullpen console profile synced live wallet positions and prepared the candidate set.",
                    completed_items=scanned_total_candidates,
                    total_items=scanned_total_candidates,
                    item_label="events",
                    outputs={
                        "live_wallet_positions": len(enriched_wallet_positions),
                        "active_wallet_positions": active_position_rows_before_llm,
                        "active_positions_found": [
                            _serialize_active_wallet_position(position)
                            for position in enriched_wallet_positions
                        ],
                        "claimable_wallet_positions": len(claimable_wallet_positions),
                        "scanned_candidates": scanned_total_candidates,
                        "active_position_rows_before_llm": active_position_rows_before_llm,
                        "candidate_rows_before_llm": candidate_rows_before_llm,
                        "llm_candidate_count": llm_candidate_count,
                        "llm_candidate_count_before_cap": llm_candidate_count_before_cap,
                        "max_llm_candidates_per_run": max_llm_candidates,
                        "llm_candidates_skipped_by_cap": len(skipped_llm_markets),
                        "fresh_llm_candidate_cap": fresh_llm_candidate_cap,
                        "fresh_llm_candidate_count_before_cap": fresh_llm_candidate_count_before_cap,
                        "fresh_llm_candidates_skipped_by_cap": len(skipped_fresh_llm_markets),
                        "unsupported_wallet_positions_skipped": len(unsupported_live_wallet_positions),
                        "unsupported_wallet_positions": [
                            {
                                "market_id": position.market_id,
                                "market_title": position.market_title,
                                "side": position.side,
                            }
                            for position in unsupported_live_wallet_positions
                        ],
                        "accepted_candidates": stage1_accepted_candidates,
                        "accepted_candidates_count": len(stage1_accepted_candidates),
                        "rejected_candidates": stage1_rejected_candidates,
                        "rejected_candidates_count": len(stage1_rejected_candidates),
                        "scan_source_label": scan_source_label,
                        "scan_source_url": scan_source_url,
                        "used_manual_console_rows": manual_console_rows_used,
                        "selected_manual_candidate_ids": selected_manual_candidate_ids,
                        "selected_manual_candidate_count": len(selected_manual_candidate_ids),
                        "snapshot_id": manual_console_context.snapshot_id
                        if manual_console_context and manual_console_context.snapshot_id
                        else None,
                        "mode": manual_console_context.mode
                        if manual_console_context and manual_console_context.mode
                        else None,
                        "scanned_at": manual_console_context.scanned_at
                        if manual_console_context and manual_console_context.scanned_at
                        else now.isoformat(),
                        "fixed_schedule_timezone": "Asia/Kolkata",
                        "fixed_schedule_hours": list(CONSOLE_SCHEDULE_HOURS),
                    },
                    guardrails_checked=global_guardrails,
                ),
            )
            self._report_progress(progress_callback, run, state)

            report_llm_stage_progress(
                phase_status="running",
                reason=(
                    (
                        "Stage 2 started. Reviewing "
                        f"{llm_candidate_count} Bullpen rows from active positions and Stage 1 events."
                    )
                    if active_position_rows_before_llm > 0
                    else f"Stage 2 started. Reviewing {llm_candidate_count} Stage 1 events."
                    if llm_candidate_count > 0
                    else "No candidate events qualified for Stage 2 LLM review."
                ),
                completed_items=0,
                completed_at=None,
            )

            for index, llm_row in enumerate(llm_markets, start=1):
                market = llm_row["market"]
                returns_per_day = llm_row["returns_per_day"]
                if not isinstance(market, ScannedMarket):
                    continue
                report_llm_stage_progress(
                    phase_status="running",
                    reason=(
                        f"Stage 2 is reviewing event {index} of {llm_candidate_count}: {market.question}"
                    ),
                    completed_items=index - 1,
                    current_candidate_index=index,
                    current_market=market,
                    reviewed_contexts=[*active_position_contexts, *candidate_contexts],
                    completed_at=None,
                )
                if llm_row["kind"] == "active_position":
                    position = llm_row["position"]
                    if not isinstance(position, ConsoleWalletPosition):
                        continue
                    stage_results = [
                        build_stage_result(
                            stage_number=1,
                            status="pass",
                            reason="Live wallet position was included for LLM review.",
                            outputs={
                                "source_kind": "active_position",
                                "position_key": f"{position.market_id}::{position.side}",
                                "position_side": position.side,
                                "shares": position.shares,
                                "close_time": position.close_time,
                                "current_yes_odds": position.current_yes_odds,
                                "current_no_odds": position.current_no_odds,
                                "returns_per_day": returns_per_day,
                            },
                        )
                    ]
                    rules = evaluate_market_rules(market, now=now)
                    rules_fail_reason = rules.fail_reason
                    stage_results.append(
                        build_stage_result(
                            stage_number=2,
                            status="warning" if rules_fail_reason else "pass",
                            reason=(
                                "Resolution criteria and deadline were parsed successfully."
                                if not rules_fail_reason
                                else (
                                    f"{rules_fail_reason} LLM consensus still ran so the active "
                                    "position could be monitored."
                                )
                            ),
                            outputs={
                                "close_time": market.close_time,
                                "yes_definition": rules.yes_definition,
                                "deadline_et": rules.deadline_et,
                                "hours_remaining": rules.hours_remaining,
                                "rules_fail_reason": rules_fail_reason,
                            },
                            hard_block=False,
                        )
                    )
                    evidence_packet = build_evidence_packet(
                        market,
                        rules,
                        built_at=utc_now_iso(),
                    )
                    llm_outputs, llm_consensus = run_llm_consensus(
                        market,
                        rules,
                        evidence_packet,
                    )
                    selected_side, _ = _stronger_probability_side(
                        yes_probability=llm_consensus.fair_yes_probability_pct,
                        no_probability=llm_consensus.fair_no_probability_pct,
                        minimum_probability=CONSOLE_MIN_LLM_STRONG_SIDE_ODDS,
                    )
                    review_reason = (
                        "LLM consensus completed for the active position."
                        if not rules_fail_reason
                        else (
                            "LLM consensus completed for the active position, but rule parsing "
                            f"remained incomplete because {rules_fail_reason.rstrip('.')}."
                        )
                    )
                    stage_results.append(
                        build_stage_result(
                            stage_number=3,
                            status="warning"
                            if rules_fail_reason
                            or llm_consensus.disagreement_level in {"Medium", "High"}
                            else "pass",
                            reason=review_reason,
                            outputs={
                                "fair_yes_probability_pct": llm_consensus.fair_yes_probability_pct,
                                "fair_no_probability_pct": llm_consensus.fair_no_probability_pct,
                                "disagreement_level": llm_consensus.disagreement_level,
                                "disagreement_category": llm_consensus.disagreement_category,
                                "adjudication_required": llm_consensus.adjudication_required,
                                "confidence": llm_consensus.confidence,
                                "evidence_status": llm_consensus.evidence_status,
                                "event_state": llm_consensus.event_state,
                                "rules_fail_reason": rules_fail_reason,
                            },
                        )
                    )
                    active_position_contexts.append(
                        {
                            "source_kind": "active_position",
                            "position_key": f"{position.market_id}::{position.side}",
                            "position_side": position.side,
                            "market": market,
                            "returns_per_day": returns_per_day,
                            "rules": rules,
                            "llm_outputs": llm_outputs,
                            "llm_consensus": llm_consensus,
                            "stage_results": stage_results,
                            "qualified": False,
                            "selected_side": selected_side,
                            "reason": review_reason,
                        }
                    )
                    report_llm_stage_progress(
                        phase_status="running",
                        reason=(
                            f"Stage 2 reviewed {index} of {llm_candidate_count} events. Latest: {market.question}"
                        ),
                        completed_items=index,
                        last_completed_market=market,
                        reviewed_contexts=[*active_position_contexts, *candidate_contexts],
                        completed_at=None,
                    )
                    continue
                stage_results = [
                    build_stage_result(
                        stage_number=1,
                        status="pass",
                        reason="Candidate passed the console scan filters.",
                        outputs={
                            "question": market.question,
                            "market_url": market.market_url,
                            "slug": market.slug,
                            "close_time": market.close_time,
                            "current_no_odds": market.current_no_odds,
                            "returns_per_day": returns_per_day,
                        },
                    )
                ]
                rules = evaluate_market_rules(market, now=now)
                rules_fail_reason = rules.fail_reason
                selected_for_auto_invest = market.market_id in selected_manual_candidate_id_set
                selected_required = manual_console_rows_used and bool(selected_manual_candidate_id_set)
                stage_results.append(
                    build_stage_result(
                        stage_number=2,
                        status="warning" if rules_fail_reason else "pass",
                        reason=(
                            "Resolution criteria and deadline were parsed successfully."
                            if not rules_fail_reason
                            else (
                                f"{rules_fail_reason} LLM consensus still ran, but this event "
                                "stayed blocked from Stage 3 qualification."
                            )
                        ),
                        outputs={
                            "close_time": market.close_time,
                            "yes_definition": rules.yes_definition,
                            "deadline_et": rules.deadline_et,
                            "hours_remaining": rules.hours_remaining,
                            "rules_fail_reason": rules_fail_reason,
                            "selected": selected_for_auto_invest,
                            "selected_required": selected_required,
                        },
                        hard_block=False,
                    )
                )

                evidence_packet = build_evidence_packet(market, rules, built_at=utc_now_iso())
                llm_outputs, llm_consensus = run_llm_consensus(market, rules, evidence_packet)
                fair_no = llm_consensus.fair_no_probability_pct
                selected_side, strongest_llm_odds = _stronger_probability_side(
                    yes_probability=llm_consensus.fair_yes_probability_pct,
                    no_probability=fair_no,
                    minimum_probability=CONSOLE_MIN_LLM_STRONG_SIDE_ODDS,
                )
                qualified_by_thresholds = bool(
                    selected_side is not None
                    and returns_per_day is not None
                )
                qualified = qualified_by_thresholds and not rules_fail_reason
                stage_results.append(
                    build_stage_result(
                        stage_number=3,
                        status="warning"
                        if rules_fail_reason
                        or llm_consensus.disagreement_level in {"Medium", "High"}
                        else "pass",
                        reason=(
                            "LLM consensus completed for the candidate market."
                            if not rules_fail_reason
                            else (
                                f"LLM consensus completed; rules parsing noted "
                                f"{rules_fail_reason.rstrip('.')} for review."
                            )
                        ),
                        outputs={
                            "fair_yes_probability_pct": llm_consensus.fair_yes_probability_pct,
                            "fair_no_probability_pct": fair_no,
                            "disagreement_level": llm_consensus.disagreement_level,
                            "adjudication_required": llm_consensus.adjudication_required,
                            "confidence": llm_consensus.confidence,
                            "evidence_status": llm_consensus.evidence_status,
                            "event_state": llm_consensus.event_state,
                            "rules_fail_reason": rules_fail_reason,
                        },
                    )
                )
                qualification_reason = (
                    "Candidate qualifies for the Events to invest in table."
                    if qualified
                    else (
                        "Candidate did not pass the Events to invest in table thresholds."
                        if not rules_fail_reason
                        else (
                            "LLM consensus completed, but the market is still blocked because "
                            f"{rules_fail_reason.rstrip('.')}."
                        )
                    )
                )
                stage_results.append(
                    build_stage_result(
                        stage_number=4,
                        status="pass" if qualified else "warning",
                        reason=qualification_reason,
                        outputs={
                            "returns_per_day": returns_per_day,
                            "selected_side": selected_side,
                            "strongest_llm_odds": strongest_llm_odds,
                            "fair_yes_probability_pct": llm_consensus.fair_yes_probability_pct,
                            "fair_no_probability_pct": fair_no,
                            "min_strongest_llm_odds": CONSOLE_MIN_LLM_STRONG_SIDE_ODDS,
                            "rules_fail_reason": rules_fail_reason,
                        },
                        hard_block=not qualified,
                    )
                )
                if not qualified:
                    _record_rejected_candidate(
                        rejected_candidate_map,
                        market=market,
                        reason=qualification_reason,
                    )
                candidate_contexts.append(
                    {
                        "source_kind": "candidate",
                        "market": market,
                        "returns_per_day": returns_per_day,
                        "rules": rules,
                        "llm_outputs": llm_outputs,
                        "llm_consensus": llm_consensus,
                        "stage_results": stage_results,
                        "qualified": qualified,
                        "selected_for_auto_invest": selected_for_auto_invest,
                        "selected_side": selected_side,
                        "reason": qualification_reason,
                    }
                )
                report_llm_stage_progress(
                    phase_status="running",
                    reason=(
                        f"Stage 2 reviewed {index} of {llm_candidate_count} events. Latest: {market.question}"
                    ),
                    completed_items=index,
                    last_completed_market=market,
                    reviewed_contexts=[*active_position_contexts, *candidate_contexts],
                    completed_at=None,
                )

        qualifying_candidates = [
            context
            for context in candidate_contexts
            if bool(context["qualified"])
        ]
        llm_stage_candidates = [
            _serialize_llm_review_context(context)
            for context in [*active_position_contexts, *candidate_contexts]
        ]
        set_run_stage_result(
            run,
            build_workflow_stage_result(
                stage_number=2,
                workflow_stage_key="llm",
                phase_status="completed",
                status="pass" if llm_candidate_count > 0 else "warning",
                reason=(
                    (
                        "LLM review completed for "
                        f"{llm_candidate_count} events from {stage1_accepted_candidate_count} "
                        f"Stage 1 candidates and {len(active_position_contexts)} active positions."
                    )
                    if llm_candidate_count > 0 and len(active_position_contexts) > 0
                    else f"LLM review completed for {llm_candidate_count} events from {stage1_accepted_candidate_count} Stage 1 candidates."
                    if llm_candidate_count > 0
                    else "Stage 2 had no candidate events to review."
                ),
                completed_items=llm_candidate_count,
                total_items=llm_candidate_count,
                item_label="events",
                outputs={
                    "scan_source_label": scan_source_label,
                    "scan_source_url": scan_source_url,
                    "used_manual_console_rows": manual_console_rows_used,
                    "stage1_accepted_candidate_count": stage1_accepted_candidate_count,
                    "active_position_rows_before_llm": active_position_rows_before_llm,
                    "active_position_rows_reviewed": len(active_position_contexts),
                    "candidate_rows_before_llm": candidate_rows_before_llm,
                    "llm_candidate_count": llm_candidate_count,
                    "llm_candidate_count_before_cap": llm_candidate_count_before_cap if "llm_candidate_count_before_cap" in locals() else llm_candidate_count,
                    "max_llm_candidates_per_run": max_llm_candidates if "max_llm_candidates" in locals() else settings.max_llm_candidates_per_run,
                    "llm_candidates_skipped_by_cap": len(skipped_llm_markets) if "skipped_llm_markets" in locals() else 0,
                    "fresh_llm_candidate_cap": fresh_llm_candidate_cap if "fresh_llm_candidate_cap" in locals() else CONSOLE_FRESH_LLM_CANDIDATE_CAP,
                    "fresh_llm_candidate_count_before_cap": fresh_llm_candidate_count_before_cap if "fresh_llm_candidate_count_before_cap" in locals() else candidate_rows_before_llm,
                    "fresh_llm_candidates_skipped_by_cap": len(skipped_fresh_llm_markets) if "skipped_fresh_llm_markets" in locals() else 0,
                    "qualified_candidate_count": len(qualifying_candidates),
                    "qualified_candidate_market_ids": [
                        context["market"].market_id for context in qualifying_candidates
                    ],
                    "llm_reviewed_candidates": llm_stage_candidates,
                    "reused_existing_llm_outputs": manual_console_rows_have_reusable_llm,
                },
                guardrails_checked=global_guardrails,
                started_at=llm_stage_started_at if "llm_stage_started_at" in locals() else utc_now_iso(),
            ),
        )
        self._report_progress(progress_callback, run, state)
        active_rank_rows = []
        for position in enriched_wallet_positions:
            if position.is_claimable:
                active_rank_rows.append(
                    {
                        "kind": "redeem",
                        "key": f"{position.market_id}::{position.side}",
                        "market_id": position.market_id,
                        "returns_per_day": float("inf"),
                        "position": position,
                    }
                )
                continue
            returns_per_day = position_returns_per_day(position, now=now)
            if returns_per_day is None:
                continue
            active_rank_rows.append(
                {
                    "kind": "active",
                    "key": f"{position.market_id}::{position.side}",
                    "market_id": position.market_id,
                    "returns_per_day": returns_per_day,
                    "position": position,
                }
            )
        candidate_rank_rows = [
            {
                "kind": "candidate",
                "key": context["market"].market_id,
                "market_id": context["market"].market_id,
                "returns_per_day": context["returns_per_day"],
                "context": context,
            }
            for context in qualifying_candidates
        ]
        combined_rank_rows = sorted(
            [*active_rank_rows, *candidate_rank_rows],
            key=lambda row: (
                -float(row["returns_per_day"]),
                row["market_id"],
            ),
        )
        ranking_top_rows = combined_rank_rows[:CONSOLE_RANKED_EVENT_LIMIT]
        selected_qualified_candidate_market_ids = {
            str(context["market"].market_id)
            for context in qualifying_candidates
            if bool(context.get("selected_for_auto_invest"))
        }
        ranking_top_active_keys = {
            str(row["key"])
            for row in ranking_top_rows
            if row["kind"] == "active"
        }
        ranking_top_candidate_market_ids = {
            str(row["market_id"])
            for row in ranking_top_rows
            if row["kind"] == "candidate"
        }
        actionable_top_candidate_market_ids = (
            ranking_top_candidate_market_ids | selected_qualified_candidate_market_ids
        )
        top_rows = ranking_top_rows
        top_active_keys = ranking_top_active_keys
        top_candidate_market_ids = actionable_top_candidate_market_ids

        run.stage_results.append(
            build_stage_result(
                stage_number=6,
                status="pass",
                reason="Ranked active positions and new qualified candidates into the fixed top-10 table.",
                outputs={
                    "top_table_size": len(ranking_top_rows),
                    "active_rows_ranked": len(active_rank_rows),
                    "qualified_candidate_rows": len(candidate_rank_rows),
                    "top_candidate_market_ids": sorted(actionable_top_candidate_market_ids),
                    "ranked_top_candidate_market_ids": sorted(ranking_top_candidate_market_ids),
                    "selected_qualified_candidate_market_ids": sorted(selected_qualified_candidate_market_ids),
                    "top_active_keys": sorted(ranking_top_active_keys),
                    "rejected_candidates": [
                        diagnostic.model_dump(mode="json")
                        for diagnostic in rejected_candidate_map.values()
                    ],
                },
            )
        )
        run.diagnostics.live_wallet_positions = len(enriched_wallet_positions)
        run.diagnostics.active_wallet_positions = active_position_rows_before_llm
        run.diagnostics.scanned_candidates = scanned_total_candidates
        run.diagnostics.candidate_rows_before_llm = candidate_rows_before_llm
        run.diagnostics.llm_candidate_count = llm_candidate_count
        run.diagnostics.qualified_candidate_rows = len(candidate_rank_rows)
        run.diagnostics.top_candidate_market_ids = sorted(actionable_top_candidate_market_ids)
        run.diagnostics.rejected_candidates = list(rejected_candidate_map.values())
        run.diagnostics.scan_source_label = scan_source_label
        run.diagnostics.scan_source_url = scan_source_url
        run.diagnostics.used_manual_console_rows = manual_console_rows_used
        run.diagnostics.selected_manual_candidate_ids = selected_manual_candidate_ids

        invest_stage_started_at = utc_now_iso()
        total_decision_rows = (
            len(position_snapshots)
            + len(claimable_wallet_positions)
            + len(candidate_contexts)
        )
        decisions: list[BullpenAutoLiveDecision] = []
        processed_decision_rows = 0
        execution_pause_reason: str | None = None
        simulation_reason = _simulation_reason(settings)

        def _current_stage3_order_counts() -> dict[str, int]:
            sell_planned = 0
            sell_processed = 0
            sell_submitted = 0
            buy_planned = 0
            buy_processed = 0
            buy_submitted = 0
            event_exit_rows = 0
            ranking_llm_sell_planned = 0
            forced_exit_sell_planned = 0
            redeem_planned = 0
            redeem_processed = 0
            redeem_submitted = 0

            for current in decisions:
                if current.exit_state in {"EVENT_EXIT_PLANNED", "DUST_LOST"}:
                    event_exit_rows += 1
                order_plan = current.order_plan
                if order_plan is None:
                    continue
                is_redeem = order_plan.action == "redeem"
                is_sell = order_plan.action == "sell" or is_redeem
                if is_sell:
                    sell_planned += 1
                    if is_redeem:
                        redeem_planned += 1
                    strategies = {signal.strategy for signal in current.exit_signals}
                    if strategies & {
                        "OUTSIDE_TOP_10_RETURNS_DAY",
                        "LLM_OR_ODDS_FILTER_EXIT",
                    }:
                        ranking_llm_sell_planned += 1
                    if "CAPITAL_AWARE_FORCED_EXIT" in strategies:
                        forced_exit_sell_planned += 1
                else:
                    buy_planned += 1
                if order_plan.status != "planned":
                    if is_sell:
                        sell_processed += 1
                        if is_redeem:
                            redeem_processed += 1
                    else:
                        buy_processed += 1
                if order_plan.status == "submitted":
                    if is_sell:
                        sell_submitted += 1
                        if is_redeem:
                            redeem_submitted += 1
                    else:
                        buy_submitted += 1

            return {
                "sell_planned": sell_planned,
                "sell_processed": sell_processed,
                "sell_submitted": sell_submitted,
                "event_exit_rows": event_exit_rows,
                "ranking_llm_sell_planned": ranking_llm_sell_planned,
                "forced_exit_sell_planned": forced_exit_sell_planned,
                "redeem_planned": redeem_planned,
                "redeem_processed": redeem_processed,
                "redeem_submitted": redeem_submitted,
                "buy_planned": buy_planned,
                "buy_processed": buy_processed,
                "buy_submitted": buy_submitted,
                # Aggregate order metrics are used by the Stage 3 tile to show
                # invest/sell order execution progress. Redeem/claim rows are
                # surfaced in the Step 1-specific metrics below, but they should
                # not inflate the headline planned/processed/submitted counts for
                # the Stage 3 investment pass. A resolved claimable position can
                # exist alongside seven new buys; the tile should still report the
                # seven investment orders as 7 processed / 7 submitted while Step
                # 1 shows the redeem/claim row separately.
                "planned": (sell_planned - redeem_planned) + buy_planned,
                "processed": (sell_processed - redeem_processed) + buy_processed,
                "submitted": (sell_submitted - redeem_submitted) + buy_submitted,
            }

        def _build_stage3_execution_steps(
            *,
            current_step_key: str | None,
            current_step_detail: str | None,
            execution_gate_reason: str | None,
            execution_mode_reason: str | None,
        ) -> tuple[dict[str, int], list[dict[str, object]]]:
            counts = _current_stage3_order_counts()
            sell_planned = counts["sell_planned"]
            sell_processed = counts["sell_processed"]
            sell_submitted = counts["sell_submitted"]
            buy_planned = counts["buy_planned"]
            buy_processed = counts["buy_processed"]
            buy_submitted = counts["buy_submitted"]

            steps: list[dict[str, object]] = []
            is_sell_step_complete = sell_processed >= sell_planned

            if sell_planned == 0:
                sell_status = "completed"
                sell_detail = "No executable Step 1 Event Exits were needed."
            elif is_sell_step_complete:
                sell_status = "completed"
                sell_detail = "Step 1 finished processing the Event Exits list."
            elif current_step_key == "sell":
                if execution_gate_reason:
                    sell_status = "blocked"
                    sell_detail = execution_gate_reason
                elif execution_mode_reason:
                    sell_status = "running"
                    sell_detail = current_step_detail or (
                        "Simulation mode is reviewing the Step 1 Event Exits that would free capital."
                    )
                else:
                    sell_status = "running"
                    sell_detail = current_step_detail or (
                        "Processing the Step 1 Event Exits before new investments."
                    )
            elif execution_gate_reason:
                sell_status = "blocked"
                sell_detail = execution_gate_reason
            else:
                sell_status = "pending"
                sell_detail = "Step 1 will process Event Exits first."

            steps.append(
                {
                    "key": "sell",
                    "step_number": 1,
                    "step_total": 2,
                    "label": "Event Exits",
                    "status": sell_status,
                    "detail": sell_detail,
                    "planned_orders": sell_planned,
                    "processed_orders": sell_processed,
                    "submitted_orders": sell_submitted,
                    "event_exit_rows": counts["event_exit_rows"],
                    "ranking_llm_planned_orders": counts["ranking_llm_sell_planned"],
                    "forced_exit_planned_orders": counts["forced_exit_sell_planned"],
                    "redeem_planned_orders": counts["redeem_planned"],
                    "redeem_processed_orders": counts["redeem_processed"],
                    "redeem_submitted_orders": counts["redeem_submitted"],
                }
            )

            if buy_planned == 0:
                buy_status = "completed"
                buy_detail = "No Step 2 Stage 3 planned orders were created."
            elif buy_processed >= buy_planned:
                buy_status = "completed"
                buy_detail = "Step 2 finished processing the Stage 3 planned orders."
            elif current_step_key == "buy":
                if execution_gate_reason:
                    buy_status = "blocked"
                    buy_detail = execution_gate_reason
                elif execution_mode_reason:
                    buy_status = "running"
                    buy_detail = current_step_detail or (
                        "Simulation mode is reviewing the Step 2 Stage 3 planned orders."
                    )
                else:
                    buy_status = "running"
                    buy_detail = current_step_detail or (
                        "Investing in the Step 2 Stage 3 planned orders."
                    )
            elif not is_sell_step_complete and sell_planned > 0:
                buy_status = "pending"
                buy_detail = (
                    "Step 2 is waiting for Step 1 Event Exits to free capital before buying."
                )
            elif execution_gate_reason:
                buy_status = "blocked"
                buy_detail = execution_gate_reason
            else:
                buy_status = "pending"
                buy_detail = (
                    "Step 2 will invest in the Stage 3 planned orders after Step 1 is clear."
                )

            steps.append(
                {
                    "key": "buy",
                    "step_number": 2,
                    "step_total": 2,
                    "label": "Invest planned orders",
                    "status": buy_status,
                    "detail": buy_detail,
                    "planned_orders": buy_planned,
                    "processed_orders": buy_processed,
                    "submitted_orders": buy_submitted,
                }
            )

            return counts, steps

        def report_invest_stage_progress(
            *,
            phase_status: str,
            reason: str,
            completed_items: int,
            last_completed_market: ScannedMarket | None = None,
            execution_gate_reason: str | None = None,
            execution_mode_reason: str | None = None,
            current_step_key: str | None = None,
            current_step_detail: str | None = None,
            completed_at: str | None | object = _DEFAULT_COMPLETED_AT,
        ) -> None:
            counts, execution_steps = _build_stage3_execution_steps(
                current_step_key=current_step_key,
                current_step_detail=current_step_detail,
                execution_gate_reason=execution_gate_reason,
                execution_mode_reason=execution_mode_reason,
            )
            stage_outputs: dict[str, object] = {
                "top_table_size": len(top_rows),
                "active_rows_ranked": len(active_rank_rows),
                "qualified_candidate_rows": len(candidate_rank_rows),
                "top_candidate_market_ids": sorted(top_candidate_market_ids),
                "top_active_keys": sorted(top_active_keys),
                "active_position_rows": len(position_snapshots),
                "candidate_decision_rows": len(candidate_contexts),
                "decisions_count": len(decisions),
                "orders_planned": counts["planned"],
                "orders_submitted": counts["submitted"],
                "orders_processed": counts["processed"],
                "event_exit_rows": counts["event_exit_rows"],
                "event_exit_planned": counts["sell_planned"],
                "event_exit_processed": counts["sell_processed"],
                "event_exit_submitted": counts["sell_submitted"],
                "event_exit_ranking_llm_planned": counts["ranking_llm_sell_planned"],
                "event_exit_forced_planned": counts["forced_exit_sell_planned"],
                "redeem_planned": counts["redeem_planned"],
                "redeem_processed": counts["redeem_processed"],
                "redeem_submitted": counts["redeem_submitted"],
                "sell_orders_planned": counts["sell_planned"],
                "sell_orders_processed": counts["sell_processed"],
                "sell_orders_submitted": counts["sell_submitted"],
                "buy_orders_planned": counts["buy_planned"],
                "buy_orders_processed": counts["buy_processed"],
                "buy_orders_submitted": counts["buy_submitted"],
                "execution_steps": execution_steps,
                "execution_step_key": current_step_key,
                "execution_step_label": (
                    "Step 1 · Event Exits"
                    if current_step_key == "sell"
                    else "Step 2 · Invest planned orders"
                    if current_step_key == "buy"
                    else None
                ),
                "execution_step_number": (
                    1 if current_step_key == "sell" else 2 if current_step_key == "buy" else None
                ),
                "execution_step_total": 2,
                "execution_step_detail": current_step_detail,
                "decision_rows": [
                    _serialize_stage3_decision_row(decision) for decision in decisions
                ],
            }
            if execution_gate_reason:
                stage_outputs["execution_gate_reason"] = execution_gate_reason
            if execution_mode_reason:
                stage_outputs["execution_mode_reason"] = execution_mode_reason
            if last_completed_market is not None:
                stage_outputs["last_completed_market_id"] = last_completed_market.market_id
                stage_outputs["last_completed_question"] = last_completed_market.question
                stage_outputs["last_completed_market_url"] = last_completed_market.market_url
            run.decisions_count = len(decisions)
            run.orders_planned = counts["planned"]
            run.orders_submitted = counts["submitted"]
            set_run_stage_result(
                run,
                build_workflow_stage_result(
                    stage_number=3,
                    workflow_stage_key="invest",
                    phase_status=phase_status,
                    status="pass" if total_decision_rows > 0 else "warning",
                    reason=reason,
                    completed_items=completed_items,
                    total_items=total_decision_rows,
                    item_label="rows",
                    outputs=stage_outputs,
                    guardrails_checked=global_guardrails,
                    started_at=invest_stage_started_at,
                    completed_at=completed_at,
                ),
            )
            self._report_progress(progress_callback, run, state)

        def record_invest_decision(
            decision: BullpenAutoLiveDecision,
            *,
            market: ScannedMarket,
        ) -> None:
            nonlocal processed_decision_rows
            decisions.append(decision)
            processed_decision_rows += 1
            report_invest_stage_progress(
                phase_status="running",
                reason=(
                    f"Stage 3 reviewed row {processed_decision_rows} of "
                    f"{total_decision_rows}. Latest: {market.question}"
                ),
                completed_items=processed_decision_rows,
                last_completed_market=market,
                execution_mode_reason=simulation_reason if state.dry_run else None,
                completed_at=None,
            )

        def _build_decision(
            *,
            market: ScannedMarket,
            decision_action: str,
            reason: str,
            stage_results: list[BullpenAutoLiveStageResult],
            current_position: PositionSnapshot | None = None,
            side_to_trade: str | None = None,
            current_exposure_usd: float = 0,
            target_exposure_usd: float = 0,
            order_usd: float = 0,
            order_shares: float = 0,
            llm_outputs: list[BullpenAutoLiveLlmOutput] | None = None,
            llm_consensus: LlmConsensus | None = None,
            exit_signals: list[ExitSignal] | None = None,
            exit_state: str = "ACTIVE",
            include_order_plan: bool = True,
        ) -> BullpenAutoLiveDecision:
            fair_no = llm_consensus.fair_no_probability_pct if llm_consensus else None
            fair_yes = llm_consensus.fair_yes_probability_pct if llm_consensus else None
            confidence = normalize_auto_live_confidence(
                llm_consensus.confidence if llm_consensus else None,
            )
            evidence_status = normalize_auto_live_evidence_status(
                llm_consensus.evidence_status if llm_consensus else None,
            )
            normalized_side_to_trade = (
                side_to_trade if _is_supported_outcome_side(side_to_trade) else None
            )
            side = (
                normalized_side_to_trade
                if decision_action == "BUY_NEW"
                else current_position.side
                if current_position is not None
                else normalized_side_to_trade or "NO"
            )
            price_cents = _current_price_for_side(
                market,
                side if decision_action == "BUY_NEW" else current_position.side if current_position else side,
            )
            if decision_action == "EXIT" and current_position is not None:
                executable_bid = _held_best_bid_for_side(
                    held_side=current_position.side,
                    best_bid_cents=current_position.best_bid_cents,
                    best_ask_cents=current_position.best_ask_cents,
                    fallback_probability=_probability_from_percent(price_cents),
                )
                if executable_bid is not None:
                    price_cents = round(executable_bid * 100, 2)
            fair_probability_pct = (
                fair_yes
                if side == "YES"
                else fair_no
                if side == "NO"
                else fair_no or fair_yes or 0
            )
            edge_pp = (
                round((fair_probability_pct or 0) - (price_cents or 0), 2)
                if decision_action == "BUY_NEW"
                else 0
            )
            order_plan = None
            if include_order_plan and decision_action in {"BUY_NEW", "EXIT"}:
                order_plan = BullpenAutoLiveOrderPlan(
                    id=_auto_live_record_id(
                        "order",
                        run_id=run.id,
                        market_id=market.market_id,
                        action=decision_action,
                    ),
                    action="buy" if decision_action == "BUY_NEW" else "sell",
                    side=side,  # type: ignore[arg-type]
                    market_id=market.market_id,
                    market_title=market.question,
                    order_size_usd=round(order_usd, 2),
                    shares=round(order_shares, 6),
                    limit_price_cents=round(price_cents or 0, 2),
                    max_slippage_cents=settings.max_slippage_cents,
                    dry_run=state.dry_run,
                    detail="Order planned but not executed yet.",
                    created_at=utc_now_iso(),
                )

            return BullpenAutoLiveDecision(
                id=_auto_live_record_id(
                    "decision",
                    run_id=run.id,
                    market_id=market.market_id,
                    action=decision_action,
                ),
                run_id=run.id,
                created_at=utc_now_iso(),
                updated_at=utc_now_iso(),
                market_id=market.market_id,
                market_title=market.question,
                market_url=market.market_url,
                slug=market.slug,
                close_time=market.close_time,
                theme=market.theme,
                side=side,  # type: ignore[arg-type]
                decision=decision_action,  # type: ignore[arg-type]
                risk_status="Ready" if decision_action in {"BUY_NEW", "EXIT"} else "Watch",
                price_cents=round(price_cents or 0, 2),
                current_yes_odds=market.current_yes_odds,
                current_no_odds=market.current_no_odds,
                fair_probability_pct=round(fair_probability_pct or 0, 2),
                fair_yes_probability_pct=fair_yes,
                fair_no_probability_pct=fair_no,
                edge_pp=edge_pp,
                score=round(
                    order_usd if decision_action == "BUY_NEW" else current_exposure_usd,
                    2,
                ),
                confidence=confidence,
                evidence_status=evidence_status,
                event_state=llm_consensus.event_state if llm_consensus else None,
                adjudication_required=llm_consensus.adjudication_required if llm_consensus else False,
                disagreement_level=llm_consensus.disagreement_level if llm_consensus else None,
                disagreement_category=llm_consensus.disagreement_category if llm_consensus else None,
                current_exposure_usd=round(current_exposure_usd, 2),
                target_exposure_usd=round(target_exposure_usd, 2),
                realized_pnl_usd=None,
                hours_remaining=None,
                key_evidence=[
                    item
                    for output in (llm_outputs or [])
                    for item in output.key_evidence[:2]
                ][:4],
                red_flags=[
                    item
                    for output in (llm_outputs or [])
                    for item in output.red_flags[:2]
                ][:4],
                rationale=next(
                    (output.rationale for output in (llm_outputs or []) if output.rationale),
                    None,
                ),
                reason=reason,
                summary=reason,
                order_plan=order_plan,
            exit_signals=[
                signal.model_dump(mode="json") if hasattr(signal, "model_dump") else signal
                for signal in (exit_signals or [])
            ],
                exit_state=exit_state,  # type: ignore[arg-type]
                llm_outputs=llm_outputs or [],
                stage_results=stage_results,
                guardrail_checks=global_guardrails,
            )

        active_review_context_by_key = {
            str(context["position_key"]): context
            for context in active_position_contexts
            if context.get("position_key") is not None
        }
        active_position_market_ids = {
            snapshot.market_id for snapshot in position_snapshots if snapshot.market_id
        }
        position_snapshot_by_key = {
            f"{snapshot.market_id}::{snapshot.side}": snapshot
            for snapshot in position_snapshots
        }
        evaluated_active_positions: list[dict[str, object]] = []

        for position in enriched_wallet_positions:
            if position.is_claimable:
                continue
            returns_per_day = position_returns_per_day(position, now=now)
            key = f"{position.market_id}::{position.side}"
            review_context = active_review_context_by_key.get(key)
            market = (
                review_context["market"]
                if review_context and isinstance(review_context.get("market"), ScannedMarket)
                else _active_position_market(
                    position,
                    market_by_slug=market_by_slug,
                    market_by_id=market_by_id,
                )
            )
            stage_results = (
                list(review_context["stage_results"])
                if review_context and isinstance(review_context.get("stage_results"), list)
                else [
                    build_stage_result(
                        stage_number=1,
                        status="pass",
                        reason="Live wallet position was included in the top-10 ranking review.",
                        outputs={
                            "side": position.side,
                            "shares": position.shares,
                            "close_time": position.close_time,
                            "returns_per_day": returns_per_day,
                        },
                    )
                ]
            )
            llm_outputs = (
                review_context["llm_outputs"]
                if review_context and isinstance(review_context.get("llm_outputs"), list)
                else None
            )
            llm_consensus = (
                review_context["llm_consensus"]
                if review_context and review_context.get("llm_consensus") is not None
                else None
            )
            current_position = position_snapshot_by_key.get(key)
            if current_position is not None:
                current_position.market_url = market.market_url or current_position.market_url
                current_position.close_time = market.close_time or current_position.close_time
                current_position.current_yes_odds = (
                    market.current_yes_odds
                    if market.current_yes_odds is not None
                    else current_position.current_yes_odds
                )
                current_position.current_no_odds = (
                    market.current_no_odds
                    if market.current_no_odds is not None
                    else current_position.current_no_odds
                )
                current_position.best_bid_cents = (
                    market.best_bid_cents
                    if market.best_bid_cents is not None
                    else current_position.best_bid_cents
                )
                current_position.best_ask_cents = (
                    market.best_ask_cents
                    if market.best_ask_cents is not None
                    else current_position.best_ask_cents
                )

            if returns_per_day is not None and current_position is not None:
                selected_side = (
                    review_context.get("selected_side")
                    if review_context and isinstance(review_context.get("selected_side"), str)
                    else None
                )
                if selected_side is None and llm_consensus is not None:
                    selected_side, _ = _stronger_probability_side(
                        yes_probability=llm_consensus.fair_yes_probability_pct,
                        no_probability=llm_consensus.fair_no_probability_pct,
                        minimum_probability=CONSOLE_MIN_LLM_STRONG_SIDE_ODDS,
                    )

                current_yes_probability = _probability_from_percent(
                    current_position.current_yes_odds
                )
                current_no_probability = _probability_from_percent(
                    current_position.current_no_odds
                )
                held_probability = _held_probability_for_side(
                    held_side=current_position.side,
                    yes_probability=current_yes_probability,
                    no_probability=current_no_probability,
                )
                adverse_probability = _held_probability_for_side(
                    held_side="NO" if current_position.side == "YES" else "YES",
                    yes_probability=current_yes_probability,
                    no_probability=current_no_probability,
                )
                held_best_bid = _held_best_bid_for_side(
                    held_side=current_position.side,
                    best_bid_cents=current_position.best_bid_cents,
                    best_ask_cents=current_position.best_ask_cents,
                    fallback_probability=held_probability,
                )
                llm_probability_held = _held_probability_for_side(
                    held_side=current_position.side,
                    yes_probability=_probability_from_percent(
                        llm_consensus.fair_yes_probability_pct if llm_consensus else None
                    ),
                    no_probability=_probability_from_percent(
                        llm_consensus.fair_no_probability_pct if llm_consensus else None
                    ),
                )
                event_exit_snapshot = EventExitSnapshot(
                    position_id=key,
                    market_id=position.market_id,
                    token_id=current_position.condition_id or key,
                    held_side=current_position.side,
                    shares=current_position.shares,
                    avg_price=round(current_position.average_price_cents / 100, 4),
                    current_yes_probability=current_yes_probability,
                    current_no_probability=current_no_probability,
                    held_best_bid=held_best_bid,
                    close_time=current_position.close_time,
                    llm_probability_held=llm_probability_held,
                )
                current_price_snapshot = build_position_price_snapshot(
                    event_exit_snapshot,
                    held_probability=held_probability,
                    adverse_probability=adverse_probability,
                    timestamp=now.isoformat(),
                )
                current_position.price_history = merge_price_history(
                    current_position.price_history,
                    current_price_snapshot,
                )
                exit_evaluation = evaluate_event_exits(
                    EventExitContext(
                        ranking=RankingAndLlmExitContext(
                            top_active_position_keys=ranking_top_active_keys,
                            current_position_key=key,
                            current_yes_probability=current_yes_probability,
                            current_no_probability=current_no_probability,
                            selected_side=selected_side,
                            held_side=current_position.side,
                            minimum_market_probability=CONSOLE_MIN_MARKET_ODDS / 100,
                            now=now,
                        ),
                        snapshot=event_exit_snapshot,
                        price_history=current_position.price_history,
                        config=DEFAULT_FORCED_EXIT_CONFIG,
                        now=now,
                    )
                )
                current_position.exit_signals = exit_evaluation.exit_signals
                current_position.exit_state = exit_evaluation.exit_state
                current_position.estimated_freeable_value_usd = _estimated_freeable_value(
                    shares=current_position.shares,
                    held_best_bid=held_best_bid,
                )

            evaluated_active_positions.append(
                {
                    "position": position,
                    "position_key": key,
                    "market": market,
                    "returns_per_day": returns_per_day,
                    "stage_results": stage_results,
                    "llm_outputs": llm_outputs,
                    "llm_consensus": llm_consensus,
                    "current_position": current_position,
                }
            )

        investable_active_rank_rows = [
            {
                "kind": "active",
                "key": entry["position_key"],
                "market_id": str(entry["position_key"]).split("::", 1)[0],
                "returns_per_day": entry["returns_per_day"],
                "position": entry["position"],
            }
            for entry in evaluated_active_positions
            if isinstance(entry.get("returns_per_day"), (int, float))
            and isinstance(entry.get("current_position"), PositionSnapshot)
            and entry["current_position"].exit_state not in {"EVENT_EXIT_PLANNED", "DUST_LOST"}
        ]
        top_rows = sorted(
            [*investable_active_rank_rows, *candidate_rank_rows],
            key=lambda row: (
                -float(row["returns_per_day"]),
                row["market_id"],
            ),
        )[:CONSOLE_RANKED_EVENT_LIMIT]
        top_active_keys = {
            str(row["key"])
            for row in top_rows
            if row["kind"] == "active"
        }
        top_candidate_market_ids = {
            str(row["market_id"])
            for row in top_rows
            if row["kind"] == "candidate"
        }
        run.diagnostics.top_candidate_market_ids = sorted(top_candidate_market_ids)

        report_invest_stage_progress(
            phase_status="running",
            reason=(
                "Stage 3 started. Step 1 will process Event Exits first, then Step 2 will invest in the remaining Stage 3 planned orders."
                if total_decision_rows > 0
                else "No candidate or position rows were available for Stage 3."
            ),
            completed_items=0,
            execution_mode_reason=simulation_reason if state.dry_run else None,
            completed_at=None,
        )

        for position in claimable_wallet_positions:
            market = _active_position_market(
                position,
                market_by_slug=market_by_slug,
                market_by_id=market_by_id,
            )
            current_position = PositionSnapshot(
                market_id=position.market_id,
                slug=position.slug,
                market_title=position.market_title,
                market_url=position.market_url,
                theme=position.theme,
                side=position.side,
                exposure_usd=position.exposure_usd,
                shares=position.shares,
                average_price_cents=position.average_price_cents,
                opened_at=now,
                updated_at=now,
                close_time=position.close_time,
                current_price_cents=position.current_price_cents,
                condition_id=position.condition_id,
                current_yes_odds=position.current_yes_odds,
                current_no_odds=position.current_no_odds,
                exit_state="REDEEM_CLAIM",
            )
            reason = (
                "Resolved winning Bullpen position is redeemable/claimable; "
                "Stage 2 LLM review is intentionally skipped and Stage 3 Step 1 will redeem/claim it."
            )
            stage_results = [
                build_stage_result(
                    stage_number=1,
                    status="pass",
                    reason="Live wallet position is active because it is redeemable/claimable.",
                    outputs={
                        "source_kind": "claimable_position",
                        "position_key": f"{position.market_id}::{position.side}",
                        "position_side": position.side,
                        "shares": position.shares,
                        "claimable": True,
                    },
                ),
                build_stage_result(
                    stage_number=2,
                    status="skipped",
                    reason="Redeemable/claimable positions skip Stage 2 LLM review.",
                    outputs={"claimable": True},
                ),
                build_stage_result(
                    stage_number=6,
                    status="pass",
                    reason=reason,
                    outputs={
                        "exit_state": "REDEEM_CLAIM",
                        "claimable": True,
                        "condition_id": position.condition_id,
                    },
                ),
            ]
            signal = ExitSignal(
                strategy="REDEEM_CLAIM",
                severity="IMMEDIATE_EXIT",
                reasonCode="RESOLVED_POSITION_CLAIMABLE",
                label="Redeem/claim resolved position",
                description=reason,
                score=100,
                createdAt=utc_now_iso(),
            )
            decision = _build_decision(
                market=market,
                decision_action="EXIT",
                reason=reason,
                stage_results=stage_results,
                current_position=current_position,
                current_exposure_usd=position.exposure_usd,
                target_exposure_usd=0,
                order_usd=position.exposure_usd,
                order_shares=position.shares,
                exit_signals=[signal],
                exit_state="REDEEM_CLAIM",
            )
            if decision.order_plan is not None:
                decision.order_plan.action = "redeem"  # type: ignore[assignment]
                decision.order_plan.detail = "Redeem/claim planned for resolved Bullpen position."
            record_invest_decision(decision, market=market)

        for entry in evaluated_active_positions:
            position = entry["position"]
            market = entry["market"]
            returns_per_day = entry["returns_per_day"]
            stage_results = entry["stage_results"]
            llm_outputs = entry["llm_outputs"]
            llm_consensus = entry["llm_consensus"]
            current_position = entry["current_position"]

            if not isinstance(position, ConsoleWalletPosition) or not isinstance(
                market,
                ScannedMarket,
            ):
                continue
            if not isinstance(stage_results, list):
                stage_results = []

            if returns_per_day is None or not isinstance(current_position, PositionSnapshot):
                stage_results.append(
                    build_stage_result(
                        stage_number=6,
                        status="warning",
                        reason="Position was left untouched because returns/day could not be computed safely.",
                    )
                )
                record_invest_decision(
                    _build_decision(
                        market=market,
                        decision_action="HOLD",
                        reason="Position was left untouched because returns/day could not be computed safely.",
                        stage_results=stage_results,
                        current_position=current_position,
                        current_exposure_usd=position.exposure_usd,
                        target_exposure_usd=position.exposure_usd,
                        llm_outputs=llm_outputs,
                        llm_consensus=llm_consensus,
                    ),
                    market=market,
                )
                continue

            exit_signals = current_position.exit_signals
            exit_labels = [signal.label for signal in exit_signals]
            exit_reason_codes = [signal.reasonCode for signal in exit_signals]
            estimated_freeable_value_usd = current_position.estimated_freeable_value_usd
            actionable_exit = (
                estimated_freeable_value_usd is not None
                and estimated_freeable_value_usd >= DEFAULT_FORCED_EXIT_CONFIG.min_net_proceeds
            )

            if current_position.exit_state == "DUST_LOST":
                reason = (
                    "Position is now treated as dust and removed from active investable positions."
                )
                if exit_signals:
                    reason = f"{_event_exit_reason(exit_signals, reason)}. {reason}"
                stage_results.append(
                    build_stage_result(
                        stage_number=6,
                        status="warning",
                        reason=reason,
                        outputs={
                            "returns_per_day": returns_per_day,
                            "exit_state": current_position.exit_state,
                            "estimated_freeable_value_usd": estimated_freeable_value_usd,
                            "exit_labels": exit_labels,
                            "exit_reason_codes": exit_reason_codes,
                        },
                    )
                )
                record_invest_decision(
                    _build_decision(
                        market=market,
                        decision_action="EXIT",
                        reason=reason,
                        stage_results=stage_results,
                        current_position=current_position,
                        current_exposure_usd=position.exposure_usd,
                        target_exposure_usd=0,
                        order_usd=0,
                        order_shares=position.shares,
                        llm_outputs=llm_outputs,
                        llm_consensus=llm_consensus,
                        exit_signals=exit_signals,
                        exit_state=current_position.exit_state,
                        include_order_plan=False,
                    ),
                    market=market,
                )
                continue

            if current_position.exit_state == "EVENT_EXIT_PLANNED":
                reason = (
                    "Position moved to Event Exits and will be processed before new investments."
                )
                if exit_signals:
                    reason = f"{_event_exit_reason(exit_signals, reason)}. {reason}"
                if not actionable_exit:
                    reason = (
                        f"{reason.rstrip('.')} It has no meaningful executable bid right now, so it "
                        "is tracked for exit without submitting a sell order yet."
                    )
                stage_results.append(
                    build_stage_result(
                        stage_number=6,
                        status="warning",
                        reason=reason,
                        outputs={
                            "returns_per_day": returns_per_day,
                            "exit_state": current_position.exit_state,
                            "estimated_freeable_value_usd": estimated_freeable_value_usd,
                            "exit_labels": exit_labels,
                            "exit_reason_codes": exit_reason_codes,
                        },
                    )
                )
                record_invest_decision(
                    _build_decision(
                        market=market,
                        decision_action="EXIT",
                        reason=reason,
                        stage_results=stage_results,
                        current_position=current_position,
                        current_exposure_usd=position.exposure_usd,
                        target_exposure_usd=0,
                        order_usd=estimated_freeable_value_usd or 0,
                        order_shares=position.shares,
                        llm_outputs=llm_outputs,
                        llm_consensus=llm_consensus,
                        exit_signals=exit_signals,
                        exit_state=current_position.exit_state,
                        include_order_plan=actionable_exit,
                    ),
                    market=market,
                )
                continue

            if current_position.exit_state == "WATCH_FAST":
                reason = (
                    "Position remains active but is flagged WATCH_FAST because the held-side odds are deteriorating quickly."
                )
                stage_results.append(
                    build_stage_result(
                        stage_number=6,
                        status="warning",
                        reason=reason,
                        outputs={
                            "returns_per_day": returns_per_day,
                            "exit_state": current_position.exit_state,
                            "estimated_freeable_value_usd": estimated_freeable_value_usd,
                            "exit_labels": exit_labels,
                            "exit_reason_codes": exit_reason_codes,
                        },
                    )
                )
                record_invest_decision(
                    _build_decision(
                        market=market,
                        decision_action="HOLD",
                        reason=reason,
                        stage_results=stage_results,
                        current_position=current_position,
                        current_exposure_usd=position.exposure_usd,
                        target_exposure_usd=position.exposure_usd,
                        llm_outputs=llm_outputs,
                        llm_consensus=llm_consensus,
                        exit_signals=exit_signals,
                        exit_state=current_position.exit_state,
                    ),
                    market=market,
                )
                continue

            if entry["position_key"] in top_active_keys:
                stage_results.append(
                    build_stage_result(
                        stage_number=6,
                        status="pass",
                        reason="Active position remains inside the top-10 returns/day table after Event Exit evaluation.",
                        outputs={"returns_per_day": returns_per_day},
                    )
                )
                record_invest_decision(
                    _build_decision(
                        market=market,
                        decision_action="HOLD",
                        reason="Active position remains inside the top-10 returns/day table after Event Exit evaluation.",
                        stage_results=stage_results,
                        current_position=current_position,
                        current_exposure_usd=position.exposure_usd,
                        target_exposure_usd=position.exposure_usd,
                        llm_outputs=llm_outputs,
                        llm_consensus=llm_consensus,
                    ),
                    market=market,
                )
                continue

            stage_results.append(
                build_stage_result(
                    stage_number=6,
                    status="pass",
                    reason="Active position remains active after Event Exit evaluation.",
                    outputs={"returns_per_day": returns_per_day},
                )
            )
            record_invest_decision(
                _build_decision(
                    market=market,
                    decision_action="HOLD",
                    reason="Active position remains active after Event Exit evaluation.",
                    stage_results=stage_results,
                    current_position=current_position,
                    current_exposure_usd=position.exposure_usd,
                    target_exposure_usd=position.exposure_usd,
                    llm_outputs=llm_outputs,
                    llm_consensus=llm_consensus,
                    exit_signals=exit_signals,
                    exit_state=current_position.exit_state,
                ),
                market=market,
            )

        for context in candidate_contexts:
            market = context["market"]
            returns_per_day = context["returns_per_day"]
            stage_results = list(context["stage_results"])
            llm_outputs = context["llm_outputs"]
            llm_consensus = context["llm_consensus"]
            if market.market_id in active_position_market_ids:
                skip_reason = (
                    "Candidate already has an active Bullpen position and will not be bought again."
                )
                _record_rejected_candidate(
                    rejected_candidate_map,
                    market=market,
                    reason=skip_reason,
                )
                stage_results.append(
                    build_stage_result(
                        stage_number=6,
                        status="pass",
                        reason=skip_reason,
                        outputs={"returns_per_day": returns_per_day},
                    )
                )
                record_invest_decision(
                    _build_decision(
                        market=market,
                        decision_action="SKIP",
                        reason=skip_reason,
                        stage_results=stage_results,
                        side_to_trade=context.get("selected_side"),
                        llm_outputs=llm_outputs,
                        llm_consensus=llm_consensus,
                    ),
                    market=market,
                )
                continue
            if not context["qualified"]:
                _record_rejected_candidate(
                    rejected_candidate_map,
                    market=market,
                    reason=str(context["reason"]),
                )
                stage_results.append(
                    build_stage_result(
                        stage_number=6,
                        status="warning",
                        reason=str(context["reason"]),
                        hard_block=True,
                    )
                )
                record_invest_decision(
                    _build_decision(
                        market=market,
                        decision_action="SKIP",
                        reason=str(context["reason"]),
                        stage_results=stage_results,
                        side_to_trade=context.get("selected_side"),
                        llm_outputs=llm_outputs,
                        llm_consensus=llm_consensus,
                    ),
                    market=market,
                )
                continue
            if market.market_id not in top_candidate_market_ids:
                _record_rejected_candidate(
                    rejected_candidate_map,
                    market=market,
                    reason="Candidate qualified but did not make the top-10 returns/day table.",
                )
                stage_results.append(
                    build_stage_result(
                        stage_number=6,
                        status="warning",
                        reason="Candidate qualified but did not make the top-10 returns/day table.",
                        outputs={"returns_per_day": returns_per_day},
                        hard_block=True,
                    )
                )
                record_invest_decision(
                    _build_decision(
                        market=market,
                        decision_action="SKIP",
                        reason="Candidate qualified but did not make the top-10 returns/day table.",
                        stage_results=stage_results,
                        side_to_trade=context.get("selected_side"),
                        llm_outputs=llm_outputs,
                        llm_consensus=llm_consensus,
                    ),
                    market=market,
                )
                continue
            stage_results.append(
                build_stage_result(
                    stage_number=5,
                    status="pass",
                    reason=(
                        "New opportunity receives the saved "
                        f"${saved_console_order_usd:g} order size."
                    ),
                    outputs={"order_usd": saved_console_order_usd},
                )
            )
            stage_results.append(
                build_stage_result(
                    stage_number=6,
                    status="pass",
                    reason="Qualified candidate ranked inside the top-10 returns/day table.",
                    outputs={"returns_per_day": returns_per_day},
                )
            )
            record_invest_decision(
                _build_decision(
                    market=market,
                    decision_action="BUY_NEW",
                    reason="Qualified candidate ranked inside the top-10 returns/day table.",
                    stage_results=stage_results,
                    side_to_trade=context.get("selected_side"),
                    current_exposure_usd=0,
                    target_exposure_usd=saved_console_order_usd,
                    order_usd=saved_console_order_usd,
                    llm_outputs=llm_outputs,
                    llm_consensus=llm_consensus,
                ),
                market=market,
            )

        sell_execution_decisions = [
            decision
            for decision in decisions
            if (
                decision.order_plan is not None
                and decision.order_plan.action in {"sell", "redeem"}
            )
        ]
        buy_execution_decisions = [
            decision
            for decision in decisions
            if decision.order_plan is not None and decision.order_plan.action == "buy"
        ]
        actionable_decisions = [*sell_execution_decisions, *buy_execution_decisions]
        planned_order_counts = _current_stage3_order_counts()
        planned_orders = planned_order_counts["planned"]
        sell_planned_orders = planned_order_counts["sell_planned"]
        buy_planned_orders = planned_order_counts["buy_planned"]
        execution_block_reasons: list[str] = []
        if actionable_decisions and not state.dry_run:
            live_controls = await refresh_live_controls(user_id=user_id)
            state.doctor_status = "pass" if live_controls.doctor.ok else "fail"
            state.balance_status = "pass" if live_controls.balance.status == "ready" else "fail"
            state.emergency_stopped = settings.emergency_stop or live_controls.emergency_stopped
            if settings.emergency_stop or live_controls.emergency_stopped:
                execution_block_reasons.append("Emergency stop is active.")
            if not live_controls.unlocked:
                execution_block_reasons.append(
                    live_controls.locked_reason or "Live execution is locked."
                )
            if not live_controls.doctor.ok:
                execution_block_reasons.append(
                    live_controls.doctor.message or "Bullpen doctor failed."
                )
            if live_controls.balance.status != "ready":
                execution_block_reasons.append(
                    live_controls.balance.message or "Bullpen balance is unavailable."
                )
            if execution_block_reasons:
                execution_pause_reason = "; ".join(execution_block_reasons)
                if live_controls.balance.status != "ready" and settings.pause_if_balance_unavailable:
                    state.paused = True
                if not live_controls.doctor.ok and settings.pause_if_doctor_fails:
                    state.paused = True
        if actionable_decisions:
            if state.dry_run:
                preparation_reason = (
                    f"Stage 3 reviewed all {total_decision_rows} rows and is staying in "
                    "simulation mode while it walks Step 1 Event Exits and Step 2 planned buys."
                )
            elif execution_pause_reason:
                preparation_reason = (
                    f"Stage 3 reviewed all {total_decision_rows} rows, but live execution "
                    "is currently gated before Step 1 can start."
                )
            elif sell_planned_orders > 0 and buy_planned_orders > 0:
                preparation_reason = (
                    f"Stage 3 reviewed all {total_decision_rows} rows. Step 1 will process "
                    f"{sell_planned_orders} Event Exit order{'s' if sell_planned_orders != 1 else ''} "
                    f"so capital becomes free, then Step 2 will buy {buy_planned_orders} Stage 3 planned "
                    f"order{'s' if buy_planned_orders != 1 else ''}."
                )
            elif sell_planned_orders > 0:
                preparation_reason = (
                    f"Stage 3 reviewed all {total_decision_rows} rows. Step 1 will process "
                    f"{sell_planned_orders} Event Exit order{'s' if sell_planned_orders != 1 else ''}. No Step 2 buys are "
                    "planned."
                )
            else:
                preparation_reason = (
                    f"Stage 3 reviewed all {total_decision_rows} rows. No Step 1 Event Exits are "
                    f"needed, so Step 2 will buy {buy_planned_orders} Stage 3 planned "
                    f"order{'s' if buy_planned_orders != 1 else ''}."
                )
            report_invest_stage_progress(
                phase_status="running",
                reason=preparation_reason,
                completed_items=processed_decision_rows,
                execution_gate_reason=execution_pause_reason,
                execution_mode_reason=simulation_reason if state.dry_run else None,
                completed_at=None,
            )

        executor = bullpen_module.BullpenLiveExecutor()
        new_positions = position_snapshots[:]
        running_failed_orders = state.consecutive_failed_orders

        for decision in decisions:
            order_plan = decision.order_plan
            if order_plan is None:
                decision.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="skipped",
                        reason="No execution was needed for this row.",
                    )
                )

        def _stage3_step_number(step_key: str) -> int:
            return 1 if step_key == "sell" else 2

        def _stage3_step_counts(step_key: str) -> tuple[int, int, int]:
            counts = _current_stage3_order_counts()
            return (
                counts["sell_planned"] if step_key == "sell" else counts["buy_planned"],
                counts["sell_processed"] if step_key == "sell" else counts["buy_processed"],
                counts["sell_submitted"] if step_key == "sell" else counts["buy_submitted"],
            )

        async def _execute_actionable_decision(
            decision: BullpenAutoLiveDecision,
            *,
            step_key: str,
        ) -> None:
            nonlocal new_positions, running_failed_orders

            order_plan = decision.order_plan
            if order_plan is None:
                return

            step_number = _stage3_step_number(step_key)
            step_total_orders, step_processed_orders, _ = _stage3_step_counts(step_key)
            global_counts = _current_stage3_order_counts()
            pending_order_number = global_counts["processed"] + 1
            pending_step_order_number = step_processed_orders + 1
            action_label = (
                "redeem/claim"
                if order_plan.action == "redeem"
                else "sell"
                if step_key == "sell"
                else "buy"
            )
            in_flight_detail = (
                f"Step {step_number} of 2 is submitting {action_label} order "
                f"{pending_step_order_number} of {step_total_orders}."
            )
            order_plan.detail = in_flight_detail
            report_invest_stage_progress(
                phase_status="running",
                reason=(
                    f"Stage 3 Step {step_number} of 2 is submitting planned order "
                    f"{pending_order_number} of {planned_orders}. Latest: {decision.market_title}"
                ),
                completed_items=processed_decision_rows,
                execution_gate_reason=execution_pause_reason,
                execution_mode_reason=simulation_reason if state.dry_run else None,
                current_step_key=step_key,
                current_step_detail=in_flight_detail,
                completed_at=None,
            )

            if execution_pause_reason and not state.dry_run:
                order_plan.status = "failed"
                order_plan.detail = execution_pause_reason
                decision.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="fail",
                        reason=execution_pause_reason,
                        outputs=order_plan.model_dump(mode="json"),
                        hard_block=True,
                    )
                )
                running_failed_orders += 1
                _, step_processed, _ = _stage3_step_counts(step_key)
                report_invest_stage_progress(
                    phase_status="running",
                    reason=(
                        f"Stage 3 Step {step_number} of 2 blocked {step_processed} of "
                        f"{step_total_orders} {'sell' if step_key == 'sell' else 'buy'} "
                        f"orders. Latest: {decision.market_title}"
                    ),
                    completed_items=processed_decision_rows,
                    execution_gate_reason=execution_pause_reason,
                    current_step_key=step_key,
                    current_step_detail=execution_pause_reason,
                    completed_at=None,
                )
                return

            if order_plan.action == "redeem":
                if state.dry_run:
                    order_plan.status = "skipped"
                    order_plan.detail = f"Simulation only: {simulation_reason}"
                else:
                    try:
                        stage_condition_ids = [
                            str(stage.outputs.get("condition_id"))
                            for stage in decision.stage_results
                            if stage.outputs.get("condition_id")
                        ]
                        condition_ids = [
                            condition_id
                            for condition_id in (
                                *stage_condition_ids,
                                order_plan.market_id,
                                decision.market_id,
                            )
                            if condition_id
                        ][:1]
                        order_plan.execution_response = await asyncio.wait_for(
                            executor.redeem(dry_run=False, condition_ids=condition_ids),
                            timeout=BULLPEN_ORDER_SUBMISSION_TIMEOUT_SECONDS,
                        )
                        claim = getattr(executor, "claim", None)
                        if claim is not None:
                            try:
                                claim_response = await asyncio.wait_for(
                                    claim(dry_run=False),
                                    timeout=BULLPEN_ORDER_SUBMISSION_TIMEOUT_SECONDS,
                                )
                            except Exception as claim_exc:
                                claim_response = (
                                    "Bullpen claim follow-up did not complete after redeem "
                                    f"was submitted: {claim_exc}"
                                )
                            if claim_response:
                                order_plan.execution_response = (
                                    f"{order_plan.execution_response}\n{claim_response}"
                                    if order_plan.execution_response
                                    else claim_response
                                )
                        order_plan.status = "submitted"
                        order_plan.executed_at = utc_now_iso()
                        order_plan.detail = "Bullpen redeem/claim submitted successfully."
                        running_failed_orders = 0
                    except Exception as exc:
                        order_plan.status = "failed"
                        order_plan.detail = str(exc)
                        running_failed_orders += 1
                decision.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status=(
                            "pass"
                            if order_plan.status == "submitted"
                            else "skipped"
                            if state.dry_run
                            else "fail"
                        ),
                        reason=order_plan.detail,
                        outputs=order_plan.model_dump(mode="json"),
                        hard_block=order_plan.status == "failed",
                    )
                )
                _, step_processed, step_submitted = _stage3_step_counts(step_key)
                report_invest_stage_progress(
                    phase_status="running",
                    reason=(
                        f"Stage 3 Step {step_number} of 2 submitted {step_submitted} of "
                        f"{step_total_orders} redeem/claim orders. Latest: {decision.market_title}"
                        if order_plan.status == "submitted"
                        else f"Stage 3 Step {step_number} of 2 processed {step_processed} of "
                        f"{step_total_orders} redeem/claim orders. Latest: {decision.market_title}"
                    ),
                    completed_items=processed_decision_rows,
                    execution_gate_reason=execution_pause_reason,
                    execution_mode_reason=simulation_reason if state.dry_run else None,
                    current_step_key=step_key,
                    current_step_detail=order_plan.detail,
                    completed_at=None,
                )
                return

            quote_price_cents = order_plan.limit_price_cents
            if not state.dry_run:
                quote = await refresh_execution_quote(slug=decision.slug, side=order_plan.side)
                quote_price_cents = quote.current_price_cents or order_plan.limit_price_cents
                if (
                    order_plan.action != "sell"
                    and quote.spread_cents is not None
                    and quote.spread_cents > settings.max_bid_ask_spread_cents
                ):
                    order_plan.status = "skipped"
                    order_plan.detail = "Bid/ask spread exceeds the configured maximum."
                    decision.stage_results.append(
                        build_stage_result(
                            stage_number=7,
                            status="fail",
                            reason=order_plan.detail,
                            outputs=order_plan.model_dump(mode="json"),
                            hard_block=True,
                        )
                    )
                    running_failed_orders += 1
                    _, step_processed, _ = _stage3_step_counts(step_key)
                    report_invest_stage_progress(
                        phase_status="running",
                        reason=(
                            f"Stage 3 Step {step_number} of 2 processed {step_processed} of "
                            f"{step_total_orders} {'sell' if step_key == 'sell' else 'buy'} "
                            f"orders. Latest: {decision.market_title}"
                        ),
                        completed_items=processed_decision_rows,
                        execution_gate_reason=execution_pause_reason,
                        execution_mode_reason=simulation_reason if state.dry_run else None,
                        current_step_key=step_key,
                        current_step_detail=order_plan.detail,
                        completed_at=None,
                    )
                    return

                if order_plan.action == "buy":
                    order_plan.limit_price_cents = buy_limit_price_cents(
                        current_price_cents=quote_price_cents,
                        original_price_cents=order_plan.limit_price_cents or quote_price_cents,
                        max_slippage_cents=settings.max_slippage_cents,
                    )
                    order_plan.shares = round(
                        order_plan.order_size_usd
                        / max(0.01, cents_to_decimal(order_plan.limit_price_cents)),
                        6,
                    )
                else:
                    # Console-profile exits should reduce risk immediately even
                    # when the book is wide. Use the minimum allowed limit as a
                    # marketable sell fallback instead of skipping the exit.
                    order_plan.limit_price_cents = 1
                order_plan.refreshed_market_price_cents = quote_price_cents

            if (
                order_plan.action == "sell"
                and order_plan.shares <= 0
            ):
                order_plan.status = "skipped"
                order_plan.detail = "Exit is tracked, but no shares are available to sell."
                decision.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="skipped",
                        reason=order_plan.detail,
                        outputs=order_plan.model_dump(mode="json"),
                    )
                )
                _, step_processed, _ = _stage3_step_counts(step_key)
                report_invest_stage_progress(
                    phase_status="running",
                    reason=(
                        f"Stage 3 Step {step_number} of 2 processed {step_processed} of "
                        f"{step_total_orders} {'sell' if step_key == 'sell' else 'buy'} "
                        f"orders. Latest: {decision.market_title}"
                    ),
                    completed_items=processed_decision_rows,
                    execution_gate_reason=execution_pause_reason,
                    execution_mode_reason=simulation_reason if state.dry_run else None,
                    current_step_key=step_key,
                    current_step_detail=order_plan.detail,
                    completed_at=None,
                )
                return

            if state.dry_run:
                order_plan.status = "skipped"
                order_plan.detail = f"Simulation only: {simulation_reason}"
                decision.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="skipped",
                        reason=order_plan.detail,
                        outputs=order_plan.model_dump(mode="json"),
                    )
                )
                _, step_processed, _ = _stage3_step_counts(step_key)
                report_invest_stage_progress(
                    phase_status="running",
                    reason=(
                        f"Stage 3 Step {step_number} of 2 simulated {step_processed} of "
                        f"{step_total_orders} {'sell' if step_key == 'sell' else 'buy'} "
                        f"orders. Latest: {decision.market_title}"
                    ),
                    completed_items=processed_decision_rows,
                    execution_mode_reason=simulation_reason,
                    current_step_key=step_key,
                    current_step_detail=order_plan.detail,
                    completed_at=None,
                )
                return

            trade_analysis_reference = f"auto-live-order:{order_plan.id}"
            refreshed_market = quote.market
            current_position_snapshot = next(
                (
                    position
                    for position in new_positions
                    if position.market_id == decision.market_id
                    and position.side == order_plan.side
                ),
                None,
            )
            event_snapshot = _trade_analysis_event_snapshot_from_decision(
                decision,
                refreshed_market,
            )
            market_snapshot = _trade_analysis_market_snapshot_from_decision(
                decision,
                refreshed_market,
            )
            order_book_snapshot = _trade_analysis_order_book_snapshot_from_decision(
                decision,
                refreshed_market,
                quote_price_cents=quote_price_cents,
                limit_price_cents=order_plan.limit_price_cents,
            )
            positions_snapshot = _trade_analysis_position_snapshot(current_position_snapshot)
            exit_type = _trade_analysis_exit_type_from_signals(decision.exit_signals)
            if order_plan.action == "buy":
                buy_context = _trade_analysis_buy_context_from_decision(
                    run_id=run.id,
                    settings=settings,
                    decision=decision,
                    order_plan=order_plan,
                    market_snapshot=market_snapshot,
                    event_snapshot=event_snapshot,
                    order_book_snapshot=order_book_snapshot,
                    positions_snapshot=positions_snapshot,
                )
                buy_context["captured_at"] = utc_now_iso()
                _safe_trade_analysis_capture(
                    "auto-live stage3 buy pre-submit",
                    capture_auto_live_buy_pre_submit_sync,
                    user_id=user_id,
                    entry_reference=trade_analysis_reference,
                    context=buy_context,
                )
            else:
                exit_context = _trade_analysis_exit_context_from_decision(
                    decision=decision,
                    order_plan=order_plan,
                    market_snapshot=market_snapshot,
                    event_snapshot=event_snapshot,
                    order_book_snapshot=order_book_snapshot,
                    positions_snapshot=positions_snapshot,
                )
                exit_context["captured_at"] = utc_now_iso()
                exit_context["exit_type"] = exit_type
                _safe_trade_analysis_capture(
                    "auto-live stage3 exit pre-submit",
                    capture_auto_live_exit_pre_submit_sync,
                    user_id=user_id,
                    exit_reference=trade_analysis_reference,
                    context=exit_context,
                )

            try:
                market_id_for_execution = decision.slug or decision.market_id
                if order_plan.action == "buy":
                    order_plan.execution_response = await asyncio.wait_for(
                        executor.buy_limit(
                            market_id=market_id_for_execution,
                            outcome="Yes" if order_plan.side == "YES" else "No",
                            amount_usd=order_plan.order_size_usd,
                            max_price=cents_to_decimal(order_plan.limit_price_cents),
                        ),
                        timeout=BULLPEN_ORDER_SUBMISSION_TIMEOUT_SECONDS,
                    )
                    new_positions.append(
                        PositionSnapshot(
                            market_id=decision.market_id,
                            slug=decision.slug,
                            market_title=decision.market_title,
                            market_url=decision.market_url,
                            theme=decision.theme,
                            side=order_plan.side,
                            exposure_usd=round(order_plan.order_size_usd, 2),
                            shares=round(order_plan.shares, 6),
                            average_price_cents=order_plan.limit_price_cents,
                            opened_at=now,
                            updated_at=now,
                            close_time=decision.close_time,
                            current_price_cents=order_plan.limit_price_cents,
                            current_yes_odds=decision.current_yes_odds,
                            current_no_odds=decision.current_no_odds,
                            best_bid_cents=(
                                order_plan.limit_price_cents if order_plan.side == "YES" else None
                            ),
                            best_ask_cents=(
                                round(100 - order_plan.limit_price_cents, 2)
                                if order_plan.side == "NO"
                                else None
                            ),
                            exit_signals=[],
                            exit_state="ACTIVE",
                        )
                    )
                else:
                    order_plan.execution_response = await asyncio.wait_for(
                        executor.sell_limit(
                            market_id=market_id_for_execution,
                            outcome="Yes" if order_plan.side == "YES" else "No",
                            shares=order_plan.shares,
                            min_price=cents_to_decimal(order_plan.limit_price_cents),
                            max_reprice_attempts=settings.max_reprice_attempts,
                        ),
                        timeout=BULLPEN_ORDER_SUBMISSION_TIMEOUT_SECONDS,
                    )
                    new_positions = [
                        position
                        for position in new_positions
                        if not (
                            position.market_id == decision.market_id
                            and position.side == order_plan.side
                        )
                    ]
                order_plan.status = "submitted"
                order_plan.executed_at = utc_now_iso()
                order_plan.detail = "Limit order submitted successfully."
                decision.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="pass",
                        reason=order_plan.detail,
                        outputs=order_plan.model_dump(mode="json"),
                    )
                )
                running_failed_orders = 0
                if order_plan.action == "buy":
                    _safe_trade_analysis_capture(
                        "auto-live stage3 buy execution",
                        capture_auto_live_buy_result_sync,
                        user_id=user_id,
                        entry_reference=trade_analysis_reference,
                        raw_execution_response=order_plan.execution_response,
                    )
                else:
                    _safe_trade_analysis_capture(
                        "auto-live stage3 exit execution",
                        capture_auto_live_exit_result_sync,
                        user_id=user_id,
                        exit_reference=trade_analysis_reference,
                        market_id=decision.market_id,
                        outcome_name=order_plan.side,
                        title=decision.market_title,
                        raw_execution_response=order_plan.execution_response,
                        exit_type=exit_type,
                        sell_reason=decision.reason,
                    )
            except TimeoutError:
                order_plan.status = "failed"
                order_plan.detail = (
                    f"Bullpen order submission timed out after "
                    f"{BULLPEN_ORDER_SUBMISSION_TIMEOUT_SECONDS} seconds. "
                    "The worker will continue with the next planned order and surface this row in the progress log."
                )
                decision.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="fail",
                        reason=order_plan.detail,
                        outputs=order_plan.model_dump(mode="json"),
                        hard_block=True,
                    )
                )
                running_failed_orders += 1
                if order_plan.action == "buy":
                    _safe_trade_analysis_capture(
                        "auto-live stage3 buy timeout",
                        capture_auto_live_buy_result_sync,
                        user_id=user_id,
                        entry_reference=trade_analysis_reference,
                        raw_execution_response=None,
                        failed=True,
                        failure_reason=order_plan.detail,
                    )
                else:
                    _safe_trade_analysis_capture(
                        "auto-live stage3 exit timeout",
                        capture_auto_live_exit_result_sync,
                        user_id=user_id,
                        exit_reference=trade_analysis_reference,
                        market_id=decision.market_id,
                        outcome_name=order_plan.side,
                        title=decision.market_title,
                        raw_execution_response=None,
                        exit_type=exit_type,
                        failed=True,
                        failure_reason=order_plan.detail,
                        sell_reason=decision.reason,
                    )
            except Exception as exc:
                order_plan.status = "failed"
                order_plan.detail = str(exc)
                decision.stage_results.append(
                    build_stage_result(
                        stage_number=7,
                        status="fail",
                        reason=order_plan.detail,
                        outputs=order_plan.model_dump(mode="json"),
                        hard_block=True,
                    )
                )
                running_failed_orders += 1
                if order_plan.action == "buy":
                    _safe_trade_analysis_capture(
                        "auto-live stage3 buy failure",
                        capture_auto_live_buy_result_sync,
                        user_id=user_id,
                        entry_reference=trade_analysis_reference,
                        raw_execution_response=None,
                        failed=True,
                        failure_reason=order_plan.detail,
                    )
                else:
                    _safe_trade_analysis_capture(
                        "auto-live stage3 exit failure",
                        capture_auto_live_exit_result_sync,
                        user_id=user_id,
                        exit_reference=trade_analysis_reference,
                        market_id=decision.market_id,
                        outcome_name=order_plan.side,
                        title=decision.market_title,
                        raw_execution_response=None,
                        exit_type=exit_type,
                        failed=True,
                        failure_reason=order_plan.detail,
                        sell_reason=decision.reason,
                    )

            _, step_processed, step_submitted = _stage3_step_counts(step_key)
            report_invest_stage_progress(
                phase_status="running",
                reason=(
                    f"Stage 3 Step {step_number} of 2 submitted {step_submitted} of "
                    f"{step_total_orders} {'sell' if step_key == 'sell' else 'buy'} orders. "
                    f"Latest: {decision.market_title}"
                    if order_plan.status == "submitted"
                    else (
                        f"Stage 3 Step {step_number} of 2 processed {step_processed} of "
                        f"{step_total_orders} {'sell' if step_key == 'sell' else 'buy'} "
                        f"orders. Latest: {decision.market_title}"
                    )
                ),
                completed_items=processed_decision_rows,
                execution_gate_reason=execution_pause_reason,
                current_step_key=step_key,
                current_step_detail=order_plan.detail,
                completed_at=None,
            )

        for decision in sell_execution_decisions:
            await _execute_actionable_decision(decision, step_key="sell")
        for decision in buy_execution_decisions:
            await _execute_actionable_decision(decision, step_key="buy")

        state.consecutive_failed_orders = running_failed_orders
        for decision in decisions:
            log_method = getattr(logger, _decision_log_level(decision))
            log_method(
                "Auto-Live console-profile decision user=%s run=%s market=%s action=%s order_status=%s dry_run=%s reason=%s",
                user_id,
                run.id,
                decision.market_id,
                decision.decision,
                decision.order_plan.status if decision.order_plan else "none",
                decision.order_plan.dry_run if decision.order_plan else state.dry_run,
                _decision_log_reason(decision),
            )

        historical_and_current_decisions = [*historical_decisions, *decisions]
        (
            state.today_executed_orders,
            state.today_skipped_orders,
        ) = _today_order_counts(historical_and_current_decisions, now=now)
        state.last_execution_at = _latest_execution_at(historical_and_current_decisions)
        final_order_counts, final_execution_steps = _build_stage3_execution_steps(
            current_step_key=None,
            current_step_detail=None,
            execution_gate_reason=execution_pause_reason,
            execution_mode_reason=simulation_reason if state.dry_run else None,
        )
        live_order_issues = _collect_live_order_issues(decisions)
        live_order_issue_count = len(live_order_issues)
        live_order_hard_failure_count = sum(
            1 for issue in live_order_issues if bool(issue.get("hard_failure"))
        )
        sell_order_issue_count = sum(
            1 for issue in live_order_issues if issue.get("action") == "sell"
        )
        buy_order_issue_count = sum(
            1 for issue in live_order_issues if issue.get("action") == "buy"
        )
        sell_order_hard_failure_count = sum(
            1
            for issue in live_order_issues
            if issue.get("action") == "sell" and bool(issue.get("hard_failure"))
        )
        buy_order_hard_failure_count = sum(
            1
            for issue in live_order_issues
            if issue.get("action") == "buy" and bool(issue.get("hard_failure"))
        )
        execution_issue_summary = _summarize_live_order_issues(
            live_order_issues,
            planned_orders=final_order_counts["planned"],
            submitted_orders=final_order_counts["submitted"],
        )
        degraded_live_run = bool(live_order_issues) and not state.dry_run
        run.decisions_count = len(decisions)
        run.decision_ids = [decision.id for decision in decisions]
        run.orders_planned = final_order_counts["planned"]
        run.orders_submitted = final_order_counts["submitted"]
        run.live_execution_requested = bool(
            actionable_decisions and live_execution_requested(settings)
        )
        run.live_execution_attempted = bool(actionable_decisions and not state.dry_run)
        run.completed_at = utc_now_iso()
        run.status = "failed" if state.paused or degraded_live_run else "completed"
        run.error_message = None
        run.diagnostics.rejected_candidates = list(rejected_candidate_map.values())
        run.request_context = None
        if state.dry_run:
            run.summary = (
                f"Console schedule simulated {len(decisions)} decisions with "
                f"{final_order_counts['planned']} planned orders. {simulation_reason}"
            )
        elif state.paused:
            run.summary = (
                execution_issue_summary
                or execution_pause_reason
                or "Console schedule paused."
            )
        elif degraded_live_run:
            run.summary = execution_issue_summary or (
                "Live execution did not submit every planned console-profile order."
            )
        else:
            run.summary = (
                f"Console schedule completed with {len(decisions)} decisions, "
                f"{final_order_counts['planned']} planned orders, and "
                f"{final_order_counts['submitted']} submitted orders."
            )
        set_run_stage_result(
            run,
            build_workflow_stage_result(
                stage_number=3,
                workflow_stage_key="invest",
                phase_status="completed",
                status=(
                    "fail"
                    if degraded_live_run
                    else "pass"
                    if len(decisions) > 0
                    else "warning"
                ),
                reason=(
                    execution_issue_summary
                    if degraded_live_run
                    else "Rebalance, Event Exit processing, and investment planning/execution finished for the ranked Bullpen table."
                    if len(decisions) > 0
                    else "Stage 3 finished without any decisions to process."
                ),
                completed_items=len(decisions),
                total_items=total_decision_rows,
                item_label="rows",
                outputs={
                    "top_table_size": len(top_rows),
                    "active_rows_ranked": len(active_rank_rows),
                    "qualified_candidate_rows": len(candidate_rank_rows),
                    "top_candidate_market_ids": sorted(top_candidate_market_ids),
                    "top_active_keys": sorted(top_active_keys),
                    "active_position_rows": active_position_rows_before_llm,
                    "claimable_position_rows": len(claimable_wallet_positions),
                    "candidate_decision_rows": len(candidate_contexts),
                    "decisions_count": len(decisions),
                    "orders_planned": final_order_counts["planned"],
                    "orders_submitted": final_order_counts["submitted"],
                    "orders_processed": final_order_counts["processed"],
                    "orders_failed": live_order_hard_failure_count,
                    "orders_unsubmitted": live_order_issue_count,
                    "sell_orders_planned": final_order_counts["sell_planned"],
                    "sell_orders_processed": final_order_counts["sell_processed"],
                    "sell_orders_submitted": final_order_counts["sell_submitted"],
                    "redeem_planned": final_order_counts["redeem_planned"],
                    "redeem_processed": final_order_counts["redeem_processed"],
                    "redeem_submitted": final_order_counts["redeem_submitted"],
                    "sell_orders_failed": sell_order_hard_failure_count,
                    "sell_orders_unsubmitted": sell_order_issue_count,
                    "buy_orders_planned": final_order_counts["buy_planned"],
                    "buy_orders_processed": final_order_counts["buy_processed"],
                    "buy_orders_submitted": final_order_counts["buy_submitted"],
                    "buy_orders_failed": buy_order_hard_failure_count,
                    "buy_orders_unsubmitted": buy_order_issue_count,
                    "execution_steps": final_execution_steps,
                    "execution_step_key": (
                        "blocked"
                        if actionable_decisions and state.paused
                        else "failed"
                        if degraded_live_run
                        else "completed"
                        if actionable_decisions
                        else None
                    ),
                    "execution_step_label": (
                        "Stage 3 blocked"
                        if actionable_decisions and state.paused
                        else "Stage 3 failed"
                        if degraded_live_run
                        else "Stage 3 complete"
                        if actionable_decisions
                        else None
                    ),
                    "execution_step_number": None,
                    "execution_step_total": 2,
                    "execution_step_detail": (
                        execution_issue_summary
                        if degraded_live_run
                        else execution_pause_reason
                        if actionable_decisions and state.paused
                        else "Step 1 Event Exits and Step 2 planned buys finished processing."
                        if actionable_decisions
                        else None
                    ),
                    "decision_rows": [
                        _serialize_stage3_decision_row(decision) for decision in decisions
                    ],
                    "execution_gate_reason": execution_pause_reason,
                    "execution_failure_message": execution_issue_summary,
                    "execution_mode_reason": simulation_reason if state.dry_run else None,
                    "order_issues": live_order_issues,
                    "decision_summaries": [
                        {
                            "market_id": decision.market_id,
                            "market_title": decision.market_title,
                            "decision": decision.decision,
                            "side": decision.side,
                            "target_exposure_usd": decision.target_exposure_usd,
                            "order_status": decision.order_plan.status
                            if decision.order_plan
                            else None,
                            "reason": decision.reason,
                        }
                        for decision in decisions
                    ],
                },
                guardrails_checked=global_guardrails,
                started_at=invest_stage_started_at,
                completed_at=run.completed_at,
            ),
        )

        state.last_run_id = run.id
        state.last_run_at = run.completed_at
        state.last_scan_at = run.completed_at
        state.last_llm_run_at = run.completed_at
        state.last_rebalance_at = run.completed_at
        state.last_error = None if run.status == "completed" else run.summary
        state.last_action = run.summary
        state.latest_guardrail_checks = global_guardrails
        state.live_execution_allowed = not execution_block_reasons and not state.paused and not state.dry_run
        if state.running:
            next_run_at = next_custom_console_schedule_time(now, start_at=settings.console_auto_start_at, refresh_minutes=settings.console_auto_refresh_minutes).isoformat()
            state.next_run_at = next_run_at
            state.next_scan_at = next_run_at
            state.next_llm_run_at = next_run_at
            state.next_rebalance_at = next_run_at
        else:
            state.next_run_at = None
            state.next_scan_at = None
            state.next_llm_run_at = None
            state.next_rebalance_at = None
        state.invested_usd = round(sum(position.exposure_usd for position in new_positions), 2)
        state.current_value_usd = round(sum(position.exposure_usd for position in new_positions), 2)
        state.pnl_usd = round(state.current_value_usd - state.invested_usd, 2)
        state.active_positions = _active_market_count(new_positions)
        state.trades_today = state.today_executed_orders

        return EngineResult(
            run=run,
            decisions=decisions,
            state=state,
            positions=new_positions,
        )

    def _apply_position_update(
        self,
        positions: list[PositionSnapshot],
        candidate: CandidateEvaluation,
        order_plan: BullpenAutoLiveOrderPlan,
    ) -> None:
        now = utc_now()
        if order_plan.action == "buy":
            existing = _same_side_position(positions, candidate.market.market_id, order_plan.side)
            if existing is None:
                positions.append(
                    PositionSnapshot(
                        market_id=candidate.market.market_id,
                        slug=candidate.market.slug,
                        market_title=candidate.market.question,
                        market_url=candidate.market.market_url,
                        theme=candidate.market.theme,
                        side=order_plan.side,
                        exposure_usd=round(order_plan.order_size_usd, 2),
                        shares=round(order_plan.shares, 6),
                        average_price_cents=order_plan.limit_price_cents,
                        opened_at=now,
                        updated_at=now,
                        close_time=candidate.market.close_time,
                        current_price_cents=order_plan.limit_price_cents,
                        current_yes_odds=candidate.market.current_yes_odds,
                        current_no_odds=candidate.market.current_no_odds,
                        best_bid_cents=(
                            order_plan.limit_price_cents if order_plan.side == "YES" else None
                        ),
                        best_ask_cents=(
                            round(100 - order_plan.limit_price_cents, 2)
                            if order_plan.side == "NO"
                            else None
                        ),
                        exit_signals=[],
                        exit_state="ACTIVE",
                    )
                )
                return
            total_shares = existing.shares + order_plan.shares
            total_cost = existing.exposure_usd + order_plan.order_size_usd
            existing.average_price_cents = round(
                (
                    (existing.average_price_cents * existing.shares)
                    + (order_plan.limit_price_cents * order_plan.shares)
                )
                / max(0.000001, total_shares),
                4,
            )
            existing.shares = round(total_shares, 6)
            existing.exposure_usd = round(total_cost, 2)
            existing.updated_at = now
            existing.close_time = candidate.market.close_time or existing.close_time
            existing.current_price_cents = order_plan.limit_price_cents
            existing.current_yes_odds = candidate.market.current_yes_odds
            existing.current_no_odds = candidate.market.current_no_odds
            existing.exit_signals = []
            existing.exit_state = "ACTIVE"
            existing.estimated_freeable_value_usd = None
            return

        current = candidate.current_position
        if current is None:
            return
        sell_shares = order_plan.shares or current.shares
        sell_ratio = min(1.0, sell_shares / max(0.000001, current.shares))
        realized_basis = current.exposure_usd * sell_ratio
        proceeds = order_plan.limit_price_cents / 100 * sell_shares
        candidate.realized_pnl_usd = round(proceeds - realized_basis, 2)
        current.shares = round(max(0.0, current.shares - sell_shares), 6)
        current.exposure_usd = round(max(0.0, current.exposure_usd - realized_basis), 2)
        current.updated_at = now
        current.exit_signals = []
        current.exit_state = "ACTIVE"
        current.estimated_freeable_value_usd = None
        positions[:] = [position for position in positions if position.shares > 0 and position.exposure_usd > 0]

    def _to_decision(self, run_id: str, candidate: CandidateEvaluation) -> BullpenAutoLiveDecision:
        summary = candidate.reason or "No summary available."
        side = candidate.side_to_trade or (
            candidate.current_position.side if candidate.current_position else "YES"
        )
        guardrail_checks = candidate.guardrail_checks[:]
        for index, reason in enumerate(candidate.hard_block_reasons):
            guardrail_checks.append(
                build_guardrail_check(
                    check_id=f"candidate-block-{index + 1}",
                    label="Candidate block",
                    status="fail",
                    detail=reason,
                    blocking=True,
                )
            )
        return BullpenAutoLiveDecision(
            id=_auto_live_record_id(
                "decision",
                run_id=run_id,
                market_id=candidate.market.market_id,
                action=candidate.decision_action,
            ),
            run_id=run_id,
            created_at=utc_now_iso(),
            updated_at=utc_now_iso(),
            market_id=candidate.market.market_id,
            market_title=candidate.market.question,
            market_url=candidate.market.market_url,
            slug=candidate.market.slug,
            close_time=candidate.market.close_time,
            theme=candidate.market.theme,
            side=side,  # type: ignore[arg-type]
            decision=candidate.decision_action,  # type: ignore[arg-type]
            risk_status=(
                "Blocked"
                if candidate.decision_action == "SKIP" and candidate.hard_block_reasons
                else "Ready"
                if candidate.decision_action in {"BUY_NEW", "ADD_MORE"}
                else "Watch"
            ),
            price_cents=round(candidate.market_price_percent or 0, 2),
            current_yes_odds=candidate.market.current_yes_odds,
            current_no_odds=candidate.market.current_no_odds,
            fair_probability_pct=round(candidate.fair_probability_percent or 0, 2),
            fair_yes_probability_pct=(
                candidate.llm_consensus.fair_yes_probability_pct if candidate.llm_consensus else None
            ),
            fair_no_probability_pct=(
                candidate.llm_consensus.fair_no_probability_pct if candidate.llm_consensus else None
            ),
            edge_pp=round(candidate.edge_pp, 2),
            score=round(candidate.score, 2),
            confidence=normalize_auto_live_confidence(candidate.confidence),
            evidence_status=normalize_auto_live_evidence_status(candidate.evidence_status),
            event_state=candidate.event_state,
            adjudication_required=(
                candidate.llm_consensus.adjudication_required if candidate.llm_consensus else False
            ),
            disagreement_level=candidate.disagreement_level,
            disagreement_category=candidate.disagreement_category,
            current_exposure_usd=round(candidate.current_exposure_usd, 2),
            target_exposure_usd=round(candidate.target_exposure_usd, 2),
            realized_pnl_usd=candidate.realized_pnl_usd,
            hours_remaining=candidate.rules.hours_remaining if candidate.rules else None,
            key_evidence=[
                item
                for output in candidate.llm_outputs
                for item in output.key_evidence[:2]
            ][:4],
            red_flags=[
                item
                for output in candidate.llm_outputs
                for item in output.red_flags[:2]
            ][:4],
            rationale=next(
                (output.rationale for output in candidate.llm_outputs if output.rationale),
                None,
            ),
            reason=candidate.reason or "Decision completed.",
            summary=summary,
            order_plan=candidate.order_plan,
            llm_outputs=candidate.llm_outputs,
            stage_results=candidate.stage_results,
            guardrail_checks=guardrail_checks,
        )
