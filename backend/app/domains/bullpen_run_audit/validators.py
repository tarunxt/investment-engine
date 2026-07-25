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


_IMMEDIATE_SELL_LAYERS = ("primary", "secondary", "tertiary")
_IMMEDIATE_SELL_PATHS = (
    "market_sell_explicit",
    "market_sell_max",
    "limit_sell_fak",
)
_IMMEDIATE_SELL_RESULTS = {
    "accepted",
    "fallback",
    "provider_retry_required",
    "ambiguous",
}
_IMMEDIATE_SELL_REQUIRED_ATTEMPT_STRINGS = (
    "layer",
    "path",
    "result",
    "reason",
    "validation",
    "provider_alias",
    "started_at",
    "completed_at",
)


def _immediate_sell_strategy_findings(
    *,
    order: dict[str, Any],
    order_index: int,
) -> list[dict[str, object]]:
    """Validate an opt-in v1 immediate-sell trace without reinterpreting legacy rows."""

    findings: list[dict[str, object]] = []
    metadata = (
        order.get("execution_metadata_json")
        if isinstance(order.get("execution_metadata_json"), dict)
        else {}
    )
    if "immediate_sell_strategy" not in metadata:
        return findings

    strategy_pointer = (
        f"/stage_3/order_intents/{order_index}/execution_metadata_json/"
        "immediate_sell_strategy"
    )
    strategy = metadata.get("immediate_sell_strategy")
    if str(order.get("action") or "").lower() != "sell":
        findings.append(
            _finding(
                code="STAGE3_IMMEDIATE_SELL_TELEMETRY_ON_NON_SELL",
                severity="high",
                stage="stage-3",
                category="execution-audit",
                title="Immediate-sell telemetry is attached to a non-sell intent",
                explanation=(
                    "The layered immediate-sell contract may only be recorded on a "
                    "durable Stage 3 sell intent."
                ),
                observed_value=str(order.get("action")),
                expected_value="sell",
                blocking=True,
                evidence_pointers=[strategy_pointer],
            )
        )
    if not isinstance(strategy, dict):
        findings.append(
            _finding(
                code="STAGE3_IMMEDIATE_SELL_TELEMETRY_INVALID",
                severity="critical",
                stage="stage-3",
                category="execution-audit",
                title="Immediate-sell telemetry is not a structured record",
                explanation=(
                    "A telemetry-bearing sell must preserve the versioned bounded "
                    "strategy record; an absent field remains valid for legacy intents."
                ),
                observed_value=type(strategy).__name__,
                expected_value="object",
                blocking=True,
                evidence_pointers=[strategy_pointer],
            )
        )
        return findings

    version = str(strategy.get("version") or "").strip()
    if version != "v1":
        findings.append(
            _finding(
                code="STAGE3_IMMEDIATE_SELL_TELEMETRY_VERSION_UNSUPPORTED",
                severity="high",
                stage="stage-3",
                category="execution-audit",
                title="Immediate-sell telemetry has an unsupported version",
                explanation=(
                    "The deterministic audit can validate only the v1 three-layer "
                    "immediate-sell contract."
                ),
                observed_value=version or "missing",
                expected_value="v1",
                blocking=True,
                evidence_pointers=[f"{strategy_pointer}/version"],
            )
        )
        return findings

    raw_attempts = strategy.get("attempts")
    attempts = (
        [item for item in raw_attempts if isinstance(item, dict)]
        if isinstance(raw_attempts, list)
        else []
    )
    sequences = [_int(item.get("sequence")) for item in attempts]
    layers = [str(item.get("layer") or "").strip() for item in attempts]
    paths = [str(item.get("path") or "").strip() for item in attempts]
    results = [str(item.get("result") or "").strip() for item in attempts]
    expected_attempt_count = len(attempts)
    expected_sequences = list(range(1, expected_attempt_count + 1))
    expected_layers = list(_IMMEDIATE_SELL_LAYERS[:expected_attempt_count])
    expected_paths = list(_IMMEDIATE_SELL_PATHS[:expected_attempt_count])
    sequence_invalid = (
        not isinstance(raw_attempts, list)
        or len(attempts) != len(raw_attempts)
        or expected_attempt_count == 0
        or expected_attempt_count > len(_IMMEDIATE_SELL_LAYERS)
        or sequences != expected_sequences
        or layers != expected_layers
        or paths != expected_paths
        or len(set(layers)) != len(layers)
        or any(result not in _IMMEDIATE_SELL_RESULTS for result in results)
    )
    if sequence_invalid:
        findings.append(
            _finding(
                code="STAGE3_IMMEDIATE_SELL_FALLBACK_SEQUENCE_INVALID",
                severity="critical",
                stage="stage-3",
                category="duplicate-prevention",
                title="Immediate-sell fallback sequence is invalid",
                explanation=(
                    "The strategy must make one bounded, ordered pass through primary "
                    "market sell, secondary max market sell, and tertiary FAK limit "
                    "sell, with no duplicate layer or fourth execution path."
                ),
                observed_value=(
                    f"sequences={sequences}; layers={layers}; paths={paths}; "
                    f"results={results}"
                ),
                expected_value=(
                    "ordered prefix of primary/market_sell_explicit, "
                    "secondary/market_sell_max, tertiary/limit_sell_fak"
                ),
                blocking=True,
                evidence_pointers=[f"{strategy_pointer}/attempts"],
            )
        )

    missing_evidence: list[dict[str, object]] = []
    for attempt_index, attempt in enumerate(attempts):
        missing_fields = [
            key
            for key in _IMMEDIATE_SELL_REQUIRED_ATTEMPT_STRINGS
            if not isinstance(attempt.get(key), str)
            or not str(attempt.get(key)).strip()
        ]
        if not isinstance(attempt.get("safe_to_fallback"), bool):
            missing_fields.append("safe_to_fallback")
        if _int(attempt.get("sequence")) is None:
            missing_fields.append("sequence")
        if missing_fields:
            missing_evidence.append(
                {
                    "attempt_index": attempt_index,
                    "missing_or_invalid_fields": sorted(set(missing_fields)),
                }
            )
    if missing_evidence:
        findings.append(
            _finding(
                code="STAGE3_IMMEDIATE_SELL_FALLBACK_EVIDENCE_MISSING",
                severity="high",
                stage="stage-3",
                category="execution-audit",
                title="Immediate-sell fallback is missing trigger evidence",
                explanation=(
                    "Every in-worker layer must record its sequence, path, result, "
                    "reason, validation, safety decision, provider, and timestamps."
                ),
                blocking=True,
                evidence_pointers=[f"{strategy_pointer}/attempts"],
                detection_metadata={"attempts": missing_evidence},
            )
        )

    recorded_fallback_count = _int(strategy.get("fallback_count"))
    observed_fallback_count = sum(
        1 for result in results[:-1] if result == "fallback"
    )
    if (
        recorded_fallback_count is None
        or recorded_fallback_count < 0
        or recorded_fallback_count > 2
        or recorded_fallback_count != observed_fallback_count
    ):
        findings.append(
            _finding(
                code="STAGE3_IMMEDIATE_SELL_FALLBACK_COUNT_MISMATCH",
                severity="high",
                stage="stage-3",
                category="execution-aggregation",
                title="Immediate-sell fallback count contradicts its layer results",
                explanation=(
                    "fallback_count must equal the number of layers that explicitly "
                    "validated a safe transition to the next bounded path."
                ),
                observed_value=str(strategy.get("fallback_count")),
                expected_value=str(observed_fallback_count),
                blocking=True,
                evidence_pointers=[
                    f"{strategy_pointer}/fallback_count",
                    f"{strategy_pointer}/attempts",
                ],
            )
        )

    unsafe_transitions: list[int] = []
    terminal_fallthroughs: list[int] = []
    for attempt_index, attempt in enumerate(attempts):
        result = str(attempt.get("result") or "").strip()
        safe_to_fallback = attempt.get("safe_to_fallback")
        has_later_layer = attempt_index < len(attempts) - 1
        if result == "fallback":
            final_verified_failure = (
                not has_later_layer
                and attempt_index == len(_IMMEDIATE_SELL_LAYERS) - 1
                and str(attempt.get("layer") or "") == "tertiary"
                and str(attempt.get("path") or "") == "limit_sell_fak"
                and order.get("status") == "FAILED_PERMANENT"
                and strategy.get("selected_layer") is None
                and strategy.get("execution_path") is None
            )
            if safe_to_fallback is not True or (
                not has_later_layer and not final_verified_failure
            ):
                unsafe_transitions.append(attempt_index)
        else:
            if safe_to_fallback is not False:
                unsafe_transitions.append(attempt_index)
            if has_later_layer and result in {
                "accepted",
                "provider_retry_required",
                "ambiguous",
            }:
                terminal_fallthroughs.append(attempt_index)
    if unsafe_transitions:
        findings.append(
            _finding(
                code="STAGE3_IMMEDIATE_SELL_UNSAFE_FALLBACK",
                severity="critical",
                stage="stage-3",
                category="duplicate-prevention",
                title="Immediate-sell fallback safety decision is inconsistent",
                explanation=(
                    "Only a non-final result='fallback' layer with "
                    "safe_to_fallback=true may advance. Accepted, ambiguous, and "
                    "provider-retry results must stop the in-provider sequence."
                ),
                blocking=True,
                evidence_pointers=[
                    f"{strategy_pointer}/attempts/{index}"
                    for index in unsafe_transitions
                ],
            )
        )
    if terminal_fallthroughs:
        findings.append(
            _finding(
                code="STAGE3_IMMEDIATE_SELL_TERMINAL_RESULT_FELL_THROUGH",
                severity="critical",
                stage="stage-3",
                category="duplicate-prevention",
                title="Immediate-sell execution continued after a terminal result",
                explanation=(
                    "An accepted write, ambiguous write, or provider-level retry "
                    "result must reconcile or retry durably; it must never issue the "
                    "next in-worker sell path."
                ),
                blocking=True,
                evidence_pointers=[
                    f"{strategy_pointer}/attempts/{index}"
                    for index in terminal_fallthroughs
                ],
            )
        )

    selected_layer = strategy.get("selected_layer")
    execution_path = strategy.get("execution_path")
    accepted_indexes = [
        index for index, result in enumerate(results) if result == "accepted"
    ]
    selected_invalid = False
    if accepted_indexes:
        accepted_index = accepted_indexes[-1]
        selected_invalid = (
            len(accepted_indexes) != 1
            or accepted_index != len(attempts) - 1
            or selected_layer != layers[accepted_index]
            or execution_path != paths[accepted_index]
        )
    else:
        selected_invalid = selected_layer is not None or execution_path is not None
    if selected_invalid:
        findings.append(
            _finding(
                code="STAGE3_IMMEDIATE_SELL_SELECTED_PATH_INVALID",
                severity="critical",
                stage="stage-3",
                category="execution-audit",
                title="Immediate-sell selected layer does not match the accepted path",
                explanation=(
                    "selected_layer and execution_path must identify the one final "
                    "accepted attempt, or both remain null when no layer was accepted."
                ),
                observed_value=(
                    f"selected_layer={selected_layer}; execution_path={execution_path}; "
                    f"accepted_indexes={accepted_indexes}"
                ),
                expected_value="the final accepted layer and path, or null/null",
                blocking=True,
                evidence_pointers=[
                    f"{strategy_pointer}/selected_layer",
                    f"{strategy_pointer}/execution_path",
                    f"{strategy_pointer}/attempts",
                ],
            )
        )

    durable_attempts = (
        order.get("attempts") if isinstance(order.get("attempts"), list) else []
    )
    durable_attempt_rows = [
        item for item in durable_attempts if isinstance(item, dict)
    ]
    mirrored_attempt_rows = []
    for durable_attempt in durable_attempt_rows:
        response_json = durable_attempt.get("sanitized_response_json")
        if (
            isinstance(response_json, dict)
            and "_stage3_immediate_sell" in response_json
        ):
            mirrored_attempt_rows.append(durable_attempt)
    owning_attempt = (
        max(
            mirrored_attempt_rows,
            key=lambda item: _int(item.get("attempt_number")) or 0,
        )
        if mirrored_attempt_rows
        else None
    )
    mirrored_strategy: object = None
    if owning_attempt is not None:
        response_json = owning_attempt.get("sanitized_response_json")
        if isinstance(response_json, dict):
            mirrored_strategy = response_json.get("_stage3_immediate_sell")
    if mirrored_strategy is None:
        findings.append(
            _finding(
                code="STAGE3_IMMEDIATE_SELL_ATTEMPT_MIRROR_MISSING",
                severity="high",
                stage="stage-3",
                category="execution-audit",
                title="Immediate-sell telemetry has no owning order attempt",
                explanation=(
                    "The intent-level strategy must be mirrored by the durable order "
                    "attempt that ran it. A later retry that stops in preflight may "
                    "legitimately have no immediate-sell response."
                ),
                blocking=True,
                evidence_pointers=[
                    strategy_pointer,
                    f"/stage_3/order_intents/{order_index}/attempts",
                ],
            )
        )
    elif mirrored_strategy != strategy:
        findings.append(
            _finding(
                code="STAGE3_IMMEDIATE_SELL_ATTEMPT_MIRROR_MISMATCH",
                severity="high",
                stage="stage-3",
                category="execution-audit",
                title="Immediate-sell intent and attempt telemetry disagree",
                explanation=(
                    "The two durable copies of the bounded fallback trace must be "
                    "identical for deterministic reconstruction."
                ),
                blocking=True,
                evidence_pointers=[
                    strategy_pointer,
                    (
                        f"/stage_3/order_intents/{order_index}/attempts/"
                        "_latest_with_immediate_sell/sanitized_response_json/"
                        "_stage3_immediate_sell"
                    ),
                ],
            )
        )

    if observed_fallback_count > 0:
        fallback_reasons = [
            str(attempt.get("reason"))
            for attempt in attempts
            if attempt.get("result") == "fallback"
        ]
        findings.append(
            _finding(
                code="STAGE3_IMMEDIATE_SELL_FALLBACK_USED",
                severity="info",
                stage="stage-3",
                category="execution-fallback",
                title="Stage 3 used an immediate-sell fallback",
                explanation=(
                    "A preferred immediate-sell path returned a validated safe "
                    "fallback result, so the next bounded path was attempted."
                ),
                observed_value=(
                    f"fallback_count={observed_fallback_count}; "
                    f"selected_layer={selected_layer}"
                ),
                evidence_pointers=[strategy_pointer],
                detection_metadata={"fallback_reasons": fallback_reasons},
            )
        )

    return findings


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

    execution_handoff = (
        overview.get("execution_handoff")
        if isinstance(overview.get("execution_handoff"), dict)
        else {}
    )
    raw_handoff_stages = execution_handoff.get("stages")
    if isinstance(raw_handoff_stages, list) and raw_handoff_stages:
        handoff_stages = [
            stage for stage in raw_handoff_stages if isinstance(stage, dict)
        ]
        stage_names = [
            str(stage.get("stage") or "").strip().lower()
            for stage in handoff_stages
        ]
        expected_prefix = ["primary", "secondary", "tertiary"][: len(stage_names)]
        if (
            len(handoff_stages) != len(raw_handoff_stages)
            or len(stage_names) > 3
            or stage_names != expected_prefix
            or len(set(stage_names)) != len(stage_names)
        ):
            findings.append(
                _finding(
                    code="RUN_HANDOFF_FALLBACK_SEQUENCE_INVALID",
                    severity="critical",
                    stage="overview",
                    category="execution-handoff",
                    title="Run execution fallbacks are duplicated or out of order",
                    explanation=(
                        "The durable handoff must contain at most one primary, "
                        "one secondary, and one tertiary stage in that order."
                    ),
                    observed_value=str(stage_names),
                    expected_value=str(expected_prefix),
                    blocking=True,
                    evidence_pointers=["/overview/execution_handoff/stages"],
                )
            )

        for index, stage in enumerate(handoff_stages):
            if (
                not str(stage.get("reason") or "").strip()
                or not str(stage.get("validation") or "").strip()
                or not str(stage.get("triggered_at") or "").strip()
            ):
                findings.append(
                    _finding(
                        code="RUN_HANDOFF_FALLBACK_EVIDENCE_MISSING",
                        severity="high",
                        stage="overview",
                        category="execution-handoff",
                        title="Run fallback is missing its trigger evidence",
                        explanation=(
                            "Every handoff stage must record when it was used, "
                            "why it was triggered, and which validation allowed it."
                        ),
                        blocking=True,
                        evidence_pointers=[
                            f"/overview/execution_handoff/stages/{index}"
                        ],
                    )
                )

        if "secondary" in stage_names:
            findings.append(
                _finding(
                    code="RUN_HANDOFF_SECONDARY_FALLBACK_USED",
                    severity="info",
                    stage="overview",
                    category="execution-handoff",
                    title="Run used the bounded secondary worker handoff",
                    explanation=(
                        "The preferred dedicated queue did not produce a valid "
                        "handoff, so the same fenced task identity was dispatched "
                        "once through the configured fallback queue."
                    ),
                    evidence_pointers=["/overview/execution_handoff/stages"],
                )
            )

        if "tertiary" in stage_names and overview.get("run_status") != "failed":
            findings.append(
                _finding(
                    code="RUN_HANDOFF_TERTIARY_NOT_FAIL_CLOSED",
                    severity="critical",
                    stage="overview",
                    category="execution-handoff",
                    title="Tertiary handoff did not leave the run failed",
                    explanation=(
                        "The tertiary layer is a fail-closed terminal result; "
                        "it must never continue Stage 1, Stage 2, or Stage 3."
                    ),
                    observed_value=str(overview.get("run_status")),
                    expected_value="failed",
                    blocking=True,
                    evidence_pointers=[
                        "/overview/run_status",
                        "/overview/execution_handoff/stages",
                    ],
                )
            )

        request_context = (
            overview.get("request_context")
            if isinstance(overview.get("request_context"), dict)
            else {}
        )
        client_run_id = request_context.get("client_run_id")
        if client_run_id and client_run_id != metadata.get("run_id"):
            findings.append(
                _finding(
                    code="RUN_START_IDEMPOTENCY_ID_MISMATCH",
                    severity="critical",
                    stage="overview",
                    category="idempotency",
                    title="Client run identity does not match the durable run",
                    explanation=(
                        "An ambiguity-safe start must persist the client-generated "
                        "run ID as the actual durable run primary key."
                    ),
                    observed_value=str(client_run_id),
                    expected_value=str(metadata.get("run_id")),
                    blocking=True,
                    evidence_pointers=[
                        "/overview/request_context/client_run_id",
                        "/metadata/run_id",
                    ],
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
    raw_handoff_checkpoint = stage_3.get("handoff_checkpoint")
    handoff_checkpoint = (
        raw_handoff_checkpoint
        if isinstance(raw_handoff_checkpoint, dict) and raw_handoff_checkpoint
        else None
    )
    if handoff_checkpoint is not None:
        checkpoint_status = str(handoff_checkpoint.get("status") or "").strip()
        checkpoint_market_ids = {
            str(market_id)
            for market_id in (handoff_checkpoint.get("candidate_market_ids") or [])
            if str(market_id or "").strip()
        }
        checkpoint_count = _int(handoff_checkpoint.get("candidate_count"))
        if checkpoint_status != "received":
            findings.append(
                _finding(
                    code="STAGE2_TO_STAGE3_HANDOFF_CHECKPOINT_INVALID",
                    severity="high",
                    stage="stage-3",
                    category="handoff",
                    title="Stage 3 handoff checkpoint is not marked received",
                    explanation=(
                        "The persisted Stage 3 checkpoint did not confirm receipt of "
                        "the saved Stage 2 Top 10 handoff."
                    ),
                    observed_value=checkpoint_status or "missing",
                    expected_value="received",
                    evidence_pointers=["/stage_3/handoff_checkpoint"],
                )
            )
        if checkpoint_market_ids != handoff_market_ids:
            findings.append(
                _finding(
                    code="STAGE2_TO_STAGE3_HANDOFF_CHECKPOINT_MISMATCH",
                    severity="high",
                    stage="stage-3",
                    category="handoff",
                    title="Stage 3 checkpoint does not match the saved Stage 2 handoff",
                    explanation=(
                        "The checkpoint candidate IDs differ from the persisted Stage 2 "
                        "Top 10 transfer queue."
                    ),
                    observed_value=str(sorted(checkpoint_market_ids)),
                    expected_value=str(sorted(handoff_market_ids)),
                    evidence_pointers=[
                        "/stage_2/stage3_handoff_candidate_market_ids",
                        "/stage_3/handoff_checkpoint/candidate_market_ids",
                    ],
                )
            )
        elif checkpoint_count != len(checkpoint_market_ids):
            findings.append(
                _finding(
                    code="STAGE2_TO_STAGE3_HANDOFF_CHECKPOINT_COUNT_MISMATCH",
                    severity="medium",
                    stage="stage-3",
                    category="handoff",
                    title="Stage 3 checkpoint candidate count is inconsistent",
                    explanation=(
                        "The checkpoint count does not equal its saved candidate ID "
                        "count."
                    ),
                    observed_value=str(checkpoint_count),
                    expected_value=str(len(checkpoint_market_ids)),
                    evidence_pointers=["/stage_3/handoff_checkpoint"],
                )
            )
        if (
            checkpoint_status == "received"
            and handoff_market_ids
            and not decisions
            and overview.get("run_status") == "failed"
        ):
            findings.append(
                _finding(
                    code="STAGE3_INTERRUPTED_AFTER_HANDOFF_CHECKPOINT",
                    severity="high",
                    stage="stage-3",
                    category="handoff",
                    title="Stage 3 stopped after receiving the Top 10 handoff",
                    explanation=(
                        "Stage 3 durably received the saved Stage 2 queue but ended "
                        "before it persisted concrete decision rows. No order was "
                        "planned or submitted."
                    ),
                    evidence_pointers=[
                        "/overview/run_status",
                        "/stage_3/handoff_checkpoint",
                        "/stage_3/decisions",
                    ],
                )
            )
    scan_context = (
        stage_1.get("scan_context")
        if isinstance(stage_1.get("scan_context"), dict)
        else {}
    )
    stage2_candidate_only = bool(
        stage_2.get("candidate_only")
        or scan_context.get("stage2_candidate_only")
    )
    stage3_wallet_blocked = bool(
        stage_3.get("blocked_by_stage1_wallet_refresh")
    )

    if stage2_candidate_only:
        if not stage3_wallet_blocked:
            findings.append(
                _finding(
                    code="STAGE1_WALLET_TIMEOUT_STAGE3_NOT_BLOCKED",
                    severity="critical",
                    stage="stage-3",
                    category="wallet-safety",
                    title="Candidate-only Stage 2 was allowed to continue into Stage 3",
                    explanation=(
                        "A Stage 1 wallet handoff timeout permits read-only candidate "
                        "analysis, but Stage 3 must remain blocked without a fresh wallet snapshot."
                    ),
                    blocking=True,
                    evidence_pointers=[
                        "/stage_1/scan_context/stage2_candidate_only",
                        "/stage_3/blocked_by_stage1_wallet_refresh",
                    ],
                )
            )
        if decisions or stage_3.get("order_intents"):
            findings.append(
                _finding(
                    code="STAGE1_WALLET_TIMEOUT_EXECUTION_OCCURRED",
                    severity="critical",
                    stage="stage-3",
                    category="wallet-safety",
                    title="Orders or decisions were created without a fresh wallet snapshot",
                    explanation=(
                        "Candidate-only Stage 2 must terminate before Stage 3 decision "
                        "or order creation when the Stage 1 wallet handoff timed out."
                    ),
                    blocking=True,
                    evidence_pointers=[
                        "/stage_1/scan_context/stage2_candidate_only",
                        "/stage_3/decisions",
                        "/stage_3/order_intents",
                    ],
                )
            )
        findings.append(
            _finding(
                code="STAGE1_WALLET_TIMEOUT_CANDIDATE_ONLY_REVIEW",
                severity="info",
                stage="stage-2",
                category="wallet-safety",
                title="Stage 2 completed without a fresh wallet snapshot",
                explanation=(
                    "The run retained read-only candidate analysis after the Stage 1 "
                    "wallet handoff timeout and correctly blocked Stage 3 execution."
                ),
                evidence_pointers=[
                    "/stage_1/scan_context/wallet_refresh_error",
                    "/stage_2/candidate_only",
                    "/stage_3/blocked_by_stage1_wallet_refresh",
                ],
            )
        )

    if not stage2_candidate_only:
        for market_id in sorted(qualified_market_ids - stage3_market_ids):
            findings.append(
                _finding(
                    code="QUALIFIED_STAGE2_CANDIDATE_MISSING_STAGE3_RESULT",
                    severity="high",
                    stage="stage-3",
                    category="handoff",
                    title="Qualified Stage 2 candidate never received a Stage 3 result",
                    explanation="A candidate was qualified in Stage 2, but never appeared in Stage 3 decisions.",
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
        override_enabled = bool(slot_diagnostics.get("operator_override_enabled"))
        override_audit = slot_diagnostics.get("operator_override_audit")
        if override_enabled and not override_audit:
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
        sizing_basis = slot_diagnostics.get("capacity_sizing_basis")
        if sizing_basis == "live-economic-plus-current-run-accepted-v2" or (
            override_enabled and sizing_basis is not None
        ):
            expected_sizing_basis = (
                "live-economic-plus-current-run-accepted-v2"
                if sizing_basis == "live-economic-plus-current-run-accepted-v2"
                else "live-economic-plus-current-run-accepted-v1"
            )
            sizing_count = _int(
                slot_diagnostics.get("capacity_sizing_occupied_market_count")
            )
            current_run_pending_count = _int(
                slot_diagnostics.get("current_run_submitted_buy_market_count")
            )
            expected_sizing_count = (
                int(economically_active) + int(current_run_pending_count)
                if economically_active is not None
                and current_run_pending_count is not None
                else None
            )
            if sizing_basis != expected_sizing_basis or (
                sizing_count is not None
                and expected_sizing_count is not None
                and sizing_count != expected_sizing_count
            ):
                findings.append(
                    _finding(
                        code="STAGE3_CAPACITY_OVERRIDE_SIZING_BASIS_INVALID",
                        severity="high",
                        stage="stage-3",
                        category="slot-allocation",
                        title="Stage 3 used an invalid capacity sizing basis",
                        explanation=(
                            "Stage 3 must size from the forced live economic-position snapshot plus accepted buys from the current run; historical pending rows remain duplicate guards but cannot force sizing to zero."
                        ),
                        observed_value=(
                            f"basis={sizing_basis}; occupied={sizing_count}"
                        ),
                        expected_value=(
                            f"basis={expected_sizing_basis}; occupied={expected_sizing_count}"
                        ),
                        blocking=True,
                        evidence_pointers=[
                            "/stage_3/stage3_slot_diagnostics/capacity_sizing_basis",
                            "/stage_3/stage3_slot_diagnostics/capacity_sizing_occupied_market_count",
                        ],
                    )
                )

    orders = stage_3.get("order_intents") if isinstance(stage_3.get("order_intents"), list) else []
    auth_recovery = (
        stage_3.get("auth_recovery")
        if isinstance(stage_3.get("auth_recovery"), dict)
        else {}
    )
    planned_live_decisions = [
        decision
        for decision in decisions
        if isinstance(decision, dict)
        and isinstance(decision.get("order_plan"), dict)
        and not bool(decision["order_plan"].get("dry_run", True))
        and decision["order_plan"].get("action") in {"buy", "sell", "redeem"}
    ]
    if (
        auth_recovery.get("historical_error_stale")
        and planned_live_decisions
        and not orders
    ):
        findings.append(
            _finding(
                code="STAGE3_AUTH_RECOVERY_LOST_DURABLE_INTENTS",
                severity="critical",
                stage="stage-3",
                category="execution-recovery",
                title="Auth recovery lost planned durable order intents",
                explanation="The recovered run still contains live Stage 3 order plans but no corresponding durable intents, so recovery cannot safely reconcile or resume them.",
                observed_value=f"{len(planned_live_decisions)} live plan(s), 0 intents",
                expected_value="One durable intent per live order plan",
                blocking=True,
                evidence_pointers=[
                    "/stage_3/auth_recovery",
                    "/stage_3/decisions",
                    "/stage_3/order_intents",
                ],
                suggested_remediation="Preserve decision rows and their linked durable intents when closing a run after active auth recovery.",
            )
        )
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
        findings.extend(
            _immediate_sell_strategy_findings(
                order=order,
                order_index=index,
            )
        )

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
