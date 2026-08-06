from __future__ import annotations

from collections import Counter
from copy import deepcopy
from datetime import UTC, datetime
import hashlib
import json
from typing import Any

from app.domains.bullpen_run_audit.constants import (
    BULLPEN_RUN_AUDIT_RULE_VERSION,
    FINDING_SEVERITIES,
)
from app.domains.polymarket.doctor_errors import (
    is_terminal_bullpen_support_error_code,
    parse_bullpen_doctor_failure,
)
from app.domains.polymarket.position_classification import (
    BULLPEN_POSITION_CLASSIFIER_VERSION,
)


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


_MAX_COALESCED_OCCURRENCES = 50
_MAX_COALESCED_EVIDENCE_POINTERS = 50
_MAX_OCCURRENCE_VALUE_ITEMS = 50
_MAX_OCCURRENCE_VALUE_NODES = 250
_MAX_OCCURRENCE_VALUE_DEPTH = 6
_MAX_OCCURRENCE_STRING_LENGTH = 1_000


def _canonical_json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def _stable_json_hash(value: object) -> str:
    return hashlib.sha256(_canonical_json_bytes(value)).hexdigest()


def _bounded_occurrence_value(
    value: object,
    *,
    depth: int = 0,
    remaining_nodes: list[int] | None = None,
) -> tuple[object, bool]:
    """Return deterministic JSON evidence with a strict per-value size bound."""

    node_budget = (
        remaining_nodes
        if remaining_nodes is not None
        else [_MAX_OCCURRENCE_VALUE_NODES]
    )
    if node_budget[0] <= 0:
        return None, True
    node_budget[0] -= 1

    if value is None or isinstance(value, (bool, int, float)):
        return value, False
    if isinstance(value, str):
        if len(value) <= _MAX_OCCURRENCE_STRING_LENGTH:
            return value, False
        return f"{value[:_MAX_OCCURRENCE_STRING_LENGTH]}…", True
    if depth >= _MAX_OCCURRENCE_VALUE_DEPTH and isinstance(
        value,
        (dict, list, tuple),
    ):
        return None, True
    if isinstance(value, dict):
        bounded: dict[str, object] = {}
        truncated = len(value) > _MAX_OCCURRENCE_VALUE_ITEMS
        for raw_key, raw_value in list(value.items())[
            :_MAX_OCCURRENCE_VALUE_ITEMS
        ]:
            if node_budget[0] <= 0:
                truncated = True
                break
            key = str(raw_key)
            if len(key) > _MAX_OCCURRENCE_STRING_LENGTH:
                key = f"{key[:_MAX_OCCURRENCE_STRING_LENGTH]}…"
                truncated = True
            bounded_value, value_truncated = _bounded_occurrence_value(
                raw_value,
                depth=depth + 1,
                remaining_nodes=node_budget,
            )
            bounded[key] = bounded_value
            truncated = truncated or value_truncated
        return bounded, truncated
    if isinstance(value, (list, tuple)):
        bounded_items: list[object] = []
        truncated = len(value) > _MAX_OCCURRENCE_VALUE_ITEMS
        for item in value[:_MAX_OCCURRENCE_VALUE_ITEMS]:
            if node_budget[0] <= 0:
                truncated = True
                break
            bounded_item, item_truncated = _bounded_occurrence_value(
                item,
                depth=depth + 1,
                remaining_nodes=node_budget,
            )
            bounded_items.append(bounded_item)
            truncated = truncated or item_truncated
        return bounded_items, truncated

    normalized = str(value)
    if len(normalized) <= _MAX_OCCURRENCE_STRING_LENGTH:
        return normalized, True
    return f"{normalized[:_MAX_OCCURRENCE_STRING_LENGTH]}…", True


def _finding_occurrence_identity(
    finding: dict[str, object],
) -> dict[str, object]:
    """Return the complete JSON identity used by the occurrence stream hash."""

    return {
        "severity": finding.get("severity"),
        "stage": finding.get("stage"),
        "category": finding.get("category"),
        "title": finding.get("title"),
        "explanation": finding.get("explanation"),
        "observed_value": finding.get("observed_value"),
        "expected_value": finding.get("expected_value"),
        "blocking": bool(finding.get("blocking")),
        "classification": finding.get("classification"),
        "suggested_remediation": finding.get("suggested_remediation"),
        "evidence_pointers": list(finding.get("evidence_pointers") or []),
        "detection_metadata": dict(finding.get("detection_metadata") or {}),
    }


def _occurrence_stream_hash(
    occurrences: list[dict[str, object]],
) -> str:
    digest = hashlib.sha256()
    digest.update(b"[")
    for index, occurrence in enumerate(occurrences):
        if index:
            digest.update(b",")
        digest.update(
            _canonical_json_bytes(_finding_occurrence_identity(occurrence))
        )
    digest.update(b"]")
    return digest.hexdigest()


def _finding_occurrence(finding: dict[str, object]) -> dict[str, object]:
    """Preserve a bounded sample of evidence hidden by one-row storage."""

    raw_evidence = list(finding.get("evidence_pointers") or [])
    evidence_sample: list[object] = []
    evidence_value_truncated = False
    for pointer in raw_evidence[:_MAX_COALESCED_EVIDENCE_POINTERS]:
        bounded_pointer, pointer_truncated = _bounded_occurrence_value(pointer)
        evidence_sample.append(bounded_pointer)
        evidence_value_truncated = (
            evidence_value_truncated or pointer_truncated
        )
    raw_metadata = dict(finding.get("detection_metadata") or {})
    bounded_metadata, metadata_truncated = _bounded_occurrence_value(
        raw_metadata
    )

    return {
        "severity": finding.get("severity"),
        "stage": finding.get("stage"),
        "category": finding.get("category"),
        "title": finding.get("title"),
        "explanation": finding.get("explanation"),
        "observed_value": finding.get("observed_value"),
        "expected_value": finding.get("expected_value"),
        "blocking": bool(finding.get("blocking")),
        "classification": finding.get("classification"),
        "suggested_remediation": finding.get("suggested_remediation"),
        "evidence_pointers": evidence_sample,
        "evidence_pointer_count": len(raw_evidence),
        "evidence_pointers_truncated": bool(
            len(raw_evidence) > _MAX_COALESCED_EVIDENCE_POINTERS
            or evidence_value_truncated
        ),
        "evidence_pointers_hash": _stable_json_hash(raw_evidence),
        "detection_metadata": bounded_metadata,
        "detection_metadata_truncated": metadata_truncated,
        "detection_metadata_hash": _stable_json_hash(raw_metadata),
    }


