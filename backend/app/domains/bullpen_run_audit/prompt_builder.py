from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.domains.bullpen_run_audit.constants import (
    AUDIT_SECTION_KEYS,
    FEEDBACK_PROMPT_FILE,
)
from app.domains.bullpen_run_audit.provenance import REPO_ROOT, stable_sha256

REQUIRED_REPORT_KEYS = {
    "report_version",
    "executive_summary",
    "overall_grade",
    "overall_score",
    "confidence",
    "run_reliability",
    "critical_findings",
    "high_findings",
    "medium_findings",
    "low_findings",
    "stage_1_assessment",
    "stage_2_assessment",
    "stage_3_assessment",
    "handoff_assessment",
    "formula_and_algorithm_assessment",
    "guardrail_assessment",
    "execution_assessment",
    "data_capture_gaps",
    "root_cause_hypotheses",
    "recommended_changes",
    "recommended_tests",
    "priority_plan",
    "codex_prompt",
}


def _prompt_path() -> Path:
    return REPO_ROOT / FEEDBACK_PROMPT_FILE


def load_feedback_prompt_template() -> str:
    return _prompt_path().read_text(encoding="utf-8").strip()


def feedback_prompt_hash() -> str:
    return stable_sha256(load_feedback_prompt_template())


def _json_block(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)


def _section_wrapper(section_key: str, data: Any) -> dict[str, Any]:
    return {"section_key": section_key, "data": data}


def _split_large_payload(value: Any, *, max_chars: int) -> list[Any]:
    serialized = _json_block(value)
    if len(serialized) <= max_chars:
        return [value]
    if isinstance(value, list):
        chunks: list[list[Any]] = []
        current: list[Any] = []
        for item in value:
            candidate = [*current, item]
            if current and len(_json_block(candidate)) > max_chars:
                chunks.append(current)
                current = [item]
            else:
                current = candidate
        if current:
            chunks.append(current)
        return chunks or [value]
    if isinstance(value, dict):
        list_items = {key: item for key, item in value.items() if isinstance(item, list)}
        if list_items:
            largest_key = max(list_items, key=lambda key: len(_json_block(list_items[key])))
            scalars = {key: item for key, item in value.items() if key != largest_key}
            parts = _split_large_payload(value[largest_key], max_chars=max(1000, max_chars // 2))
            return [{**scalars, largest_key: part} for part in parts]
        entries = list(value.items())
        chunks: list[dict[str, Any]] = []
        current: dict[str, Any] = {}
        for key, item in entries:
            candidate = {**current, key: item}
            if current and len(_json_block(candidate)) > max_chars:
                chunks.append(current)
                current = {key: item}
            else:
                current = candidate
        if current:
            chunks.append(current)
        return chunks or [value]
    return [{"fragment": serialized[i : i + max_chars]} for i in range(0, len(serialized), max_chars)]


def plan_feedback_chunks(
    *,
    bundle: dict[str, Any],
    max_chars: int,
) -> list[dict[str, Any]]:
    section_payloads = []
    for section_key in AUDIT_SECTION_KEYS:
        payload = bundle.get(section_key.replace("-", "_"))
        if payload is None:
            payload = bundle.get(section_key)
        if payload is None:
            continue
        wrapped = _section_wrapper(section_key, payload)
        wrapped_chars = len(_json_block(wrapped))
        if wrapped_chars <= max_chars:
            section_payloads.append({"section_keys": [section_key], "payload": {section_key: payload}})
            continue
        split_parts = _split_large_payload(payload, max_chars=max_chars - 1500)
        for index, part in enumerate(split_parts, start=1):
            chunk_section_key = f"{section_key}#{index}"
            section_payloads.append(
                {
                    "section_keys": [chunk_section_key],
                    "payload": {section_key: part},
                }
            )

    chunks: list[dict[str, Any]] = []
    current_payload: dict[str, Any] = {}
    current_keys: list[str] = []
    for section_payload in section_payloads:
        candidate_payload = {**current_payload, **section_payload["payload"]}
        if current_payload and len(_json_block(candidate_payload)) > max_chars:
            chunks.append({"section_keys": current_keys, "payload": current_payload})
            current_payload = dict(section_payload["payload"])
            current_keys = list(section_payload["section_keys"])
        else:
            current_payload = candidate_payload
            current_keys.extend(section_payload["section_keys"])
    if current_payload:
        chunks.append({"section_keys": current_keys, "payload": current_payload})
    return chunks


def build_feedback_chunk_prompt(
    *,
    snapshot_hash: str | None,
    chunk_index: int,
    chunk_count: int,
    section_keys: list[str],
    payload: dict[str, Any],
) -> str:
    instructions = load_feedback_prompt_template()
    return (
        f"{instructions}\n\n"
        "You are reviewing one deterministic chunk of the Bullpen audit bundle.\n"
        "Return strict JSON only.\n"
        f"Snapshot hash: {snapshot_hash or 'unknown'}\n"
        f"Chunk: {chunk_index} of {chunk_count}\n"
        f"Chunk section coverage: {', '.join(section_keys)}\n\n"
        "Audit bundle chunk:\n"
        f"{_json_block(payload)}"
    )


def build_feedback_synthesis_prompt(
    *,
    snapshot_hash: str | None,
    chunk_reports: list[dict[str, Any]],
) -> str:
    instructions = load_feedback_prompt_template()
    return (
        f"{instructions}\n\n"
        "You are synthesizing the full Bullpen audit report from chunk-level analyses.\n"
        "Use only the supplied chunk reports. Do not invent missing data.\n"
        "Return strict JSON only.\n"
        f"Snapshot hash: {snapshot_hash or 'unknown'}\n"
        f"Chunk report count: {len(chunk_reports)}\n\n"
        "Chunk reports:\n"
        f"{_json_block(chunk_reports)}"
    )


def parse_feedback_report(raw_text: str) -> dict[str, Any]:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("Feedback response did not contain a JSON object.")
    candidate = cleaned[start : end + 1]
    payload = json.loads(candidate)
    if not isinstance(payload, dict):
        raise ValueError("Feedback response JSON must be an object.")
    missing = sorted(REQUIRED_REPORT_KEYS - set(payload))
    if missing:
        raise ValueError(
            f"Feedback response JSON is missing required keys: {', '.join(missing)}"
        )
    return payload

