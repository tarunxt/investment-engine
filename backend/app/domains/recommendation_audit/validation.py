"""Offline evidence inventory v1. No providers, database writes or investment verdicts.

This companion contract deliberately does not extend or rewrite frozen capture v1.
Only the explicit metadata projection below may enter the shareable inventory.
"""
from collections import Counter
from datetime import datetime
import re
from typing import Literal

from pydantic import Field, field_validator

from .deterministic import digest, number
from .schemas import StrictModel
from .retained_context import source_receipts, workflow_context

VERSION = "investment-validation-v1"
POLICY_FIELDS = (
    "objective", "risk_constraints", "loss_constraints", "turnover_constraints",
    "horizon", "eligible_universe", "currency", "benchmark", "benchmark_feasibility",
    "outcome_definition", "price_convention", "cost_convention", "promotion_criteria",
    "withdrawal_criteria", "minimum_effective_sample", "uncertainty_rules",
    "abstention_rules", "deterioration_rules",
)


class CurrentStrategyContext(StrictModel):
    """Current repository text, never relabelled as an original historical prompt."""
    source_kind: Literal["repository_prompt_snapshot"] = "repository_prompt_snapshot"
    repository_commit: str = Field(pattern=r"^[0-9a-f]{40}$")
    prompt_path: str
    prompt_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    original_objective: str
    original_horizon: str
    original_market_scope: str
    original_coverage_rules: str
    original_capital_unit_rules: str
    original_fallback_rules: str
    historical_prompt_version: str | None = None
    investment_validation: Literal["not_established"] = "not_established"


class ValidationContract(StrictModel):
    """A new market/strategy/version contract, independent of historical prompts."""
    schema_version: Literal["investment-validation-v1"] = VERSION
    version: str = Field(min_length=1)
    current_strategy_context: CurrentStrategyContext | None = None
    market: str | None = None
    strategy: str | None = None
    choices: dict[str, str | None] = Field(default_factory=lambda: dict.fromkeys(POLICY_FIELDS))
    approved_by: str | None = None
    approved_at: datetime | None = None
    frozen_at: datetime | None = None
    first_result_inspected_at: datetime | None = None

    @field_validator("choices")
    @classmethod
    def declared_choices(cls, value):
        if set(value) != set(POLICY_FIELDS):
            raise ValueError("Every policy choice must be explicit, including unset choices")
        return value

    @field_validator("approved_at", "frozen_at", "first_result_inspected_at")
    @classmethod
    def timestamp(cls, value):
        if value is not None and value.utcoffset() is None:
            raise ValueError("Timezone required")
        return value


def contract_gaps(contract):
    gaps = [f"contract.{key}.unset" for key in POLICY_FIELDS if not (contract.choices[key] or "").strip()]
    for key in ("market", "strategy", "approved_by", "approved_at", "frozen_at", "first_result_inspected_at"):
        if not getattr(contract, key):
            gaps.append(f"contract.{key}.unset")
    if contract.first_result_inspected_at:
        for key in ("approved_at", "frozen_at"):
            if getattr(contract, key) and getattr(contract, key) >= contract.first_result_inspected_at:
                gaps.append(f"contract.{key}.not_before_inspection")
    return gaps


def timestamp(value):
    """Unknown/naive/malformed is unknown; never substitute the current time."""
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
        return result if isinstance(result, datetime) and result.utcoffset() is not None else None
    except ValueError:
        return None


