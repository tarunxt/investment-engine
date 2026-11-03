"""Bounded, explicit local-file inventory. Never opens databases or providers."""
import json
import hashlib
from pathlib import Path

from .validation import inventory


def project_retained_metadata(paths, *, max_files=200, max_bytes_per_file=2_000_000, max_records=10000):
    records, sources = [], []
    paths = list(paths)
    for raw_path in paths[:max_files]:
        path = Path(raw_path)
        source = {"path": str(path), "candidate_records": 0}
        sources.append(source)
        if not path.is_file():
            source["exclusion"] = "not_a_retained_file"
            continue
        if path.stat().st_size > max_bytes_per_file:
            source["exclusion"] = "exceeds_declared_byte_bound"
            continue
        try:
            raw = path.read_bytes()
            text = raw.decode("utf-8")
            source["stored_file_hash"] = hashlib.sha256(raw).hexdigest()
            data = json.loads(text)
        except (ValueError, UnicodeError, OSError):
            source["exclusion"] = "not_readable_json_metadata"
            continue
        rows = data.get("records", data.get("decisions", [])) if isinstance(data, dict) else data
        if not isinstance(rows, list):
            source["exclusion"] = "no_record_array"
            continue
        source["observed_rows"] = len(rows)
        for row in rows[:10000]:
            if isinstance(row, dict) and ("source_hashes" in row or "decision_at" in row and "run_id" in row):
                source["candidate_records"] += 1
                if len(records) < max_records:
                    records.append(row)
                    source["projected_records"] = source.get("projected_records", 0) + 1
                else:
                    source["selection_limit"] = "aggregate_record_bound_reached"
        if len(rows) > 10000:
            source["selection_limit"] = "10000_rows_per_source"
        if not source["candidate_records"]:
            source["exclusion"] = "no_original_recommendation_decision_metadata"
    return {"schema_version": "retained-metadata-inventory-v1", "source_inspections": sources,
            "uninspected_path_count": max(0, len(paths) - max_files),
            "population": inventory(records),
            "complete_decision_population": False,
            "missing_input": "Authorized immutable attempted/eligible decision export with original IDs, output/formula/prompt lineage and declared universe/pagination denominator"}
