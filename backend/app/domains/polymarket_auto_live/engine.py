from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from app.core.logging import get_logger
from app.domains.polymarket import bullpen as bullpen_module
from app.domains.polymarket_auto_live.config import auto_live_backend_allows_execution
from app.domains.polymarket_auto_live.evidence import EvidencePacket, build_evidence_packet
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
from app.domains.polymarket_auto_live.rules import RuleEvaluation, evaluate_market_rules
from app.domains.polymarket_auto_live.scanner import (
    ScanRejectedMarket,
    ScannedMarket,
    scan_candidate_markets,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveDecision,
    BullpenAutoLiveGuardrailCheck,
    BullpenAutoLiveOrderPlan,
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
DECISION_ACTIONABLES = {"BUY_NEW", "ADD_MORE", "TRIM", "EXIT"}
CONFIDENCE_WEIGHT = {"Low": 0.55, "Medium": 0.8, "High": 1.0}
EVIDENCE_WEIGHT = {"Low": 0.55, "Moderate": 0.8, "Strong": 1.0}
HIGH_LLM_PROVIDER_ERROR_RATE = 0.5

logger = get_logger("app.domains.polymarket_auto_live.engine")


def utc_now() -> datetime:
    return datetime.now(UTC)


def utc_now_iso() -> str:
    return utc_now().isoformat()


def round_money(value: float | None) -> float | None:
    if value is None:
        return None
    return round(value, 2)


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
    completed_at: str | None = None,
) -> BullpenAutoLiveStageResult:
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
        completed_at=completed_at or utc_now_iso(),
    )


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
            else "Backend environment blocks Auto-Live execution, so runs stay in simulation mode.",
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
            detail="Manual confirmation is still configured, but Auto-Live now relies on explicit live arming, dashboard unlock, and runtime health checks."
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


class BullpenAutoLiveEngine:
    async def execute(
        self,
        *,
        user_id: int,
        settings: BullpenAutoLiveSettings,
        state: BullpenAutoLiveState,
        run: BullpenAutoLiveRun,
        positions: list[PositionSnapshot],
        historical_decisions: list[BullpenAutoLiveDecision],
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
        run.stage_results.append(
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
            )
        )

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
            candidate.confidence = llm_consensus.confidence or "Low"
            candidate.evidence_status = llm_consensus.evidence_status or "Low"
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
                id=f"order-{candidate.market.market_id}-{candidate.decision_action.lower()}",
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
                quote.spread_cents is not None
                and quote.spread_cents > settings.max_bid_ask_spread_cents
            ):
                hard_block_reasons.append("Bid/ask spread exceeds the configured maximum.")
            if candidate.order_usd < settings.min_order_usd:
                hard_block_reasons.append("Order is below the minimum order size.")
            if candidate.order_usd > settings.max_order_usd:
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
            elif order_plan.action == "sell" and quote.current_price_cents is not None:
                original_price_cents = initial_price_cents or quote.current_price_cents
                if quote.current_price_cents < max(1, original_price_cents - settings.max_slippage_cents):
                    hard_block_reasons.append("Refreshed sell price exceeds the slippage cap.")
                refreshed_edge_pp = (
                    round(fair_probability_for_order_side - quote.current_price_cents, 2)
                    if fair_probability_for_order_side is not None
                    else None
                )
                if (
                    refreshed_edge_pp is not None
                    and candidate.execution_edge_threshold_pp is not None
                    and refreshed_edge_pp > candidate.execution_edge_threshold_pp
                ):
                    hard_block_reasons.append(
                        "Price moved enough to restore the edge, so the exit was skipped."
                    )
                order_plan.limit_price_cents = sell_limit_price_cents(
                    current_price_cents=quote.current_price_cents,
                    original_price_cents=original_price_cents,
                    max_slippage_cents=settings.max_slippage_cents,
                )
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
            except Exception as exc:
                order_plan.status = "failed"
                order_plan.detail = str(exc)
                candidate.order_plan = order_plan
                running_failed_orders += 1
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
            id=f"decision-{run_id}-{candidate.market.market_id}-{candidate.decision_action.lower()}",
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
            confidence=candidate.confidence,  # type: ignore[arg-type]
            evidence_status=candidate.evidence_status,  # type: ignore[arg-type]
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