def lineage_gaps(record):
    gaps = []
    decision = timestamp(record.get("decision_at"))
    if decision is None:
        gaps.append("decision_time_unknown")
    if record.get("provenance") != "prospective":
        gaps.append("not_original_decision_time_evidence")
    if not record.get("security_id") or record.get("identity_verified") is not True:
        gaps.append("canonical_identity_unverified")
    for key in ("original_completion_at", "inputs_available_at"):
        value = timestamp(record.get(key))
        if value is None or decision is None or value > decision:
            gaps.append(f"{key}_unknown_or_future")
    for key in ("prompt_hash", "prompt_version", "formula_hash", "source_hashes", "output_ids", "input_id"):
        if not metadata_projection(record).get(key):
            gaps.append(f"{key}_missing_or_invalid")
    if record.get("formula") and record.get("formula_hash") != digest(record["formula"]):
        gaps.append("formula_hash_mismatch")
    # A stored adjusted flag cannot establish adjustment or FX vintage lineage.
    for key in ("publication_at", "adjustment_available_at", "fx_available_at"):
        value = timestamp(record.get(key))
        if value is None or decision is None or value > decision:
            gaps.append(f"{key}_unknown_or_future")
    for key in ("corporate_action_provenance", "share_unit_provenance", "fx_provenance"):
        if not record.get(key):
            gaps.append(f"{key}_missing")
    return gaps


# No account, position, amount, rationale, source text or arbitrary nested payload.
INVENTORY_FIELDS = (
    "id", "run_id", "input_id", "output_ids", "source_hashes", "prompt_hash",
    "prompt_version", "formula_hash", "decision_at", "original_completion_at",
    "inputs_available_at", "provenance", "publication_at", "adjustment_available_at",
    "fx_available_at",
)


def metadata_projection(record):
    """Reject nested values/free text in fields declared as metadata."""
    result = {}
    for key in INVENTORY_FIELDS:
        value = record.get(key)
        if key.endswith("_at"):
            result[key] = value if isinstance(value, str) and timestamp(value) else None
        elif key in {"output_ids", "source_hashes"}:
            pattern = r"[0-9a-f]{64}" if key == "source_hashes" else r"[A-Za-z0-9_.:-]{1,128}"
            result[key] = list(value) if isinstance(value, list) and len(value) <= 200 and all(isinstance(v, str) and re.fullmatch(pattern, v) for v in value) else None
        elif key.endswith("hash"):
            result[key] = value if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) else None
        else:
            result[key] = value if type(value) is int or isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value) else None
    return result


def inventory(records, population=None):
    """An archive remains an archive unless its declared denominator reconciles."""
    population = population or {}
    states = {"eligible", "excluded", "failed", "partial", "abstained", "missing", "unknown"}
    counts = Counter(r.get("population_state") if r.get("population_state") in states else "unknown" for r in records)
    declared = population.get("attempted")
    ids = [metadata_projection(r)["id"] for r in records]
    reasons = []
    if not records:
        reasons.append("population_empty")
    if type(declared) is not int or declared < 0 or declared != len(records):
        reasons.append("declared_attempted_count_missing_or_mismatched")
    if any(not value for value in ids) or len(set(ids)) != len(ids):
        reasons.append("missing_or_duplicate_record_identity")
    for key in ("source_manifest_hash", "universe_manifest_hash", "selection_limits", "pagination"):
        if population.get(key) is None:
            reasons.append(f"population.{key}.missing")
    if population.get("includes_delisted_ceased_expired") is not True:
        reasons.append("historical_universe_coverage_unverified")
    rows = []
    for record in records:
        gaps = lineage_gaps(record)
        rows.append({"evidence": metadata_projection(record),
                     "population_state": record.get("population_state") if record.get("population_state") in states else "unknown",
                     "outcome_state": record.get("outcome_state") if record.get("outcome_state") in {"known", "unknown", "unresolved", "censored", "pending_maturity"} else "unknown",
                     "freshness": freshness_assessment(record),
                     "capture_coverage": capture_coverage(record),
                     "retained_workflow_context": workflow_context(record),
                     "lineage_gaps": gaps, "lineage_checks_passed": not gaps,
                     "cost_coverage": cost_coverage(record.get("execution_costs") or {}),
                     "representation": "stored_metadata_projection_not_provider_bytes"})
    return {"observed": len(records), "declared_attempted": declared,
            "state_counts": dict(counts), "reconciled": not reasons,
            "population_gaps": reasons, "records": rows,
            "privacy_scope": "Metadata projection only; authorized source must be privacy reviewed before sharing"}


