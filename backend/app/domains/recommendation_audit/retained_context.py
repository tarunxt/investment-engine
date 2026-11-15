"""Display retained workflow metadata without promoting it to decision evidence."""
from datetime import datetime, timedelta, timezone
import re


def token(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value) else None


def instant(value):
    try:
        when = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else None
        return when if when and when.utcoffset() is not None else None
    except ValueError:
        return None


def display_time(value):
    if not isinstance(value, str):
        return None
    if value in {"Not recorded", "In progress", "Unknown", "—"}:
        return value
    return value if re.fullmatch(r"\d{1,2} [A-Za-z]{3,4} \d{4}, \d{1,2}:\d{2}:\d{2} [ap]m IST", value) else None


def conversion_state(displayed, derived):
    if not displayed or displayed in {"Not recorded", "In progress", "Unknown", "—"}:
        return "unknown" if derived is None else "derived_without_original_display"
    try:
        parsed = datetime.strptime(displayed.replace("Sept", "Sep"), "%d %b %Y, %I:%M:%S %p IST").replace(tzinfo=timezone(timedelta(hours=5, minutes=30)))
    except ValueError:
        return "displayed_time_unparseable"
    converted = instant(derived)
    return "matches_displayed_IST" if converted and converted == parsed else "derived_time_missing_or_mismatch"


STATES = {"COMPLETED", "FAILED", "QUEUED", "RUNNING", "INTERRUPTED", "CANCELLED", "PENDING", "SKIPPED", "NOT STARTED", "PARTIAL"}


def workflow_context(record):
    if not record.get("record_kind"):
        return None
    result = {"record_kind": token(record.get("record_kind")),
              "market": token(record.get("market")), "retained_source_ref": token(record.get("retained_source_ref")),
              "retained_source_line": record.get("retained_source_line") if type(record.get("retained_source_line")) is int else None,
              "workflow_status_displayed": record.get("workflow_status_displayed") if record.get("workflow_status_displayed") in STATES else "UNKNOWN",
              "time_semantics": "workflow_display_and_labelled_UTC_derivation_not_decision_or_source_availability",
              "freshness": "historical_observation_current_freshness_unknown"}
    for name in ("started", "finished"):
        original = display_time(record.get(f"workflow_{name}_displayed"))
        derived = record.get(f"workflow_{name}_at_utc_derived")
        result[f"workflow_{name}_displayed"] = original
        result[f"workflow_{name}_at_utc_derived"] = derived if instant(derived) else None
        result[f"{name}_conversion_check"] = conversion_state(original, derived)
    stages = record.get("stage_states_displayed") or {}
    result["stage_states_displayed"] = {key: value for key, value in stages.items()
        if isinstance(key, str) and re.fullmatch(r"[A-Za-z0-9 _-]{1,100}", key) and isinstance(value, str) and value in STATES} if isinstance(stages, dict) else {}
    result["stage_coverage"] = "retained_name_status_pairs_only_absence_not_proof_of_skipped_or_missing_stage"
    return result


def source_receipts(sources):
    result = []
    for source in sources[:200]:
        checksum = source.get("sha256")
        result.append({"ref": token(source.get("ref")), "source_type": token(source.get("source_type")),
                       "sha256": checksum if isinstance(checksum, str) and re.fullmatch(r"[0-9a-f]{64}", checksum) else None,
                       "bytes": source.get("bytes") if type(source.get("bytes")) is int and source["bytes"] >= 0 else None,
                       "exact_capture_time_utc": source.get("exact_capture_time_utc") if instant(source.get("exact_capture_time_utc")) else None,
                       "verification_receipt_at_utc": source.get("verification_receipt_at_utc") if instant(source.get("verification_receipt_at_utc")) else None,
                       "capture_context_build_sha": token(source.get("capture_context_build_sha")),
                       "raw_source_transferred": source.get("raw_source_transferred") is True,
                       "verification": "transferred_receipt_declaration_not_independent_original_bytes_verification"})
    return result