def coalesce_deterministic_findings(
    findings: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Return one deterministic row for each persisted finding identity.

    The findings table intentionally has a unique constraint on
    ``(snapshot_id, rule_version, code)``. Some validators evaluate repeated
    entities, so the same rule can fire more than once in one snapshot.
    Coalescing retains that database contract while preserving an ordered,
    deterministic sample plus a hash of the complete occurrence identity
    stream. Persisted samples are bounded independently from exact counts.
    """

    grouped: dict[tuple[str, str], list[dict[str, object]]] = {}
    for finding in findings:
        key = (
            str(finding.get("rule_version") or ""),
            str(finding.get("code") or ""),
        )
        grouped.setdefault(key, []).append(finding)

    severity_rank = {
        severity: index for index, severity in enumerate(FINDING_SEVERITIES)
    }
    coalesced: list[dict[str, object]] = []
    for occurrences in grouped.values():
        if len(occurrences) == 1:
            coalesced.append(occurrences[0])
            continue

        merged = deepcopy(occurrences[0])
        merged_evidence: list[object] = []
        evidence_pointer_count = 0
        evidence_value_truncated = False
        evidence_seen: set[str] = set()
        evidence_digest = hashlib.sha256()
        evidence_digest.update(b"[")
        for occurrence in occurrences:
            for pointer in list(occurrence.get("evidence_pointers") or []):
                pointer_bytes = _canonical_json_bytes(pointer)
                pointer_identity = hashlib.sha256(pointer_bytes).hexdigest()
                if pointer_identity in evidence_seen:
                    continue
                evidence_seen.add(pointer_identity)
                if evidence_pointer_count:
                    evidence_digest.update(b",")
                evidence_digest.update(pointer_bytes)
                evidence_pointer_count += 1
                if (
                    len(merged_evidence)
                    < _MAX_COALESCED_EVIDENCE_POINTERS
                ):
                    bounded_pointer, pointer_truncated = (
                        _bounded_occurrence_value(pointer)
                    )
                    merged_evidence.append(bounded_pointer)
                    evidence_value_truncated = (
                        evidence_value_truncated or pointer_truncated
                    )
        evidence_digest.update(b"]")
        merged["evidence_pointers"] = merged_evidence
        merged["blocking"] = any(
            bool(occurrence.get("blocking")) for occurrence in occurrences
        )
        merged["severity"] = min(
            (str(occurrence.get("severity") or "") for occurrence in occurrences),
            key=lambda severity: severity_rank.get(
                severity,
                len(severity_rank),
            ),
        )

        raw_source_detection_metadata = dict(
            merged.get("detection_metadata") or {}
        )
        bounded_source_detection_metadata, source_metadata_truncated = (
            _bounded_occurrence_value(raw_source_detection_metadata)
        )
        detection_metadata = (
            bounded_source_detection_metadata
            if isinstance(bounded_source_detection_metadata, dict)
            else {}
        )
        detection_metadata["source_detection_metadata_truncated"] = (
            source_metadata_truncated
        )
        detection_metadata["source_detection_metadata_hash"] = (
            _stable_json_hash(raw_source_detection_metadata)
        )
        detection_metadata["occurrence_count"] = len(occurrences)
        detection_metadata["occurrences"] = [
            _finding_occurrence(occurrence) for occurrence in occurrences
            [:_MAX_COALESCED_OCCURRENCES]
        ]
        detection_metadata["occurrences_truncated"] = bool(
            len(occurrences) > _MAX_COALESCED_OCCURRENCES
        )
        detection_metadata["occurrences_hash"] = _occurrence_stream_hash(
            occurrences
        )
        detection_metadata["evidence_pointer_count"] = (
            evidence_pointer_count
        )
        detection_metadata["evidence_pointers_truncated"] = bool(
            evidence_pointer_count > _MAX_COALESCED_EVIDENCE_POINTERS
            or evidence_value_truncated
        )
        detection_metadata["evidence_pointers_hash"] = (
            evidence_digest.hexdigest()
        )
        merged["detection_metadata"] = detection_metadata
        coalesced.append(merged)

    return coalesced


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


def _timestamp(value: object) -> float | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.timestamp()


def _terminal_buy_refresh_is_valid(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    status = str(value.get("status") or "").strip().lower()
    if status == "refresh_failed":
        return bool(
            str(value.get("caller_source") or "").strip()
            and str(value.get("error_code") or "").strip()
            and _timestamp(value.get("refreshed_at")) is not None
        )
    if status == "published":
        comparison = value.get("lineage_comparison")
        return bool(
            str(value.get("caller_source") or "").strip()
            and value.get("source") in {"live-cli", "redis-cache"}
            and value.get("freshness_state") == "fresh"
            and _timestamp(value.get("fetched_at")) is not None
            and _timestamp(value.get("published_at")) is not None
            and isinstance(comparison, dict)
            and comparison.get("status") == "match"
        )

    # A forced-fresh reconciliation result predates the publication wrapper
    # but remains valid only with both direct and expected-lineage matches.
    comparison = value.get("lineage_comparison")
    lineage_checks = value.get("lineage_checks")
    return bool(
        value.get("source") in {"live-cli", "redis-cache"}
        and _timestamp(value.get("fetched_at")) is not None
        and isinstance(comparison, dict)
        and comparison.get("status") == "match"
        and isinstance(lineage_checks, dict)
        and lineage_checks
        and all(
            isinstance(check, dict) and check.get("status") == "match"
            for check in lineage_checks.values()
        )
    )


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
    canonical_stage1_lifecycle = (
        verified_portfolio.get("canonical_stage_lifecycle")
        if isinstance(
            verified_portfolio.get("canonical_stage_lifecycle"),
            dict,
        )
        else None
    )
    verified_portfolio_lifecycle_valid = True
    if (
        verified_portfolio.get("verified") is True
        and canonical_stage1_lifecycle is not None
    ):
        lifecycle_status = str(
            canonical_stage1_lifecycle.get("status") or ""
        ).strip().lower()
        raw_phase_status = canonical_stage1_lifecycle.get("phase_status")
        lifecycle_phase_status = (
            str(raw_phase_status).strip().lower()
            if raw_phase_status is not None
            else None
        )
        lifecycle_completed_at = canonical_stage1_lifecycle.get(
            "completed_at"
        )
        verified_portfolio_lifecycle_valid = bool(
            lifecycle_status in {"pass", "warning"}
            and lifecycle_phase_status
            in {None, "", "completed", "partial"}
            and _timestamp(lifecycle_completed_at) is not None
            and not bool(canonical_stage1_lifecycle.get("hard_block"))
            and str(
                verified_portfolio.get("wallet_snapshot_status") or ""
            ).strip().lower()
            == "fresh"
            and str(
                verified_portfolio.get("freshness_state") or ""
            ).strip().lower()
            == "fresh"
            and not verified_portfolio.get("wallet_refresh_error")
            and not verified_portfolio.get(
                "wallet_market_enrichment_error"
            )
            and not bool(verified_portfolio.get("stage2_candidate_only"))
            and not bool(
                verified_portfolio.get(
                    "blocked_by_stage1_wallet_refresh"
                )
            )
        )
        if not verified_portfolio_lifecycle_valid:
            findings.append(
                _finding(
                    code="STAGE1_VERIFIED_PORTFOLIO_LIFECYCLE_INVALID",
                    severity="critical",
                    stage="stage-1",
                    category="portfolio-verification",
                    title="Stage 1 portfolio verification contradicts its lifecycle",
                    explanation=(
                        "A verified Stage 1 portfolio requires a pass/warning "
                        "canonical stage, a completed/partial (or legacy absent) "
                        "phase, a valid completion timestamp, fresh wallet "
                        "lineage, and no wallet error or block flags."
                    ),
                    observed_value=(
                        f"status={lifecycle_status or 'missing'}; "
                        f"phase={lifecycle_phase_status or 'missing'}; "
                        f"completed_at={lifecycle_completed_at}"
                    ),
                    expected_value=(
                        "pass/warning + completed/partial + valid completed_at "
                        "+ fresh wallet without error/block flags"
                    ),
                    blocking=True,
                    evidence_pointers=[
                        "/stage_1/verified_portfolio_snapshot/"
                        "canonical_stage_lifecycle",
                        "/stage_1/verified_portfolio_snapshot/"
                        "wallet_snapshot_status",
                        "/stage_1/verified_portfolio_snapshot/"
                        "freshness_state",
                    ],
                )
            )
    if (
        verified_portfolio.get("verified") is True
        and verified_portfolio_lifecycle_valid
    ):
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
    llm_runtime = (
        stage_2.get("llm_runtime")
        if isinstance(stage_2.get("llm_runtime"), dict)
        else {}
    )
    target_runs = (
        llm_runtime.get("llm_target_runs")
        if isinstance(llm_runtime.get("llm_target_runs"), list)
        else []
    )
    in_flight_target_indexes = [
        index
        for index, target_run in enumerate(target_runs)
        if isinstance(target_run, dict)
        and str(target_run.get("status") or "").strip().lower()
        in {"queued", "pending", "running", "processing"}
    ]
    completed_target_count = _float(
        llm_runtime.get("llm_completed_provider_target_count")
    )
    if (
        in_flight_target_indexes
        and completed_target_count is not None
        and completed_target_count >= len(target_runs)
    ):
        findings.append(
            _finding(
                code="STAGE2_TERMINAL_WITH_IN_FLIGHT_LLM_TARGET",
                severity="high",
                stage="stage-2",
                category="status-consistency",
                title="Terminal Stage 2 retains an in-flight LLM target",
                explanation=(
                    "Stage 2 was captured after execution returned, but one or more "
                    "provider targets still carry a transient status."
                ),
                observed_value=str(in_flight_target_indexes),
                expected_value="Every returned target is completed, partial, or failed",
                blocking=True,
                evidence_pointers=["/stage_2/llm_runtime/llm_target_runs"],
            )
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
    raw_actionable_contract = stage_2.get("actionable_contract")
    actionable_contract = (
        raw_actionable_contract
        if isinstance(raw_actionable_contract, dict)
        else {}
    )
    authoritative_actionables = bool(
        actionable_contract.get("authoritative")
    )
    actionable_exit_market_ids = [
        str(market_id)
        for market_id in (actionable_contract.get("exit_market_ids") or [])
        if str(market_id or "").strip()
    ]
    actionable_buy_market_ids = [
        str(market_id)
        for market_id in (actionable_contract.get("buy_market_ids") or [])
        if str(market_id or "").strip()
    ]
    actionable_exit_market_id_set = set(actionable_exit_market_ids)
    actionable_buy_market_id_set = set(actionable_buy_market_ids)
    if authoritative_actionables:
        expected_exit_count = len(actionable_exit_market_ids)
        expected_buy_count = len(actionable_buy_market_ids)
        if _int(actionable_contract.get("exit_count")) != expected_exit_count:
            findings.append(
                _finding(
                    code="STAGE2_ACTIONABLE_EXIT_COUNT_MISMATCH",
                    severity="high",
                    stage="stage-2",
                    category="handoff",
                    title="Stage 2 Exit actionable count is inconsistent",
                    explanation=(
                        "The authoritative Stage 2 Exit count does not equal its "
                        "persisted market-ID list."
                    ),
                    observed_value=str(actionable_contract.get("exit_count")),
                    expected_value=str(expected_exit_count),
                    evidence_pointers=["/stage_2/actionable_contract"],
                )
            )
        if _int(actionable_contract.get("buy_count")) != expected_buy_count:
            findings.append(
                _finding(
                    code="STAGE2_ACTIONABLE_BUY_COUNT_MISMATCH",
                    severity="high",
                    stage="stage-2",
                    category="handoff",
                    title="Stage 2 Buy actionable count is inconsistent",
                    explanation=(
                        "The authoritative Stage 2 Buy count does not equal its "
                        "persisted market-ID list."
                    ),
                    observed_value=str(actionable_contract.get("buy_count")),
                    expected_value=str(expected_buy_count),
                    evidence_pointers=["/stage_2/actionable_contract"],
                )
            )

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
        if authoritative_actionables:
            checkpoint_exit_market_ids = [
                str(market_id)
                for market_id in (
                    handoff_checkpoint.get("actionable_exit_market_ids") or []
                )
                if str(market_id or "").strip()
            ]
            checkpoint_buy_market_ids = [
                str(market_id)
                for market_id in (
                    handoff_checkpoint.get("actionable_buy_market_ids") or []
                )
                if str(market_id or "").strip()
            ]
            if checkpoint_exit_market_ids != actionable_exit_market_ids:
                findings.append(
                    _finding(
                        code="STAGE2_EXIT_ACTIONABLE_CHECKPOINT_MISMATCH",
                        severity="critical",
                        stage="stage-3",
                        category="handoff",
                        title="Stage 3 changed the Stage 2 Exit actionable list",
                        explanation=(
                            "Stage 3 must consume the exact ordered Exit list "
                            "persisted by Stage 2."
                        ),
                        observed_value=str(checkpoint_exit_market_ids),
                        expected_value=str(actionable_exit_market_ids),
                        blocking=True,
                        evidence_pointers=[
                            "/stage_2/actionable_contract/exit_market_ids",
                            "/stage_3/handoff_checkpoint/actionable_exit_market_ids",
                        ],
                    )
                )
            if checkpoint_buy_market_ids != actionable_buy_market_ids:
                findings.append(
                    _finding(
                        code="STAGE2_BUY_ACTIONABLE_CHECKPOINT_MISMATCH",
                        severity="critical",
                        stage="stage-3",
                        category="handoff",
                        title="Stage 3 changed the Stage 2 Buy actionable list",
                        explanation=(
                            "Stage 3 must consume the exact ordered Buy list "
                            "persisted by Stage 2."
                        ),
                        observed_value=str(checkpoint_buy_market_ids),
                        expected_value=str(actionable_buy_market_ids),
                        blocking=True,
                        evidence_pointers=[
                            "/stage_2/actionable_contract/buy_market_ids",
                            "/stage_3/handoff_checkpoint/actionable_buy_market_ids",
                        ],
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

    if authoritative_actionables and not stage2_candidate_only:
        execution_steps = (
            stage_3.get("execution_steps")
            if isinstance(stage_3.get("execution_steps"), list)
            else []
        )
        sell_step = next(
            (
                step
                for step in execution_steps
                if isinstance(step, dict) and step.get("key") == "sell"
            ),
            {},
        )
        buy_step = next(
            (
                step
                for step in execution_steps
                if isinstance(step, dict) and step.get("key") == "buy"
            ),
            {},
        )
        if _int(sell_step.get("planned_orders")) != len(
            actionable_exit_market_ids
        ):
            findings.append(
                _finding(
                    code="STAGE2_EXIT_ACTIONABLES_NOT_RECORDED_AS_PLANNED",
                    severity="critical",
                    stage="stage-3",
                    category="handoff",
                    title="Stage 2 Exit actionables were not preserved in Planned",
                    explanation=(
                        "Stage 3 Step 1 Planned must equal the authoritative "
                        "Stage 2 Exit list, irrespective of later execution state."
                    ),
                    blocking=True,
                    evidence_pointers=[
                        "/stage_2/actionable_contract/exit_market_ids",
                        "/stage_3/execution_steps",
                    ],
                )
            )
        if _int(buy_step.get("planned_orders")) != len(
            actionable_buy_market_ids
        ):
            findings.append(
                _finding(
                    code="STAGE2_BUY_ACTIONABLES_NOT_RECORDED_AS_PLANNED",
                    severity="critical",
                    stage="stage-3",
                    category="handoff",
                    title="Stage 2 Buy actionables were not preserved in Planned",
                    explanation=(
                        "Stage 3 Step 2 Planned must equal the authoritative "
                        "Stage 2 Buy list, irrespective of later execution state."
                    ),
                    blocking=True,
                    evidence_pointers=[
                        "/stage_2/actionable_contract/buy_market_ids",
                        "/stage_3/execution_steps",
                    ],
                )
            )
        authoritative_market_ids = (
            actionable_exit_market_id_set | actionable_buy_market_id_set
        )
        for market_id in sorted(authoritative_market_ids - stage3_market_ids):
            findings.append(
                _finding(
                    code="STAGE2_ACTIONABLE_MISSING_STAGE3_DECISION",
                    severity="critical",
                    stage="stage-3",
                    category="handoff",
                    title="Authoritative Stage 2 actionable has no Stage 3 decision",
                    explanation=(
                        "Every persisted Stage 2 Exit or Buy actionable must create "
                        "a Stage 3 decision and enter durable execution preflight."
                    ),
                    blocking=True,
                    evidence_pointers=[
                        "/stage_2/actionable_contract",
                        "/stage_3/decisions",
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
        snapshot_freshness_state = slot_diagnostics.get(
            "post_exit_snapshot_freshness_state"
        )
        planned_exits = slot_diagnostics.get("planned_exit_market_ids")
        valid_snapshot_source = bool(
            snapshot_source == "stage1_snapshot_simulation"
            or (
                snapshot_source == "live-cli"
                and snapshot_freshness_state in {None, "fresh"}
            )
            or (
                snapshot_source == "redis-cache"
                and snapshot_freshness_state == "fresh"
            )
        )
        if planned_exits and not valid_snapshot_source:
            findings.append(
                _finding(
                    code="STAGE3_POST_EXIT_SNAPSHOT_SOURCE_INVALID",
                    severity="high",
                    stage="stage-3",
                    category="slot-allocation",
                    title="Stage 3 post-exit snapshot source is not auditable",
                    explanation="A run planned Event Exit orders but did not record a live-cli or explicitly simulated post-exit snapshot source.",
                    observed_value=str(snapshot_source),
                    expected_value=(
                        "fresh live-cli/redis-cache lineage for live execution; "
                        "stage1_snapshot_simulation for dry-run"
                    ),
                    blocking=True,
                    evidence_pointers=["/stage_3/stage3_slot_diagnostics/post_exit_snapshot_source"],
                )
            )
        occupied_before = _float(slot_diagnostics.get("occupied_slots_before_exit"))
        slot_limit = _float(slot_diagnostics.get("slot_limit"))
        economically_active = _float(
            slot_diagnostics.get("economically_active_position_count")
        )
        initial_free_slots = _int(
            slot_diagnostics.get("initial_free_slots_before_exit")
        )
        pre_exit_immediate_buy_count = _int(
            slot_diagnostics.get("pre_exit_immediate_buy_count")
        )
        pre_exit_free_slot_allocation = (
            slot_diagnostics.get("pre_exit_free_slot_allocation")
            if isinstance(
                slot_diagnostics.get("pre_exit_free_slot_allocation"),
                dict,
            )
            else None
        )
        if (
            pre_exit_free_slot_allocation is not None
            and pre_exit_immediate_buy_count is not None
        ):
            allocation_affordable_count = _int(
                pre_exit_free_slot_allocation.get("affordable_buy_count")
            )
            if (
                allocation_affordable_count
                != pre_exit_immediate_buy_count
                or (
                    initial_free_slots is not None
                    and pre_exit_immediate_buy_count > initial_free_slots
                )
            ):
                findings.append(
                    _finding(
                        code="STAGE3_PRE_EXIT_FREE_SLOT_ALLOCATION_INVALID",
                        severity="high",
                        stage="stage-3",
                        category="slot-allocation",
                        title=(
                            "Pre-exit immediate buys contradict free-slot allocation"
                        ),
                        explanation=(
                            "Only the highest-ranked candidates affordable from "
                            "already-free slots may bypass a replacement EXIT "
                            "dependency."
                        ),
                        observed_value=(
                            "pre_exit_immediate_buy_count="
                            f"{pre_exit_immediate_buy_count}; "
                            "allocation_affordable_buy_count="
                            f"{allocation_affordable_count}; "
                            f"initial_free_slots={initial_free_slots}"
                        ),
                        expected_value=(
                            "immediate count equals affordable allocation and "
                            "does not exceed initial free slots"
                        ),
                        blocking=True,
                        evidence_pointers=[
                            "/stage_3/stage3_slot_diagnostics/"
                            "pre_exit_immediate_buy_count",
                            "/stage_3/stage3_slot_diagnostics/"
                            "pre_exit_free_slot_allocation",
                            "/stage_3/stage3_slot_diagnostics/"
                            "initial_free_slots_before_exit",
                        ],
                    )
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
        affordable_allocation_version = slot_diagnostics.get(
            "affordable_allocation_version"
        )
        if affordable_allocation_version in {"v1", "v2"}:
            eligible_buy_count = _int(
                slot_diagnostics.get("eligible_ranked_buy_count")
            )
            cash_affordable_count = _int(
                slot_diagnostics.get("cash_affordable_buy_count")
            )
            capacity_slot_budget = _int(
                slot_diagnostics.get("affordable_capacity_slot_budget")
            )
            affordable_buy_count = _int(
                slot_diagnostics.get("affordable_buy_count")
            )
            affordable_planned_count = _int(
                slot_diagnostics.get("affordable_planned_buy_count")
            )
            buffer_allocation_valid = True
            if affordable_allocation_version == "v2":
                gross_cash = _float(
                    slot_diagnostics.get(
                        "affordable_buy_gross_cash_in_hand_usd"
                    )
                )
                balance_buffer = _float(
                    slot_diagnostics.get(
                        "affordable_buy_balance_buffer_usd"
                    )
                )
                spendable_cash = _float(
                    slot_diagnostics.get(
                        "affordable_buy_spendable_cash_usd"
                    )
                )
                minimum_order = _float(
                    slot_diagnostics.get(
                        "affordable_buy_min_order_usd"
                    )
                )
                expected_spendable_cash = (
                    round(max(0.0, gross_cash - balance_buffer), 2)
                    if gross_cash is not None and balance_buffer is not None
                    else None
                )
                expected_cash_affordable_count = (
                    int(
                        (expected_spendable_cash + 1e-9)
                        // minimum_order
                    )
                    if expected_spendable_cash is not None
                    and minimum_order is not None
                    and minimum_order > 0
                    else None
                )
                buffer_allocation_valid = bool(
                    expected_spendable_cash is not None
                    and spendable_cash is not None
                    and abs(spendable_cash - expected_spendable_cash)
                    <= 0.001
                    and expected_cash_affordable_count is not None
                    and cash_affordable_count
                    == expected_cash_affordable_count
                )
            expected_affordable_count = (
                min(
                    eligible_buy_count,
                    cash_affordable_count,
                    capacity_slot_budget,
                )
                if None
                not in {
                    eligible_buy_count,
                    cash_affordable_count,
                    capacity_slot_budget,
                }
                else None
            )
            if (
                expected_affordable_count is None
                or not buffer_allocation_valid
                or affordable_buy_count != expected_affordable_count
                or affordable_planned_count is None
                or (
                    affordable_buy_count is not None
                    and affordable_planned_count > affordable_buy_count
                )
            ):
                findings.append(
                    _finding(
                        code="STAGE3_AFFORDABLE_BUY_ALLOCATION_INVALID",
                        severity="high",
                        stage="stage-3",
                        category="capital-sizing",
                        title="Stage 3 affordable ranked-buy allocation is inconsistent",
                        explanation=(
                            "The allocation must preserve the configured cash "
                            "buffer and select no more than the "
                            "minimum of eligible ranked rows, cash-funded minimum "
                            "orders, and available capacity slots."
                        ),
                        observed_value=(
                            f"version={affordable_allocation_version}; "
                            f"eligible={eligible_buy_count}; cash={cash_affordable_count}; "
                            f"capacity={capacity_slot_budget}; affordable={affordable_buy_count}; "
                            f"planned={affordable_planned_count}"
                        ),
                        expected_value=(
                            f"affordable={expected_affordable_count}; "
                            "planned <= affordable"
                        ),
                        blocking=True,
                        evidence_pointers=[
                            "/stage_3/stage3_slot_diagnostics/"
                            "affordable_allocation_version",
                            "/stage_3/stage3_slot_diagnostics/"
                            "affordable_buy_count",
                            "/stage_3/stage3_slot_diagnostics/"
                            "affordable_planned_buy_count",
                            "/stage_3/stage3_slot_diagnostics/"
                            "affordable_buy_spendable_cash_usd",
                        ],
                    )
                )
            free_slots_after_buys = _int(
                slot_diagnostics.get("free_slots_after_planned_buys")
            )
            allocation_sizing_count = _int(
                slot_diagnostics.get("capacity_sizing_occupied_market_count")
            )
            if (
                not override_enabled
                and slot_limit is not None
                and allocation_sizing_count is not None
                and affordable_planned_count is not None
            ):
                expected_free_slots = max(
                    0,
                    int(slot_limit)
                    - allocation_sizing_count
                    - affordable_planned_count,
                )
                if free_slots_after_buys != expected_free_slots:
                    findings.append(
                        _finding(
                            code="STAGE3_POST_BUY_FREE_SLOT_COUNT_INVALID",
                            severity="medium",
                            stage="stage-3",
                            category="slot-allocation",
                            title="Stage 3 post-buy free-slot count uses the wrong basis",
                            explanation=(
                                "Post-buy free slots must use the live economic "
                                "sizing basis and concrete planned buys, not the "
                                "historical duplicate-market denylist."
                            ),
                            observed_value=str(free_slots_after_buys),
                            expected_value=str(expected_free_slots),
                            evidence_pointers=[
                                "/stage_3/stage3_slot_diagnostics/"
                                "free_slots_after_planned_buys",
                                "/stage_3/stage3_slot_diagnostics/"
                                "capacity_sizing_occupied_market_count",
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
    dependency_exit_indexes_by_group: dict[str, list[int]] = {}
    for exit_index, exit_order in enumerate(orders):
        if (
            not isinstance(exit_order, dict)
            or str(exit_order.get("action") or "").lower()
            not in {"sell", "redeem"}
        ):
            continue
        exit_dependency_group = exit_order.get("dependency_group")
        if not isinstance(exit_dependency_group, str):
            continue
        normalized_exit_dependency_group = exit_dependency_group.strip()
        if not normalized_exit_dependency_group:
            continue
        dependency_exit_indexes_by_group.setdefault(
            normalized_exit_dependency_group,
            [],
        ).append(exit_index)
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
        execution_metadata = (
            order.get("execution_metadata_json")
            if isinstance(order.get("execution_metadata_json"), dict)
            else {}
        )
        has_submission_evidence = bool(
            order.get("first_submitted_at")
            or order.get("last_submitted_at")
            or order.get("remote_order_id")
            or order.get("remote_transaction_hash")
            or execution_metadata.get("uncertain_remote_write_boundary")
        )
        if status in {"CONFIRMED", "FILLED"} and not has_submission_evidence:
            findings.append(
                _finding(
                    code="STAGE3_TERMINAL_SUCCESS_WITHOUT_SUBMISSION_EVIDENCE",
                    severity="critical",
                    stage="stage-3",
                    category="execution-reconciliation",
                    title=(
                        "Stage 3 terminal success lacks submission evidence"
                    ),
                    explanation=(
                        "A confirmed or filled durable intent must retain a "
                        "submission timestamp, remote reference, or uncertain "
                        "write-boundary marker. Attempt count and wallet "
                        "absence alone do not prove that Bullpen executed it."
                    ),
                    observed_value=(
                        f"status={status}; "
                        f"attempt_count={order.get('attempt_count')}; "
                        "submission_evidence=false"
                    ),
                    expected_value=(
                        "terminal success with durable submission/remote-write "
                        "evidence, or a deferred/failed unsubmitted outcome"
                    ),
                    blocking=True,
                    evidence_pointers=[
                        f"/stage_3/order_intents/{index}/status",
                        f"/stage_3/order_intents/{index}/first_submitted_at",
                        f"/stage_3/order_intents/{index}/last_submitted_at",
                        f"/stage_3/order_intents/{index}/remote_order_id",
                        f"/stage_3/order_intents/{index}/remote_transaction_hash",
                        (
                            f"/stage_3/order_intents/{index}/"
                            "execution_metadata_json/"
                            "uncertain_remote_write_boundary"
                        ),
                    ],
                    suggested_remediation=(
                        "Project the row as unsubmitted, keep replacement "
                        "capacity blocked, and reconcile only from a persisted "
                        "write boundary plus matching wallet/trade evidence."
                    ),
                )
            )
        latest_attempt = next(
            (
                attempt
                for attempt in reversed(attempts)
                if isinstance(attempt, dict)
            ),
            None,
        )
        terminal_doctor_failure = parse_bullpen_doctor_failure(
            {
                "error_code": order.get("last_error_code"),
                "message": order.get("last_error_message"),
            },
            latest_attempt or {},
        )
        if (
            terminal_doctor_failure.is_terminal
            and is_terminal_bullpen_support_error_code(
                terminal_doctor_failure.error_code
            )
        ):
            latest_reconciliation = (
                latest_attempt.get("reconciliation_json")
                if isinstance(latest_attempt, dict)
                and isinstance(
                    latest_attempt.get("reconciliation_json"),
                    dict,
                )
                else {}
            )
            flattened_code = str(order.get("last_error_code") or "") == (
                "DOCTOR_READ_FAILED"
            )
            if (
                flattened_code
                or status != "FAILED_PERMANENT"
                or order.get("retryable") is not False
                or order.get("next_attempt_at") is not None
                or latest_reconciliation.get("retryable") is True
            ):
                findings.append(
                    _finding(
                        code="STAGE3_TERMINAL_DOCTOR_BLOCKER_RETRYABLE",
                        severity="critical",
                        stage="stage-3",
                        category="execution-guardrail",
                        title=(
                            "Terminal Bullpen doctor blocker remained retryable"
                        ),
                        explanation=(
                            "A typed Bullpen preflight failure marked "
                            "support-required or unsafe to retry must retain its "
                            "upstream code and terminalize before any automatic "
                            "Stage 3 resubmission."
                        ),
                        observed_value=(
                            f"code={order.get('last_error_code')}; "
                            f"status={status}; "
                            f"retryable={order.get('retryable')}; "
                            f"next_attempt_at={order.get('next_attempt_at')}"
                        ),
                        expected_value=(
                            f"code={terminal_doctor_failure.auto_live_error_code}; "
                            "status=FAILED_PERMANENT; retryable=false; "
                            "next_attempt_at=null"
                        ),
                        blocking=True,
                        evidence_pointers=[
                            f"/stage_3/order_intents/{index}/last_error_code",
                            f"/stage_3/order_intents/{index}/status",
                            f"/stage_3/order_intents/{index}/retryable",
                            f"/stage_3/order_intents/{index}/next_attempt_at",
                            f"/stage_3/order_intents/{index}/attempts",
                        ],
                        suggested_remediation=(
                            "Preserve the typed Bullpen doctor payload, disable "
                            "automatic retry, and require Bullpen support or the "
                            "reported resolution owner to clear the blocker."
                        ),
                    )
                )
        idempotency_key = order.get("idempotency_key")
        if isinstance(idempotency_key, str) and len(idempotency_key) > 128:
            oversized_idempotency_keys.append((index, len(idempotency_key)))
        sell_preflight = (
            execution_metadata.get("sell_live_preflight")
            if isinstance(execution_metadata.get("sell_live_preflight"), dict)
            else None
        )
        wallet_snapshot_lineage = (
            execution_metadata.get("wallet_snapshot_lineage")
            if isinstance(
                execution_metadata.get("wallet_snapshot_lineage"),
                dict,
            )
            else None
        )
        wallet_lineage_comparison = (
            execution_metadata.get("wallet_lineage_comparison")
            if isinstance(
                execution_metadata.get("wallet_lineage_comparison"),
                dict,
            )
            else None
        )
        current_intent_format = bool(
            str(order.get("idempotency_key") or "").startswith("auto-live:v2:")
            or execution_metadata.get("idempotency_key_format")
            == "auto-live:v2"
        )
        reservations = (
            order.get("reservations")
            if isinstance(order.get("reservations"), list)
            else []
        )
        active_reservation_rows = [
            reservation
            for reservation in reservations
            if isinstance(reservation, dict)
            and str(reservation.get("status") or "").lower() == "active"
            and (_float(reservation.get("amount_usd")) or 0) > 0
        ]
        consumed_reservation_rows = [
            reservation
            for reservation in reservations
            if isinstance(reservation, dict)
            and str(reservation.get("status") or "").lower() == "consumed"
        ]
        reservation_state = str(
            execution_metadata.get("reservation_state") or ""
        ).lower()
        active_reservation = bool(
            (_float(order.get("reserved_cash_usd")) or 0) > 0
            or reservation_state == "active"
            or active_reservation_rows
        )
        consumed_reservation = bool(
            reservation_state == "consumed"
            or consumed_reservation_rows
        )
        action = str(order.get("action") or "").lower()
        definitive_no_fill_status = status in {
            "DEFERRED",
            "FAILED_PERMANENT",
            "REJECTED",
            "CANCELLED",
        }
        fill_evidence = (
            execution_metadata.get("reconciliation_fill_evidence")
            if isinstance(
                execution_metadata.get("reconciliation_fill_evidence"),
                dict,
            )
            else {}
        )
        persisted_write_evidence = bool(
            any(
                order.get(key)
                for key in (
                    "remote_order_id",
                    "remote_transaction_hash",
                    "first_submitted_at",
                    "last_submitted_at",
                )
            )
            or execution_metadata.get(
                "uncertain_remote_write_boundary"
            )
        )
        reservation_should_be_released = bool(
            status == "WAITING_FOR_EXIT"
            or (
                definitive_no_fill_status
                and (
                    fill_evidence.get("definitive_zero_fill") is True
                    or not persisted_write_evidence
                )
            )
        )
        raw_dependency_group = order.get("dependency_group")
        dependency_group = (
            raw_dependency_group.strip()
            if isinstance(raw_dependency_group, str)
            and raw_dependency_group.strip()
            else None
        )
        dependency_metadata = (
            order.get("dependency_metadata_json")
            if isinstance(order.get("dependency_metadata_json"), dict)
            else {}
        )
        matching_dependency_exit_indexes = (
            dependency_exit_indexes_by_group.get(dependency_group, [])
            if dependency_group
            else []
        )
        if (
            current_intent_format
            and action == "buy"
            and dependency_group
            and not matching_dependency_exit_indexes
        ):
            findings.append(
                _finding(
                    code="STAGE3_REPLACEMENT_EXIT_DEPENDENCY_MISSING",
                    severity="critical",
                    stage="stage-3",
                    category="dependency-guardrail",
                    title=(
                        "A replacement buy has no exit with the same dependency group"
                    ),
                    explanation=(
                        "The durable replacement BUY and its paired EXIT must "
                        "persist the same deterministic dependency_group. "
                        "Without that shared identity, exit confirmation cannot "
                        "safely wake or recover the waiting buy."
                    ),
                    observed_value=str(dependency_group),
                    expected_value=(
                        "one sell or redeem intent with the same dependency_group"
                    ),
                    blocking=True,
                    evidence_pointers=[
                        f"/stage_3/order_intents/{index}/dependency_group",
                        "/stage_3/order_intents",
                    ],
                )
            )
        post_exit_sizing = (
            execution_metadata.get("post_exit_sizing")
            if isinstance(execution_metadata.get("post_exit_sizing"), dict)
            else None
        )
        if (
            current_intent_format
            and action == "buy"
            and active_reservation
            and reservation_should_be_released
        ):
            findings.append(
                _finding(
                    code="STAGE3_BUY_RESERVATION_NOT_RELEASED",
                    severity="critical",
                    stage="stage-3",
                    category="capital-reservation",
                    title=(
                        "A deferred or definitive no-fill buy still reserves cash"
                    ),
                    explanation=(
                        "Current-version replacement buys waiting for an exit, "
                        "and buys that definitively ended without a fill, must "
                        "have zero reserved cash and no active reservation row."
                    ),
                    observed_value=(
                        f"status={status}; reserved_cash_usd="
                        f"{order.get('reserved_cash_usd')}; "
                        f"reservation_state={reservation_state or 'missing'}"
                    ),
                    expected_value=(
                        "reserved_cash_usd=0 and no active reservation"
                    ),
                    blocking=True,
                    evidence_pointers=[
                        f"/stage_3/order_intents/{index}/reserved_cash_usd",
                        f"/stage_3/order_intents/{index}/reservations",
                        f"/stage_3/order_intents/{index}/"
                        "execution_metadata_json/reservation_state",
                    ],
                )
            )
        if (
            current_intent_format
            and consumed_reservation
            and status not in {"CONFIRMED", "FILLED"}
        ):
            findings.append(
                _finding(
                    code="STAGE3_RESERVATION_CONSUMED_WITHOUT_SUCCESS",
                    severity="critical",
                    stage="stage-3",
                    category="capital-reservation",
                    title=(
                        "A reservation was consumed before terminal order success"
                    ),
                    explanation=(
                        "Only a CONFIRMED or FILLED durable intent may consume "
                        "capital. Pending, deferred, failed, or cancelled intents "
                        "must retain or release it according to their evidence."
                    ),
                    observed_value=f"status={status}",
                    expected_value="CONFIRMED or FILLED",
                    blocking=True,
                    evidence_pointers=[
                        f"/stage_3/order_intents/{index}/status",
                        f"/stage_3/order_intents/{index}/reservations",
                        f"/stage_3/order_intents/{index}/"
                        "execution_metadata_json/reservation_state",
                    ],
                )
            )
        attempt_reached_remote_write_boundary = any(
            isinstance(attempt, dict)
            and bool(
                attempt.get("remote_order_id")
                or attempt.get("remote_transaction_hash")
                or attempt.get("rpc_provider")
                or (
                    isinstance(
                        attempt.get("sanitized_response_json"),
                        dict,
                    )
                    and (
                        attempt.get("sanitized_response_json") or {}
                    ).get("_stage3_immediate_sell")
                )
            )
            for attempt in attempts
        )
        remote_write_boundary_reached = bool(
            any(
                order.get(key)
                for key in (
                    "remote_order_id",
                    "remote_transaction_hash",
                    "first_submitted_at",
                    "last_submitted_at",
                )
            )
            or status
            in {
                "SUBMITTED",
                "CONFIRMING",
                "PARTIALLY_FILLED",
                "SETTLEMENT_PENDING",
                "CONFIRMED",
                "FILLED",
            }
            or attempt_reached_remote_write_boundary
        )
        buy_market_preflight = (
            execution_metadata.get("buy_market_exposure_preflight")
            if isinstance(
                execution_metadata.get(
                    "buy_market_exposure_preflight"
                ),
                dict,
            )
            else None
        )
        if (
            current_intent_format
            and action == "buy"
            and remote_write_boundary_reached
            and buy_market_preflight is None
        ):
            findings.append(
                _finding(
                    code="STAGE3_BUY_MARKET_PREFLIGHT_MISSING",
                    severity="critical",
                    stage="stage-3",
                    category="duplicate-prevention",
                    title=(
                        "A BUY crossed the remote-write boundary without its "
                        "singleton market fence"
                    ),
                    explanation=(
                        "Every current-format BUY must retain the forced-fresh "
                        "wallet lineage and the serialized singleton-account "
                        "durable-intent conflict check performed before its "
                        "cash reservation and external write."
                    ),
                    expected_value=(
                        "v1 market-wide singleton preflight with zero conflicts"
                    ),
                    blocking=True,
                    evidence_pointers=[
                        f"/stage_3/order_intents/{index}/"
                        "execution_metadata_json/"
                        "buy_market_exposure_preflight",
                        f"/stage_3/order_intents/{index}/attempts",
                    ],
                )
            )
        if (
            current_intent_format
            and action == "buy"
            and buy_market_preflight is not None
        ):
            conflict_count = _int(
                buy_market_preflight.get("conflict_count")
            )
            conflicts = (
                buy_market_preflight.get("conflicts")
                if isinstance(
                    buy_market_preflight.get("conflicts"),
                    list,
                )
                else []
            )
            target_aliases = (
                buy_market_preflight.get("target_aliases")
                if isinstance(
                    buy_market_preflight.get("target_aliases"),
                    list,
                )
                else []
            )
            normalized_target_aliases = {
                alias.strip().lower()
                for alias in target_aliases
                if isinstance(alias, str) and alias.strip()
            }
            order_aliases = {
                alias.strip().lower()
                for alias in (
                    order.get("market_id"),
                    order.get("condition_id"),
                    order.get("slug"),
                )
                if isinstance(alias, str) and alias.strip()
            }
            checked_at = _timestamp(
                buy_market_preflight.get("checked_at")
            )
            first_submitted_at = _timestamp(
                order.get("first_submitted_at")
            )
            attempt_preflight_mirrored = any(
                isinstance(attempt, dict)
                and isinstance(
                    attempt.get("sanitized_request_json"),
                    dict,
                )
                and attempt["sanitized_request_json"].get(
                    "_stage3_buy_market_exposure_preflight"
                )
                == buy_market_preflight
                for attempt in attempts
            )
            expected_visible_conflicts = min(
                conflict_count or 0,
                16,
            )
            conflict_rows_valid = bool(
                all(
                    isinstance(conflict, dict)
                    and conflict.get("intent_id")
                    and conflict.get("status")
                    and conflict.get("definitive_zero_fill") is False
                    and (
                        conflict.get("persisted_write_evidence") is True
                        or conflict.get("active_reservation") is True
                    )
                    for conflict in conflicts
                )
            )
            structural_preflight_valid = bool(
                buy_market_preflight.get("version") == "v1"
                and buy_market_preflight.get("market_wide") is True
                and buy_market_preflight.get("scope")
                == "singleton_bullpen_runtime"
                and checked_at is not None
                and 1 <= len(normalized_target_aliases) <= 3
                and bool(
                    normalized_target_aliases & order_aliases
                )
                and conflict_count is not None
                and conflict_count >= 0
                and len(conflicts) == expected_visible_conflicts
                and conflict_rows_valid
                and buy_market_preflight.get("conflicts_truncated")
                == (conflict_count > 16)
                and buy_market_preflight.get("result")
                == ("blocked" if conflict_count else "pass")
                and (
                    not remote_write_boundary_reached
                    or first_submitted_at is not None
                    and checked_at <= first_submitted_at
                )
                and attempt_preflight_mirrored
            )
            if not structural_preflight_valid:
                findings.append(
                    _finding(
                        code="STAGE3_BUY_MARKET_PREFLIGHT_INVALID",
                        severity="critical",
                        stage="stage-3",
                        category="duplicate-prevention",
                        title=(
                            "The durable BUY market fence proof is invalid"
                        ),
                        explanation=(
                            "The pre-write proof must identify the exact "
                            "economic market, singleton account scope, bounded "
                            "conflicts, timestamp, result, and identical durable "
                            "attempt mirror."
                        ),
                        expected_value=(
                            "valid v1 singleton market-wide preflight evidence"
                        ),
                        blocking=True,
                        evidence_pointers=[
                            f"/stage_3/order_intents/{index}/"
                            "execution_metadata_json/"
                            "buy_market_exposure_preflight",
                            f"/stage_3/order_intents/{index}/attempts",
                        ],
                    )
                )
            if remote_write_boundary_reached and (conflict_count or 0) > 0:
                findings.append(
                    _finding(
                        code=(
                            "STAGE3_BUY_MARKET_CONFLICT_CROSSED_WRITE_BOUNDARY"
                        ),
                        severity="critical",
                        stage="stage-3",
                        category="duplicate-prevention",
                        title=(
                            "A BUY crossed the write boundary with an unresolved "
                            "same-market intent"
                        ),
                        explanation=(
                            "A nonzero durable-intent conflict count must block "
                            "the BUY before any external write, regardless of "
                            "side or available collateral."
                        ),
                        observed_value=str(conflict_count),
                        expected_value="0",
                        blocking=True,
                        evidence_pointers=[
                            f"/stage_3/order_intents/{index}/"
                            "execution_metadata_json/"
                            "buy_market_exposure_preflight/conflicts",
                            f"/stage_3/order_intents/{index}/"
                            "first_submitted_at",
                        ],
                    )
                )
            buy_cash_preflight = (
                execution_metadata.get(
                    "buy_cash_reservation_preflight"
                )
                if isinstance(
                    execution_metadata.get(
                        "buy_cash_reservation_preflight"
                    ),
                    dict,
                )
                else None
            )
            if (
                remote_write_boundary_reached
                and buy_cash_preflight is None
            ):
                findings.append(
                    _finding(
                        code="STAGE3_BUY_CASH_PREFLIGHT_MISSING",
                        severity="critical",
                        stage="stage-3",
                        category="capital-reservation",
                        title=(
                            "A BUY crossed the remote-write boundary without "
                            "its singleton cash proof"
                        ),
                        explanation=(
                            "Every current-format BUY must preserve the exact "
                            "fresh balance timestamp, buffer, active or unseen "
                            "consumed reservations, and unreserved collateral "
                            "calculation made under the singleton account lock."
                        ),
                        expected_value=(
                            "valid v2 singleton cash preflight with result=pass"
                        ),
                        blocking=True,
                        evidence_pointers=[
                            f"/stage_3/order_intents/{index}/"
                            "execution_metadata_json/"
                            "buy_cash_reservation_preflight",
                            f"/stage_3/order_intents/{index}/attempts",
                        ],
                    )
                )
            if buy_cash_preflight is not None:
                cash_checked_at = _timestamp(
                    buy_cash_preflight.get("checked_at")
                )
                balance_checked_at = _timestamp(
                    buy_cash_preflight.get(
                        "balance_checked_at"
                    )
                )
                available_balance = _float(
                    buy_cash_preflight.get(
                        "available_balance_usd"
                    )
                )
                balance_buffer = _float(
                    buy_cash_preflight.get("balance_buffer_usd")
                )
                spendable_cash = _float(
                    buy_cash_preflight.get("spendable_cash_usd")
                )
                held_reservations = _float(
                    buy_cash_preflight.get(
                        "held_reservation_usd"
                    )
                )
                requested_order = _float(
                    buy_cash_preflight.get("requested_order_usd")
                )
                unreserved_cash = _float(
                    buy_cash_preflight.get(
                        "unreserved_cash_usd"
                    )
                )
                cash_attempt_mirrored = any(
                    isinstance(attempt, dict)
                    and isinstance(
                        attempt.get("sanitized_request_json"),
                        dict,
                    )
                    and attempt["sanitized_request_json"].get(
                        "_stage3_buy_cash_reservation_preflight"
                    )
                    == buy_cash_preflight
                    for attempt in attempts
                )
                numeric_values = (
                    available_balance,
                    balance_buffer,
                    spendable_cash,
                    held_reservations,
                    requested_order,
                    unreserved_cash,
                )
                numbers_valid = all(
                    value is not None and value >= 0
                    for value in numeric_values
                )
                expected_spendable = (
                    max(
                        0.0,
                        (available_balance or 0)
                        - (balance_buffer or 0),
                    )
                    if numbers_valid
                    else None
                )
                expected_unreserved = (
                    max(
                        0.0,
                        (spendable_cash or 0)
                        - (held_reservations or 0),
                    )
                    if numbers_valid
                    else None
                )
                proof_result_should_pass = bool(
                    numbers_valid
                    and (requested_order or 0) > 0
                    and (unreserved_cash or 0)
                    + 0.000001
                    >= (requested_order or 0)
                )
                cash_preflight_valid = bool(
                    buy_cash_preflight.get("version") == "v2"
                    and buy_cash_preflight.get("scope")
                    == "singleton_bullpen_runtime"
                    and buy_cash_preflight.get(
                        "includes_unseen_consumed_reservations"
                    )
                    is True
                    and cash_checked_at is not None
                    and balance_checked_at is not None
                    and balance_checked_at <= cash_checked_at
                    and numbers_valid
                    and (requested_order or 0) > 0
                    and abs(
                        (spendable_cash or 0)
                        - (expected_spendable or 0)
                    )
                    <= 0.011
                    and abs(
                        (unreserved_cash or 0)
                        - (expected_unreserved or 0)
                    )
                    <= 0.011
                    and buy_cash_preflight.get("result")
                    == (
                        "pass"
                        if proof_result_should_pass
                        else "blocked"
                    )
                    and (
                        not remote_write_boundary_reached
                        or first_submitted_at is not None
                        and cash_checked_at <= first_submitted_at
                        and buy_cash_preflight.get("result")
                        == "pass"
                    )
                    and cash_attempt_mirrored
                )
                if not cash_preflight_valid:
                    findings.append(
                        _finding(
                            code="STAGE3_BUY_CASH_PREFLIGHT_INVALID",
                            severity="critical",
                            stage="stage-3",
                            category="capital-reservation",
                            title=(
                                "The durable BUY singleton cash proof is "
                                "invalid"
                            ),
                            explanation=(
                                "The pre-write proof must reproduce the fresh "
                                "balance, buffer, held debit, unreserved cash, "
                                "request, timestamp order, pass result, and "
                                "identical attempt mirror."
                            ),
                            expected_value=(
                                "valid v2 singleton cash reservation preflight"
                            ),
                            blocking=True,
                            evidence_pointers=[
                                f"/stage_3/order_intents/{index}/"
                                "execution_metadata_json/"
                                "buy_cash_reservation_preflight",
                                f"/stage_3/order_intents/{index}/attempts",
                            ],
                        )
                    )
            credential_artifact = (
                wallet_snapshot_lineage.get("credential_artifact")
                if isinstance(wallet_snapshot_lineage, dict)
                and isinstance(
                    wallet_snapshot_lineage.get("credential_artifact"),
                    dict,
                )
                else {}
            )
            buy_wallet_lineage_valid = bool(
                isinstance(wallet_snapshot_lineage, dict)
                and wallet_snapshot_lineage.get("source")
                in {"live-cli", "redis-cache"}
                and wallet_snapshot_lineage.get("freshness_state")
                == "fresh"
                and _timestamp(
                    wallet_snapshot_lineage.get("fetched_at")
                )
                is not None
                and wallet_snapshot_lineage.get(
                    "position_classifier_version"
                )
                == BULLPEN_POSITION_CLASSIFIER_VERSION
                and wallet_snapshot_lineage.get("account_identity")
                and all(
                    credential_artifact.get(field_name) is not None
                    for field_name in ("inode", "mtime_ns", "size")
                )
                and isinstance(wallet_lineage_comparison, dict)
                and wallet_lineage_comparison.get("status") == "match"
                and not wallet_lineage_comparison.get("mismatches")
            )
            if remote_write_boundary_reached and not buy_wallet_lineage_valid:
                findings.append(
                    _finding(
                        code="STAGE3_BUY_WALLET_LINEAGE_PREFLIGHT_INVALID",
                        severity="critical",
                        stage="stage-3",
                        category="execution-guardrail",
                        title=(
                            "A BUY lacks valid forced-fresh wallet lineage"
                        ),
                        explanation=(
                            "The market fence must accompany a fresh Bullpen "
                            "wallet snapshot from the same account, credential "
                            "artifact, and current position classifier."
                        ),
                        blocking=True,
                        evidence_pointers=[
                            f"/stage_3/order_intents/{index}/"
                            "execution_metadata_json/"
                            "wallet_snapshot_lineage",
                            f"/stage_3/order_intents/{index}/"
                            "execution_metadata_json/"
                            "wallet_lineage_comparison",
                        ],
                    )
                )
        uncertain_write_boundary = execution_metadata.get(
            "uncertain_remote_write_boundary"
        )
        if (
            current_intent_format
            and uncertain_write_boundary is not None
        ):
            boundary_recorded_at = (
                uncertain_write_boundary.get("recorded_at")
                if isinstance(uncertain_write_boundary, dict)
                else None
            )
            boundary_timestamp = _timestamp(boundary_recorded_at)
            first_submitted_timestamp = _timestamp(
                order.get("first_submitted_at")
            )
            last_submitted_timestamp = _timestamp(
                order.get("last_submitted_at")
            )
            attempt_boundary_mirrored = any(
                isinstance(attempt, dict)
                and isinstance(
                    attempt.get("reconciliation_json"),
                    dict,
                )
                and isinstance(
                    attempt["reconciliation_json"].get(
                        "uncertain_remote_write_boundary"
                    ),
                    dict,
                )
                and attempt["reconciliation_json"][
                    "uncertain_remote_write_boundary"
                ].get("recorded_at")
                == boundary_recorded_at
                for attempt in attempts
            )
            boundary_valid = bool(
                isinstance(uncertain_write_boundary, dict)
                and _int(
                    uncertain_write_boundary.get("attempt_number")
                )
                is not None
                and uncertain_write_boundary.get(
                    "ambiguous_submission"
                )
                is True
                and uncertain_write_boundary.get(
                    "automatic_resubmission"
                )
                is False
                and execution_metadata.get(
                    "automatic_resubmission"
                )
                is False
                and boundary_timestamp is not None
                and first_submitted_timestamp is not None
                and last_submitted_timestamp is not None
                and first_submitted_timestamp
                <= boundary_timestamp
                <= last_submitted_timestamp
                and attempt_boundary_mirrored
            )
            if not boundary_valid:
                findings.append(
                    _finding(
                        code=(
                            "STAGE3_AMBIGUOUS_WRITE_BOUNDARY_EVIDENCE_INVALID"
                        ),
                        severity="critical",
                        stage="stage-3",
                        category="execution-reconciliation",
                        title=(
                            "An ambiguous write boundary lacks its durable fence"
                        ),
                        explanation=(
                            "An uncertain exchange write must retain matching "
                            "first/last submission timestamps, the boundary "
                            "timestamp and attempt mirror, and an explicit "
                            "automatic-resubmission prohibition."
                        ),
                        blocking=True,
                        evidence_pointers=[
                            f"/stage_3/order_intents/{index}/"
                            "first_submitted_at",
                            f"/stage_3/order_intents/{index}/"
                            "last_submitted_at",
                            f"/stage_3/order_intents/{index}/"
                            "execution_metadata_json/"
                            "uncertain_remote_write_boundary",
                            f"/stage_3/order_intents/{index}/attempts",
                        ],
                    )
                )
        if (
            current_intent_format
            and action == "buy"
            and status in {"CONFIRMED", "FILLED"}
            and remote_write_boundary_reached
            and not _terminal_buy_refresh_is_valid(
                execution_metadata.get(
                    "post_buy_terminal_wallet_refresh"
                )
            )
        ):
            findings.append(
                _finding(
                    code="STAGE3_TERMINAL_BUY_PORTFOLIO_REFRESH_MISSING",
                    severity="high",
                    stage="stage-3",
                    category="portfolio-publication",
                    title=(
                        "A terminal buy lacks its post-submit portfolio refresh"
                    ),
                    explanation=(
                        "Every current-version terminal buy must retain either "
                        "a bounded publication result or forced-fresh wallet "
                        "evidence with matching account, credential, and "
                        "classifier lineage."
                    ),
                    blocking=True,
                    evidence_pointers=[
                        f"/stage_3/order_intents/{index}/"
                        "execution_metadata_json/"
                        "post_buy_terminal_wallet_refresh",
                    ],
                )
            )
        operator_block = execution_metadata.get(
            "buy_reconciliation_operator_block"
        )
        operator_block_required = bool(
            current_intent_format
            and action == "buy"
            and status == "TIMED_OUT"
            and "BUY_RECONCILIATION_OPERATOR_BLOCKED"
            in str(order.get("last_error_message") or "")
        )
        if operator_block_required or operator_block is not None:
            blocked_at = (
                operator_block.get("blocked_at")
                if isinstance(operator_block, dict)
                else None
            )
            max_age_seconds = (
                _int(operator_block.get("max_age_seconds"))
                if isinstance(operator_block, dict)
                else None
            )
            age_seconds = (
                _int(operator_block.get("age_seconds"))
                if isinstance(operator_block, dict)
                else None
            )
            operator_block_valid = bool(
                current_intent_format
                and action == "buy"
                and status == "TIMED_OUT"
                and isinstance(operator_block, dict)
                and operator_block.get("version") == "v1"
                and _timestamp(blocked_at) is not None
                and max_age_seconds is not None
                and 30 <= max_age_seconds <= 24 * 60 * 60
                and age_seconds is not None
                and age_seconds >= max_age_seconds
                and operator_block.get(
                    "automatic_resubmission"
                )
                is False
                and operator_block.get(
                    "support_verification_required"
                )
                is True
                and execution_metadata.get(
                    "automatic_resubmission"
                )
                is False
                and order.get("retryable") is False
                and order.get("next_attempt_at") is None
                and "BUY_RECONCILIATION_OPERATOR_BLOCKED"
                in str(order.get("last_error_message") or "")
            )
            if not operator_block_valid:
                findings.append(
                    _finding(
                        code="STAGE3_BUY_OPERATOR_BLOCK_INVALID",
                        severity="critical",
                        stage="stage-3",
                        category="execution-reconciliation",
                        title=(
                            "Aged ambiguous buy lacks its terminal operator fence"
                        ),
                        explanation=(
                            "After the bounded reconciliation window, the buy "
                            "must be non-retryable, retain its remote evidence, "
                            "and require Bullpen support verification before "
                            "manual recovery."
                        ),
                        blocking=True,
                        evidence_pointers=[
                            f"/stage_3/order_intents/{index}/status",
                            f"/stage_3/order_intents/{index}/retryable",
                            f"/stage_3/order_intents/{index}/"
                            "execution_metadata_json/"
                            "buy_reconciliation_operator_block",
                        ],
                    )
                )
        dependent_buy_crossed_sizing_or_execution = bool(
            action == "buy"
            and dependency_group
            and (
                post_exit_sizing is not None
                or active_reservation
                or status
                in {
                    "SUBMITTING",
                    "SUBMITTED",
                    "CONFIRMING",
                    "PARTIALLY_FILLED",
                    "SETTLEMENT_PENDING",
                    "CONFIRMED",
                    "FILLED",
                }
                or remote_write_boundary_reached
            )
        )
        if (
            current_intent_format
            and dependent_buy_crossed_sizing_or_execution
        ):
            exit_confirmed_at = dependency_metadata.get(
                "exit_confirmed_at"
            )
            if not exit_confirmed_at:
                findings.append(
                    _finding(
                        code="STAGE3_DEPENDENT_BUY_EXIT_PROOF_MISSING",
                        severity="critical",
                        stage="stage-3",
                        category="dependency-guardrail",
                        title=(
                            "A dependent buy advanced without confirmed exit proof"
                        ),
                        explanation=(
                            "A replacement buy may not be dynamically sized, "
                            "reserve cash, or cross the write boundary until its "
                            "matching exit has a durable confirmation timestamp."
                        ),
                        expected_value=(
                            "dependency_metadata_json.exit_confirmed_at"
                        ),
                        blocking=True,
                        evidence_pointers=[
                            f"/stage_3/order_intents/{index}/"
                            "dependency_metadata_json/exit_confirmed_at",
                            f"/stage_3/order_intents/{index}/status",
                        ],
                    )
                )

            wallet_fetched_at = (
                wallet_snapshot_lineage.get("fetched_at")
                if wallet_snapshot_lineage is not None
                else None
            )
            sizing_valid = bool(
                post_exit_sizing is not None
                and post_exit_sizing.get("version") == "v1"
                and post_exit_sizing.get("source")
                == "forced_fresh_post_exit_balance"
                and post_exit_sizing.get("applied_at")
                and (_float(post_exit_sizing.get("order_usd")) or 0) > 0
                and wallet_snapshot_lineage is not None
                and wallet_snapshot_lineage.get("source")
                in {"live-cli", "redis-cache"}
                and wallet_snapshot_lineage.get("freshness_state") == "fresh"
                and _timestamp(wallet_fetched_at) is not None
                and _timestamp(exit_confirmed_at) is not None
                and _timestamp(wallet_fetched_at)
                > _timestamp(exit_confirmed_at)
            )
            if not sizing_valid:
                findings.append(
                    _finding(
                        code=(
                            "STAGE3_DEPENDENT_BUY_POST_EXIT_SIZING_PROOF_INVALID"
                        ),
                        severity="critical",
                        stage="stage-3",
                        category="capital-sizing",
                        title=(
                            "A dependent buy lacks fresh post-exit sizing proof"
                        ),
                        explanation=(
                            "Before a replacement buy reserves cash or reaches "
                            "execution, v1 sizing must use a force-fresh wallet "
                            "snapshot fetched after the confirmed exit and the "
                            "fresh post-exit balance."
                        ),
                        expected_value=(
                            "v1 forced_fresh_post_exit_balance sizing and a "
                            "fresh wallet lineage fetched after exit_confirmed_at"
                        ),
                        blocking=True,
                        evidence_pointers=[
                            f"/stage_3/order_intents/{index}/"
                            "execution_metadata_json/post_exit_sizing",
                            f"/stage_3/order_intents/{index}/"
                            "execution_metadata_json/wallet_snapshot_lineage",
                            f"/stage_3/order_intents/{index}/"
                            "dependency_metadata_json/exit_confirmed_at",
                        ],
                    )
                )
        if (
            order.get("action") == "redeem"
            and current_intent_format
            and remote_write_boundary_reached
        ):
            if (
                wallet_snapshot_lineage is None
                or wallet_lineage_comparison is None
            ):
                findings.append(
                    _finding(
                        code="STAGE3_REDEEM_LINEAGE_PREFLIGHT_MISSING",
                        severity="critical",
                        stage="stage-3",
                        category="execution-guardrail",
                        title=(
                            "Stage 3 redeem crossed the remote-write boundary "
                            "without wallet-lineage proof"
                        ),
                        explanation=(
                            "Current-version redeems that reached an external "
                            "provider must retain the forced-fresh wallet "
                            "snapshot and Stage 1 lineage comparison captured "
                            "before that write."
                        ),
                        blocking=True,
                        evidence_pointers=[
                            f"/stage_3/order_intents/{index}/"
                            "execution_metadata_json/wallet_snapshot_lineage",
                            f"/stage_3/order_intents/{index}/"
                            "execution_metadata_json/wallet_lineage_comparison",
                        ],
                    )
                )
            else:
                compared_fields = set(
                    wallet_lineage_comparison.get("compared_fields")
                    if isinstance(
                        wallet_lineage_comparison.get("compared_fields"),
                        list,
                    )
                    else []
                )
                required_compared_fields = {
                    "account_identity",
                    "position_classifier_version",
                    "credential_artifact.inode",
                    "credential_artifact.mtime_ns",
                    "credential_artifact.size",
                    "fetched_at_not_older",
                }
                credential_artifact = (
                    wallet_snapshot_lineage.get("credential_artifact")
                    if isinstance(
                        wallet_snapshot_lineage.get("credential_artifact"),
                        dict,
                    )
                    else {}
                )
                redeem_lineage_valid = bool(
                    wallet_snapshot_lineage.get("source")
                    in {"live-cli", "redis-cache"}
                    and wallet_snapshot_lineage.get("freshness_state")
                    == "fresh"
                    and wallet_snapshot_lineage.get(
                        "position_classifier_version"
                    )
                    == BULLPEN_POSITION_CLASSIFIER_VERSION
                    and wallet_snapshot_lineage.get("account_identity")
                    and all(
                        credential_artifact.get(field_name) is not None
                        for field_name in ("inode", "mtime_ns", "size")
                    )
                    and wallet_lineage_comparison.get("status") == "match"
                    and not wallet_lineage_comparison.get("mismatches")
                    and required_compared_fields.issubset(compared_fields)
                )
                if not redeem_lineage_valid:
                    findings.append(
                        _finding(
                            code="STAGE3_REDEEM_LINEAGE_PREFLIGHT_INVALID",
                            severity="critical",
                            stage="stage-3",
                            category="execution-guardrail",
                            title=(
                                "Stage 3 redeem lacks valid wallet-lineage proof"
                            ),
                            explanation=(
                                "Versioned redeem preflight must prove a fresh "
                                "wallet snapshot from the same Stage 1 account, "
                                "credential artifact, classifier version, and "
                                "non-older snapshot lineage."
                            ),
                            blocking=True,
                            evidence_pointers=[
                                f"/stage_3/order_intents/{index}/"
                                "execution_metadata_json/"
                                "wallet_snapshot_lineage",
                                f"/stage_3/order_intents/{index}/"
                                "execution_metadata_json/"
                                "wallet_lineage_comparison",
                            ],
                        )
                    )
        if (
            order.get("action") == "sell"
            and current_intent_format
            and remote_write_boundary_reached
            and sell_preflight is None
        ):
            findings.append(
                _finding(
                    code="STAGE3_SELL_LIVE_PREFLIGHT_MISSING",
                    severity="critical",
                    stage="stage-3",
                    category="execution-guardrail",
                    title="Stage 3 sell crossed the remote-write boundary without live preflight proof",
                    explanation=(
                        "Current-version sells that reached an external provider "
                        "or persisted remote submission evidence must retain the "
                        "fresh exposure, market, share-cap, and lineage proof "
                        "captured before that write."
                    ),
                    blocking=True,
                    evidence_pointers=[
                        f"/stage_3/order_intents/{index}/"
                        "execution_metadata_json/sell_live_preflight"
                    ],
                )
            )
        if order.get("action") == "sell" and sell_preflight is not None:
            verified_shares = _float(sell_preflight.get("verified_shares"))
            submitted_shares = _float(sell_preflight.get("submitted_shares"))
            classification = str(
                sell_preflight.get("classification") or ""
            ).lower()
            preflight_valid = bool(
                sell_preflight.get("version") == "v1"
                and sell_preflight.get("source")
                in {"live-cli", "redis-cache"}
                and sell_preflight.get("freshness_state") == "fresh"
                and sell_preflight.get("sellable") is True
                and sell_preflight.get("position_classifier_version")
                == BULLPEN_POSITION_CLASSIFIER_VERSION
                and verified_shares is not None
                and submitted_shares is not None
                and 0 < submitted_shares <= verified_shares
                and classification == "active"
            )
            if not preflight_valid:
                findings.append(
                    _finding(
                        code="STAGE3_SELL_LIVE_PREFLIGHT_INVALID",
                        severity="critical",
                        stage="stage-3",
                        category="execution-guardrail",
                        title="Stage 3 sell lacks valid fresh exposure proof",
                        explanation=(
                            "Versioned sell preflight must prove a fresh, "
                            "lineage-fenced active position and cap submitted "
                            "shares at the verified wallet amount."
                        ),
                        blocking=True,
                        evidence_pointers=[
                            f"/stage_3/order_intents/{index}/"
                            "execution_metadata_json/sell_live_preflight"
                        ],
                    )
                )
        if (
            order.get("action") == "sell"
            and order.get("last_error_code")
            in {"SELL_REQUIRES_REDEEM", "NO_SELLABLE_EXPOSURE"}
            and any(
                order.get(key)
                for key in (
                    "remote_order_id",
                    "remote_transaction_hash",
                    "first_submitted_at",
                )
            )
        ):
            findings.append(
                _finding(
                    code="STAGE3_BLOCKED_SELL_HAS_REMOTE_WRITE_REFERENCE",
                    severity="critical",
                    stage="stage-3",
                    category="execution-guardrail",
                    title="A non-sellable position has a remote sell reference",
                    explanation=(
                        "Claimable, resolved, or otherwise non-tradable exposure "
                        "must be blocked before any external sell write."
                    ),
                    blocking=True,
                    evidence_pointers=[
                        f"/stage_3/order_intents/{index}"
                    ],
                )
            )
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

    return coalesce_deterministic_findings(findings)