def split_gaps(rows, *, frozen_at=None, embargo_seconds=None, embargo_reason=None):
    """Validate an explicitly predeclared split; never choose dates or embargo."""
    gaps = []
    frozen = timestamp(frozen_at)
    if frozen is None:
        gaps.append("split_not_frozen")
    if type(embargo_seconds) is not int or embargo_seconds < 0 or not embargo_reason:
        gaps.append("embargo_not_justified")
        return gaps
    partitions = {name: [] for name in ("develop", "tune", "test")}
    for row in rows:
        start, end = timestamp(row.get("decision_at")), timestamp(row.get("outcome_end_at"))
        partition = row.get("partition")
        if partition not in partitions or start is None or end is None or end < start:
            gaps.append("invalid_split_row")
            continue
        inspected = timestamp(row.get("first_result_inspected_at"))
        if inspected is None:
            gaps.append("inspection_history_unknown")
        else:
            if inspected < end:
                gaps.append("outcome_window_not_mature_at_inspection")
            if frozen is None or frozen >= inspected:
                gaps.append("split_not_frozen_before_inspection")
        if not row.get("dependency_group"):
            gaps.append("dependency_group_unknown")
        partitions[partition].append((start, end, row.get("dependency_group")))
    if any(not value for value in partitions.values()):
        gaps.append("partition_empty")
    for left, right in (("develop", "tune"), ("develop", "test"), ("tune", "test")):
        for start, end, group in partitions[left]:
            for later, _, other_group in partitions[right]:
                if (later - end).total_seconds() <= embargo_seconds:
                    gaps.append("chronology_overlap_or_embargo_violation")
                if group and group == other_group:
                    gaps.append("dependency_crosses_partition")
    return sorted(set(gaps))


COST_COMPONENTS = ("commission", "spread", "slippage", "fx", "tax", "financing")


def cost_coverage(costs):
    """Known zero, missing and partial remain distinct. No synthetic defaults."""
    states = {}
    for key in COST_COMPONENTS:
        item = costs.get(key) or {}
        amount = number(item.get("value"))
        known = item.get("coverage") == "complete" and amount is not None and amount >= 0 and isinstance(item.get("source_hash"), str) and bool(re.fullmatch(r"[0-9a-f]{64}", item["source_hash"]))
        states[key] = "known_zero" if known and amount == 0 else "known" if known else "partial" if item.get("coverage") == "partial" else "unknown"
    return {"components": states, "complete": all(s in {"known", "known_zero"} for s in states.values())}


def capture_coverage(record):
    coverage = record.get("coverage") or {}
    counts = {key: value if type(value := coverage.get(key)) is int and value >= 0 else None
              for key in ("attempted", "successful", "captured_terminal")}
    if any(f.get("severity") == "error" for f in (record.get("calculation") or {}).get("findings", [])):
        state, reason = "failed", "original_deterministic_capture_gate_failed"
    elif any(value is None for value in counts.values()):
        state, reason = "unknown", "original_capture_counts_missing"
    elif counts["successful"] > counts["attempted"] or counts["captured_terminal"] > counts["attempted"]:
        state, reason = "failed", "original_capture_counts_inconsistent"
    elif counts["successful"] < counts["attempted"] or counts["captured_terminal"] < counts["attempted"]:
        state, reason = "partial", "original_capture_coverage_incomplete"
    elif counts["attempted"] == 0:
        state, reason = "unknown", "no_attempted_outputs_recorded"
    else:
        state, reason = "covered", "declared_capture_counts_reconciled"
    return {"state": state, "reason": reason, **counts}


def freshness_assessment(record):
    state = record.get("freshness_state")
    policy = record.get("freshness_policy_version")
    reason = record.get("freshness_reason_code")
    valid = lambda v: isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", v) is not None
    if state in {"current", "stale"} and valid(policy) and valid(reason):
        return {"state": state, "policy_version": policy, "reason_code": reason,
                "basis": "supplied_declaration_not_independently_verified"}
    return {"state": "unknown", "policy_version": None, "reason_code": "freshness_policy_or_assessment_missing",
            "basis": "no_age_threshold_invented"}


