from __future__ import annotations

from collections import Counter
from typing import Any

from app.domains.bullpen_run_audit.constants import BULLPEN_RUN_AUDIT_RULE_VERSION


def _finding(
    *,
    code: str,
    severity: str,
    stage: str,
    category: str,
    title: str,
    explanation: str,
    observed_value: str | None = None,
    expected_value: str | None = None,
    blocking: bool = False,
    classification: str = "deterministic",
    suggested_remediation: str | None = None,
    evidence_pointers: list[object] | None = None,
    detection_metadata: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "rule_version": BULLPEN_RUN_AUDIT_RULE_VERSION,
        "code": code,
        "severity": severity,
        "stage": stage,
        "category": category,
        "title": title,
        "explanation": explanation,
        "observed_value": observed_value,
        "expected_value": expected_value,
        "blocking": blocking,
        "classification": classification,
        "suggested_remediation": suggested_remediation,
        "evidence_pointers": evidence_pointers or [],
        "detection_metadata": detection_metadata or {},
    }


def _float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _int(value: Any) -> int | None:
    numeric = _float(value)
    if numeric is None or not numeric.is_integer():
        return None
    return int(numeric)


def build_deterministic_findings(bundle: dict[str, Any]) -> list[dict[str, object]]:
    findings: list[dict[str, object]] = []
    metadata = bundle.get("metadata") if isinstance(bundle.get("metadata"), dict) else {}
    overview = bundle.get("overview") if isinstance(bundle.get("overview"), dict) else {}
    stage_1 = bundle.get("stage_1") if isinstance(bundle.get("stage_1"), dict) else {}
    stage_2 = bundle.get("stage_2") if isinstance(bundle.get("stage_2"), dict) else {}
    stage_3 = bundle.get("stage_3") if isinstance(bundle.get("stage_3"), dict) else {}
    raw = bundle.get("raw") if isinstance(bundle.get("raw"), dict) else {}

    started_at = overview.get("started_at")
    completed_at = overview.get("completed_at")
    duration_seconds = _float(overview.get("duration_seconds"))
    if not started_at:
        findings.append(
            _finding(
                code="RUN_STARTED_AT_MISSING",
                severity="critical",
                stage="overview",
                category="timestamps",
                title="Run start time is missing",
                explanation="The audit snapshot could not locate the run start timestamp.",
                blocking=True,
                suggested_remediation="Capture and persist started_at on every Bullpen run creation path.",
                evidence_pointers=["/overview/started_at"],
            )
        )
    if completed_at and duration_seconds is not None and duration_seconds < 0:
        findings.append(
            _finding(
                code="RUN_DURATION_NEGATIVE",
                severity="high",
                stage="overview",
                category="timestamps",
                title="Run duration is negative",
                explanation="The stored completion time precedes the run start time.",
                observed_value=str(duration_seconds),
                expected_value=">= 0",
                blocking=True,
                evidence_pointers=["/overview/duration_seconds"],
            )
        )

    code_provenance = overview.get("code_provenance")
    if not isinstance(code_provenance, dict) or not code_provenance.get("backend_commit_sha"):
        findings.append(
            _finding(
                code="CODE_PROVENANCE_MISSING",
                severity="high",
                stage="overview",
                category="provenance",
                title="Backend code provenance is missing",
                explanation="The audit snapshot could not identify the backend commit SHA that produced the run.",
                blocking=False,
                suggested_remediation="Capture backend commit, build identifiers, and Alembic revision at run start.",
                evidence_pointers=["/overview/code_provenance/backend_commit_sha"],
            )
        )

    missing_fields = overview.get("missing_fields")
    if isinstance(missing_fields, list) and missing_fields:
        findings.append(
            _finding(
                code="AUDIT_CAPTURE_GAP",
                severity="medium",
                stage="overview",
                category="completeness",
                title="Audit capture has missing fields",
                explanation="The snapshot is missing fields that were unavailable or not captured at source.",
                observed_value=str(len(missing_fields)),
                expected_value="0",
                evidence_pointers=["/overview/missing_fields"],
                detection_metadata={"missing_fields": missing_fields[:50]},
            )
        )

    verified_portfolio = (
        stage_1.get("verified_portfolio_snapshot")
        if isinstance(stage_1.get("verified_portfolio_snapshot"), dict)
        else {}
    )
    verified_positions = (
        verified_portfolio.get("active_positions_found")
        if isinstance(verified_portfolio.get("active_positions_found"), list)
        else []
    )
    if verified_portfolio:
        verified_count = len(verified_positions)
        recorded_count = _float(
            verified_portfolio.get("recorded_occupied_positions")
        )
        max_positions = _float(verified_portfolio.get("max_positions"))
        recorded_available_slots = _float(
            verified_portfolio.get("available_slots")
        )
        expected_available_slots = (
            max(0, int(max_positions) - verified_count)
            if max_positions is not None
            else None
        )
        if recorded_count is not None and int(recorded_count) != verified_count:
            findings.append(
                _finding(
                    code="STAGE1_VERIFIED_POSITION_COUNT_MISMATCH",
                    severity="high",
                    stage="stage-1",
                    category="portfolio-capacity",
                    title="Stage 1 occupied-position count contradicts its verified rows",
                    explanation=(
                        "The serialized active_positions_found rows are the verified "
                        "Stage 1 portfolio evidence, but the recorded sizing count differs."
                    ),
                    observed_value=str(int(recorded_count)),
                    expected_value=str(verified_count),
                    blocking=True,
                    evidence_pointers=[
                        "/stage_1/verified_portfolio_snapshot/active_positions_found",
                        "/stage_1/verified_portfolio_snapshot/recorded_occupied_positions",
                    ],
                )
            )
        if (
            expected_available_slots is not None
            and recorded_available_slots is not None
            and int(recorded_available_slots) != expected_available_slots
        ):
            findings.append(
                _finding(
                    code="STAGE1_VERIFIED_AVAILABLE_SLOTS_MISMATCH",
                    severity="high",
                    stage="stage-1",
                    category="portfolio-capacity",
                    title="Stage 1 available slots contradict verified active positions",
                    explanation=(
                        "Available slots must equal max positions minus the verified "
                        "active-position row count."
                    ),
                    observed_value=str(int(recorded_available_slots)),
                    expected_value=str(expected_available_slots),
                    blocking=True,
                    evidence_pointers=[
                        "/stage_1/verified_portfolio_snapshot/active_positions_found",
                        "/stage_1/verified_portfolio_snapshot/available_slots",
                        "/stage_1/verified_portfolio_snapshot/max_positions",
                    ],
                )
            )
        cash_in_hand = _float(verified_portfolio.get("cash_in_hand_usd"))
        recorded_trade_amount = _float(
            verified_portfolio.get("trade_amount_usd")
        )
        if (
            cash_in_hand is not None
            and expected_available_slots is not None
            and recorded_trade_amount is not None
        ):
            expected_trade_amount = (
                round(cash_in_hand / expected_available_slots, 2)
                if cash_in_hand > 0 and expected_available_slots > 0
                else 0.0
            )
            if abs(recorded_trade_amount - expected_trade_amount) > 0.001:
                findings.append(
                    _finding(
                        code="STAGE1_VERIFIED_TRADE_AMOUNT_MISMATCH",
                        severity="high",
                        stage="stage-1",
                        category="capital-sizing",
                        title="Stage 1 trade amount contradicts verified portfolio capacity",
                        explanation=(
                            "Trade amount per new opportunity must equal cash in hand "
                            "divided by the slots left after verified active positions."
                        ),
                        observed_value=f"{recorded_trade_amount:.2f}",
                        expected_value=f"{expected_trade_amount:.2f}",
                        blocking=True,
                        evidence_pointers=[
                            "/stage_1/verified_portfolio_snapshot/cash_in_hand_usd",
                            "/stage_1/verified_portfolio_snapshot/active_positions_found",
                            "/stage_1/verified_portfolio_snapshot/trade_amount_usd",
                        ],
                    )
                )

    candidate_reviews = (
        stage_2.get("candidate_reviews")
        if isinstance(stage_2.get("candidate_reviews"), list)
        else []
    )
    universe_status = (
        stage_2.get("universe_status")
        if isinstance(stage_2.get("universe_status"), dict)
        else {}
    )
    qualified_market_ids: set[str] = set()
    for index, review in enumerate(candidate_reviews):
        if not isinstance(review, dict):
            continue
        market_id = str(review.get("market_id") or review.get("position_key") or f"review-{index + 1}")
        if review.get("qualified"):
            qualified_market_ids.add(market_id)
        llm_outputs = review.get("llm_outputs") if isinstance(review.get("llm_outputs"), list) else []
        if review.get("source_kind") == "candidate" and not llm_outputs:
            findings.append(
                _finding(
                    code="STAGE2_CANDIDATE_WITHOUT_LLM_OUTPUT",
                    severity="high",
                    stage="stage-2",
                    category="llm-coverage",
                    title="Stage 2 candidate has no LLM outputs",
                    explanation="A candidate review exists in Stage 2, but no LLM outputs were persisted for it.",
                    blocking=True,
                    evidence_pointers=[f"/stage_2/candidate_reviews/{index}"],
                )
            )
        for output_index, output in enumerate(llm_outputs):
            if not isinstance(output, dict):
                continue
            yes = _float(output.get("llm_yes_odds"))
            no = _float(output.get("llm_no_odds"))
            if yes is not None and no is not None and abs((yes + no) - 100.0) > 1.0:
                findings.append(
                    _finding(
                        code="LLM_ODDS_SUM_INVALID",
                        severity="medium",
                        stage="stage-2",
                        category="llm-validation",
                        title="LLM YES and NO odds do not sum to 100",
                        explanation="A Stage 2 LLM output stored YES and NO odds outside the accepted tolerance.",
                        observed_value=f"{yes + no:.2f}",
                        expected_value="100 +/- 1",
                        evidence_pointers=[
                            f"/stage_2/candidate_reviews/{index}/llm_outputs/{output_index}"
                        ],
                    )
                )
            if output.get("rationale_odds_mismatch"):
                findings.append(
                    _finding(
                        code="RATIONALE_ODDS_DIRECTION_CONFLICT",
                        severity="medium",
                        stage="stage-2",
                        category="llm-validation",
                        title="LLM rationale conflicts with numeric direction",
                        explanation="The run recorded a rationale-versus-odds mismatch for a Stage 2 LLM output.",
                        evidence_pointers=[
                            f"/stage_2/candidate_reviews/{index}/llm_outputs/{output_index}"
                        ],
                    )
                )
            if output.get("error") or output.get("status") in {
                "provider_failed",
                "provider_unavailable",
                "timed_out",
            }:
                findings.append(
                    _finding(
                        code="LLM_PROVIDER_FAILURE",
                        severity="high",
                        stage="stage-2",
                        category="provider-failure",
                        title="LLM provider failed for a Stage 2 invocation",
                        explanation="A Stage 2 model invocation returned an explicit provider-side failure or timeout.",
                        evidence_pointers=[
                            f"/stage_2/candidate_reviews/{index}/llm_outputs/{output_index}"
                        ],
                    )
                )

    universe_is_complete = universe_status.get("is_complete")
    blocker_summary = str(universe_status.get("blocker_summary") or "").strip()
    blocker_fix = str(universe_status.get("blocker_fix") or "").strip()
    if universe_is_complete is False and (not blocker_summary or not blocker_fix):
        findings.append(
            _finding(
                code="INCOMPLETE_STAGE2_UNIVERSE_MISSING_REMEDIATION",
                severity="medium",
                stage="stage-2",
                category="llm-coverage",
                title="Incomplete Stage 2 universe is missing a stored cause or fix",
                explanation="Stage 2 marked the eligible universe incomplete, but the audit snapshot does not contain both a blocker summary and remediation step.",
                expected_value="blocker_summary and blocker_fix",
                evidence_pointers=["/stage_2/universe_status"],
            )
        )

    decisions = stage_3.get("decisions") if isinstance(stage_3.get("decisions"), list) else []
    stage3_market_ids: set[str] = set()
    decisions_by_market_id: dict[str, dict[str, Any]] = {}
    stage3_ranks: list[int] = []
    selected_count = 0
    blocked_without_reason = 0
    for index, decision in enumerate(decisions):
        if not isinstance(decision, dict):
            continue
        market_id = str(decision.get("market_id") or f"decision-{index + 1}")
        stage3_market_ids.add(market_id)
        decisions_by_market_id.setdefault(market_id, decision)
        final_rank = decision.get("stage3_final_rank")
        if isinstance(final_rank, int):
            stage3_ranks.append(final_rank)
        if decision.get("stage3_result") == "SELECTED":
            selected_count += 1
        if decision.get("stage3_result") == "BLOCKED" and not decision.get("stage3_result_reason"):
            blocked_without_reason += 1

    handoff_market_ids = {
        str(market_id)
        for market_id in (stage_2.get("stage3_handoff_candidate_market_ids") or [])
        if str(market_id or "").strip()
    }

    for market_id in sorted(qualified_market_ids - stage3_market_ids):
        findings.append(
            _finding(
                code="QUALIFIED_STAGE2_CANDIDATE_MISSING_STAGE3_RESULT",
                severity="high",
                stage="stage-3",
                category="handoff",
                title="Qualified Stage 2 candidate never received a Stage 3 result",
                explanation="A candidate was qualified in Stage 2 but never appeared in Stage 3 decisions.",
                evidence_pointers=[f"/stage_2/candidate_reviews/market:{market_id}"],
            )
        )

    for market_id in sorted(handoff_market_ids - stage3_market_ids):
        findings.append(
            _finding(
                code="STAGE2_TOP10_HANDOFF_MISSING_STAGE3_DECISION",
                severity="high",
                stage="stage-3",
                category="handoff",
                title="Stage 2 Top 10 handoff row never reached Stage 3",
                explanation="A persisted Stage 2 Top 10 handoff market never appeared in Stage 3 decisions.",
                evidence_pointers=[
                    f"/stage_2/stage3_handoff_candidate_market_ids/market:{market_id}",
                    "/stage_3/decisions",
                ],
            )
        )

    handoff_missing_reason = 0
    for market_id in sorted(handoff_market_ids & stage3_market_ids):
        decision = decisions_by_market_id.get(market_id) or {}
        order_plan = decision.get("order_plan") if isinstance(decision.get("order_plan"), dict) else {}
        has_buy_order_plan = str(order_plan.get("action") or "").strip().lower() == "buy"
        recorded_reason = str(
            decision.get("stage3_result_reason")
            or decision.get("summary")
            or decision.get("reason")
            or order_plan.get("detail")
            or ""
        ).strip()
        if not has_buy_order_plan and not recorded_reason:
            handoff_missing_reason += 1

    if handoff_missing_reason > 0:
        findings.append(
            _finding(
                code="STAGE2_TOP10_HANDOFF_MISSING_PLANNING_REASON",
                severity="medium",
                stage="stage-3",
                category="decision-recording",
                title="Stage 2 Top 10 handoff row is missing a planning blocker",
                explanation="At least one Stage 2 Top 10 handoff decision never became a buy plan and did not persist a reason.",
                observed_value=str(handoff_missing_reason),
                expected_value="0",
                evidence_pointers=[
                    "/stage_2/stage3_handoff_candidate_market_ids",
                    "/stage_3/decisions",
                ],
            )
        )

    if blocked_without_reason > 0:
        findings.append(
            _finding(
                code="BLOCKED_STAGE3_DECISION_WITHOUT_REASON",
                severity="medium",
                stage="stage-3",
                category="decision-recording",
                title="Blocked Stage 3 decision has no reason",
                explanation="At least one blocked decision is missing a stored reason.",
                observed_value=str(blocked_without_reason),
                expected_value="0",
                evidence_pointers=["/stage_3/decisions"],
            )
        )

    if stage3_ranks:
        rank_counter = Counter(stage3_ranks)
        duplicate_ranks = sorted(rank for rank, count in rank_counter.items() if count > 1)
        expected_rank_span = list(range(1, max(stage3_ranks) + 1))
        missing_ranks = sorted(set(expected_rank_span) - set(stage3_ranks))
        if duplicate_ranks or missing_ranks:
            findings.append(
                _finding(
                    code="STAGE3_FINAL_RANK_DUPLICATES_OR_GAPS",
                    severity="medium",
                    stage="stage-3",
                    category="ranking",
                    title="Stage 3 final ranks contain duplicates or gaps",
                    explanation="Stage 3 final ranks should form a deterministic, gap-free ordering.",
                    evidence_pointers=["/stage_3/decisions"],
                    detection_metadata={
                        "duplicate_ranks": duplicate_ranks,
                        "missing_ranks": missing_ranks,
                    },
                )
            )

    max_positions = _float(stage_3.get("max_positions"))
    if max_positions is not None and selected_count > int(max_positions):
        findings.append(
            _finding(
                code="SELECTION_EXCEEDS_MAX_POSITIONS",
                severity="high",
                stage="stage-3",
                category="constraints",
                title="Final selection count exceeds max positions",
                explanation="The snapshot shows more selected positions than the configured Stage 3 cap.",
                observed_value=str(selected_count),
                expected_value=f"<= {int(max_positions)}",
                evidence_pointers=["/stage_3/decisions", "/stage_3/max_positions"],
            )
        )

    slot_diagnostics = (
        stage_3.get("stage3_slot_diagnostics")
        if isinstance(stage_3.get("stage3_slot_diagnostics"), dict)
        else {}
    )
    if slot_diagnostics:
        snapshot_source = slot_diagnostics.get("post_exit_snapshot_source")
        planned_exits = slot_diagnostics.get("planned_exit_market_ids")
        if planned_exits and snapshot_source not in {"live-cli", "stage1_snapshot_simulation"}:
            findings.append(
                _finding(
                    code="STAGE3_POST_EXIT_SNAPSHOT_SOURCE_INVALID",
                    severity="high",
                    stage="stage-3",
                    category="slot-allocation",
                    title="Stage 3 post-exit snapshot source is not auditable",
                    explanation="A run planned Event Exit orders but did not record a live-cli or explicitly simulated post-exit snapshot source.",
                    observed_value=str(snapshot_source),
                    expected_value="live-cli for live execution; stage1_snapshot_simulation for dry-run",
                    blocking=True,
                    evidence_pointers=["/stage_3/stage3_slot_diagnostics/post_exit_snapshot_source"],
                )
            )
        occupied_before = _float(slot_diagnostics.get("occupied_slots_before_exit"))
        slot_limit = _float(slot_diagnostics.get("slot_limit"))
        economically_active = _float(
            slot_diagnostics.get("economically_active_position_count")
        )
        if slot_limit is not None and economically_active is not None and economically_active > slot_limit:
            findings.append(
                _finding(
                    code="STAGE3_ECONOMIC_SLOTS_EXCEED_LIMIT",
                    severity="high",
                    stage="stage-3",
                    category="slot-allocation",
                    title="Economic slot allocation exceeds the portfolio limit",
                    explanation="The post-exit economic exposure classifier counted more active positions than the configured top-10 limit.",
                    observed_value=str(economically_active),
                    expected_value=f"<= {int(slot_limit)}",
                    blocking=True,
                    evidence_pointers=["/stage_3/stage3_slot_diagnostics"],
                    detection_metadata={"occupied_slots_before_exit": occupied_before},
                )
            )
        if slot_diagnostics.get("operator_override_enabled") and not slot_diagnostics.get(
            "operator_override_audit"
        ):
            findings.append(
                _finding(
                    code="STAGE3_CAPACITY_OVERRIDE_NOT_AUDITED",
                    severity="high",
                    stage="stage-3",
                    category="slot-allocation",
                    title="Stage 3 capacity override lacks operator audit evidence",
                    explanation="A capacity override may only bypass the slot gate when the explicit operator action is persisted.",
                    blocking=True,
                    evidence_pointers=["/stage_3/stage3_slot_diagnostics/operator_override_audit"],
                )
            )

    orders = stage_3.get("order_intents") if isinstance(stage_3.get("order_intents"), list) else []
    decisions_by_id = {
        str(decision.get("id")): decision for decision in decisions if isinstance(decision, dict)
    }
    statuses = Counter()
    submitted_without_attempt = 0
    orphan_intents = 0
    oversized_idempotency_keys: list[tuple[int, int]] = []
    for index, order in enumerate(orders):
        if not isinstance(order, dict):
            continue
        status = str(order.get("status") or "")
        statuses[status] += 1
        decision_id = order.get("decision_id")
        if decision_id and str(decision_id) not in decisions_by_id:
            orphan_intents += 1
        attempts = order.get("attempts") if isinstance(order.get("attempts"), list) else []
        if status in {"SUBMITTED", "CONFIRMING", "CONFIRMED", "FILLED"} and not attempts:
            submitted_without_attempt += 1
        idempotency_key = order.get("idempotency_key")
        if isinstance(idempotency_key, str) and len(idempotency_key) > 128:
            oversized_idempotency_keys.append((index, len(idempotency_key)))

    if orphan_intents > 0:
        findings.append(
            _finding(
                code="ORDER_INTENT_ORPHANED_FROM_DECISION",
                severity="medium",
                stage="stage-3",
                category="order-linkage",
                title="Order intent is orphaned from the run decisions",
                explanation="At least one order intent refers to a missing or non-existent decision.",
                observed_value=str(orphan_intents),
                expected_value="0",
                evidence_pointers=["/stage_3/order_intents"],
            )
        )

    if submitted_without_attempt > 0:
        findings.append(
            _finding(
                code="SUBMITTED_ORDER_WITHOUT_ATTEMPT_RECORD",
                severity="high",
                stage="stage-3",
                category="execution-audit",
                title="Submitted order has no attempt record",
                explanation="An order moved past planning without any stored execution attempt.",
                observed_value=str(submitted_without_attempt),
                expected_value="0",
                evidence_pointers=["/stage_3/order_intents"],
            )
        )

    if oversized_idempotency_keys:
        first_index, first_length = oversized_idempotency_keys[0]
        findings.append(
            _finding(
                code="ORDER_INTENT_IDEMPOTENCY_KEY_EXCEEDS_STORAGE_LIMIT",
                severity="high",
                stage="stage-3",
                category="execution-idempotency",
                title="Order-intent idempotency key exceeds its storage limit",
                explanation="A Stage 3 order intent cannot be persisted safely because its deterministic identity exceeds the 128-character database field.",
                observed_value=f"{len(oversized_idempotency_keys)} key(s); first length {first_length}",
                expected_value="<= 128 characters",
                blocking=True,
                evidence_pointers=[
                    f"/stage_3/order_intents/{first_index}/idempotency_key"
                ],
                suggested_remediation="Regenerate the identity with the bounded deterministic Stage 3 idempotency-key helper.",
            )
        )

    run_order_funnel = raw.get("run_order_funnel") if isinstance(raw.get("run_order_funnel"), dict) else {}
    if run_order_funnel:
        planned = int(run_order_funnel.get("planned") or 0)
        submitted = int(run_order_funnel.get("submitted") or 0)
        if planned and planned < statuses.total():
            findings.append(
                _finding(
                    code="ORDER_FUNNEL_TOTAL_MISMATCH",
                    severity="medium",
                    stage="stage-3",
                    category="execution-aggregation",
                    title="Order funnel totals disagree with underlying order states",
                    explanation="The persisted run order funnel counts do not line up with the stored order intents.",
                    observed_value=str(statuses.total()),
                    expected_value=f"<= {planned}",
                    evidence_pointers=["/raw/run_order_funnel", "/stage_3/order_intents"],
                )
            )
        if submitted > planned:
            findings.append(
                _finding(
                    code="ORDER_FUNNEL_SUBMITTED_EXCEEDS_PLANNED",
                    severity="medium",
                    stage="stage-3",
                    category="execution-aggregation",
                    title="Submitted order funnel count exceeds planned",
                    explanation="The run order funnel reports more submitted orders than planned orders.",
                    observed_value=str(submitted),
                    expected_value=f"<= {planned}",
                    evidence_pointers=["/raw/run_order_funnel"],
                )
            )

    persisted_counters = (
        stage_3.get("persisted_execution_counters")
        if isinstance(stage_3.get("persisted_execution_counters"), dict)
        else {}
    )
    for counter_key in ("total", "sell", "redeem", "buy"):
        counters = persisted_counters.get(counter_key)
        if not isinstance(counters, dict):
            continue
        planned = _int(counters.get("planned"))
        processed = _int(counters.get("processed"))
        submitted = _int(counters.get("submitted"))
        if planned is None or processed is None or submitted is None:
            continue
        if not (0 <= submitted <= processed <= planned):
            findings.append(
                _finding(
                    code="STAGE3_PERSISTED_COUNTERS_CONTRADICT",
                    severity="high",
                    stage="stage-3",
                    category="execution-aggregation",
                    title="Stage 3 persisted counters contradict each other",
                    explanation=(
                        "Persisted Stage 3 counters must satisfy submitted <= "
                        "processed <= planned."
                    ),
                    observed_value=(
                        f"{counter_key}: planned={planned}, processed={processed}, "
                        f"submitted={submitted}"
                    ),
                    expected_value="submitted <= processed <= planned",
                    blocking=True,
                    evidence_pointers=[
                        f"/stage_3/persisted_execution_counters/{counter_key}"
                    ],
                )
            )

    recovery = (
        stage_3.get("recovery")
        if isinstance(stage_3.get("recovery"), dict)
        else {}
    )
    if recovery.get("required"):
        if overview.get("run_status") in {"running", "confirming"}:
            findings.append(
                _finding(
                    code="STAGE3_RECOVERY_RUN_LEFT_IN_PROGRESS",
                    severity="critical",
                    stage="stage-3",
                    category="restart-recovery",
                    title="Interrupted Stage 3 run was left in progress",
                    explanation=(
                        "A restart-recovery marker requires the run to be aborted "
                        "instead of remaining working or confirming."
                    ),
                    blocking=True,
                    evidence_pointers=[
                        "/stage_3/recovery",
                        "/overview/run_status",
                    ],
                )
            )
        if recovery.get("automatic_resubmission") is not False:
            findings.append(
                _finding(
                    code="STAGE3_RECOVERY_AUTO_RESUBMISSION_NOT_DISABLED",
                    severity="critical",
                    stage="stage-3",
                    category="duplicate-prevention",
                    title="Restart recovery did not disable automatic resubmission",
                    explanation=(
                        "Interrupted Stage 3 work must require an explicit operator "
                        "retry after persisted submission IDs are reconciled."
                    ),
                    blocking=True,
                    evidence_pointers=["/stage_3/recovery"],
                )
            )

    executable_statuses = {
        "PLANNED",
        "READY",
        "RETRY_WAIT",
        "WAITING_FOR_COLLATERAL",
        "WAITING_FOR_EXIT",
    }
    retryable_with_submission_reference = sum(
        1
        for order in orders
        if isinstance(order, dict)
        and order.get("status") in executable_statuses
        and (
            order.get("remote_order_id")
            or order.get("remote_transaction_hash")
            or order.get("first_submitted_at")
            or order.get("last_submitted_at")
        )
    )
    if retryable_with_submission_reference:
        findings.append(
            _finding(
                code="STAGE3_RETRYABLE_ORDER_HAS_SUBMISSION_REFERENCE",
                severity="critical",
                stage="stage-3",
                category="duplicate-prevention",
                title="Retryable Stage 3 order already has a submission reference",
                explanation=(
                    "An intent with persisted remote submission evidence must be "
                    "reconciled, not sent through the write path again."
                ),
                observed_value=str(retryable_with_submission_reference),
                expected_value="0",
                blocking=True,
                evidence_pointers=["/stage_3/order_intents"],
            )
        )

    stage_statuses = overview.get("stage_statuses")
    if isinstance(stage_statuses, dict):
        if stage_statuses.get("stage_2") == "pass":
            failed_count = sum(
                1
                for review in candidate_reviews
                if isinstance(review, dict)
                and any(
                    isinstance(output, dict) and output.get("error")
                    for output in (review.get("llm_outputs") or [])
                )
            )
            if failed_count:
                findings.append(
                    _finding(
                        code="STAGE_STATUS_CONTRADICTS_OUTPUTS",
                        severity="medium",
                        stage="stage-2",
                        category="status-consistency",
                        title="Stage 2 status contradicts stored provider failures",
                        explanation="Stage 2 is marked as passing even though failed LLM outputs were recorded.",
                        observed_value=str(failed_count),
                        expected_value="0 failed LLM outputs when stage status is pass",
                        evidence_pointers=["/overview/stage_statuses", "/stage_2/candidate_reviews"],
                    )
                )

    return findings