def evidence_states(population, contract_reasons):
    """Separate evidence states from economic verdicts; preserve overlapping gaps."""
    states = {"not_established"}
    if contract_reasons:
        states.add("contract_undefined")
    if not population["reconciled"] or any(not r["lineage_checks_passed"] for r in population["records"]):
        states.add("missing_evidence")
    for row in population["records"]:
        if row["population_state"] in {"failed", "partial"}:
            states.add(row["population_state"])
        if row["retained_workflow_context"] and row["retained_workflow_context"]["workflow_status_displayed"] == "FAILED":
            states.add("failed")
        if row["retained_workflow_context"] and "PARTIAL" in row["retained_workflow_context"]["stage_states_displayed"].values():
            states.add("partial")
        if row["capture_coverage"]["state"] in {"failed", "partial"}:
            states.add(row["capture_coverage"]["state"])
        if row["freshness"]["state"] == "stale":
            states.add("stale")
        if row["outcome_state"] == "pending_maturity":
            states.add("pending_maturity")
    return sorted(states)


def validation_report(data):
    contract = ValidationContract.model_validate(data.get("validation_contract") or {"version": "draft-unapproved"})
    population = inventory(data["records"], data.get("population"))
    split = data.get("split") or {}
    chronology_gaps = split_gaps(split.get("rows", []), frozen_at=split.get("frozen_at"),
                                 embargo_seconds=split.get("embargo_seconds"), embargo_reason=split.get("embargo_reason"))
    policy_gaps = contract_gaps(contract)
    reasons = policy_gaps + population["population_gaps"] + chronology_gaps
    if any(not row["lineage_checks_passed"] for row in population["records"]):
        reasons.append("population_has_ineligible_or_unknown_lineage")
    for index, row in enumerate(population["records"]):
        if row["population_state"] in {"failed", "partial"}:
            reasons.append(f"population.record.{index}.{row['population_state']}")
        if row["retained_workflow_context"] and row["retained_workflow_context"]["workflow_status_displayed"] == "FAILED":
            reasons.append(f"population.record.{index}.historical_workflow_failed_not_investment_outcome")
        if row["retained_workflow_context"] and "PARTIAL" in row["retained_workflow_context"]["stage_states_displayed"].values():
            reasons.append(f"population.record.{index}.historical_workflow_stage_partial_not_investment_outcome")
        if row["capture_coverage"]["state"] in {"failed", "partial", "unknown"}:
            reasons.append(f"population.record.{index}.{row['capture_coverage']['reason']}")
        if row["freshness"]["state"] == "stale":
            reasons.append(f"population.record.{index}.stale:{row['freshness']['reason_code']}")
        if row["outcome_state"] == "pending_maturity":
            reasons.append(f"population.record.{index}.outcome_pending_maturity")
    # Tooling does not perform or attest an independent economic evaluation.
    reasons.extend(["authorized_outcomes_and_execution_costs_not_reconciled",
                    "independent_untouched_test_not_performed", "confidence_event_and_labelled_cohort_not_established"])
    return {"schema_version": VERSION, "contract_version": contract.version,
            "corpus_version": "content-addressed-by-corpus-hash",
            "contract_hash": digest(contract.model_dump(mode="json")),
            "corpus_hash": digest(data["records"]), "status": "not_established",
            "evidence_states": evidence_states(population, policy_gaps),
            "reasons": reasons, "population": population,
            "retained_source_receipts": source_receipts(data.get("source_receipts") or []),
            "dimensions": {"workflow_completion": "not_assessed", "deterministic_correctness": "separate_replay",
                           "model_robustness": "not_established", "confidence_calibration": "not_established",
                           "economic_effectiveness": "not_established"}}
