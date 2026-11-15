"""Partial-use status and bounded, read-only recovery of old missing-cell failures."""
from functools import lru_cache

PARTIAL_CODES = frozenset({"missing_field_excluded", "unaligned_rationale"})
PARTIAL_NOTICE = "LLM output is partially used: available rows and values are retained; missing or unaligned values are excluded from calculations."


def has_partial_output(metadata):
    validation = (metadata or {}).get("deterministic_output") or {}
    return validation.get("safe_to_render") is True and any(
        validation.get("finding_counts", {}).get(code, 0) for code in PARTIAL_CODES
    )


@lru_cache(maxsize=16)
def recover_missing_cells(prompt, content):
    from .output_runtime import declares_output_contract, holdings_from_prompt
    from .output_contracts import normalize_output, REBALANCE_COLUMNS, parse_markdown
    from .output_contracts.validation import aliases, header_key, identity
    if len(prompt) + len(content) > 1_048_576 or not declares_output_contract(prompt, "rebalance"):
        return None
    holdings = holdings_from_prompt(prompt)
    if holdings is None:
        return None
    # Only explicitly supplied input identities can authorize a non-buy candidate.
    known = aliases(REBALANCE_COLUMNS)
    candidates = set()
    for block in parse_markdown(prompt)[0]:
        if block.kind != "table":
            continue
        keys = [known.get(header_key(h)) for h in block.headers]
        for cells in block.rows:
            key = identity(dict(zip(keys, cells)))
            if key:
                candidates.add(key)
    result = normalize_output(content, "rebalance", holdings=holdings, derive_arithmetic=True,
                              non_buy_candidates=frozenset(candidates))
    if not result.safe_to_replace or not any(f.code in PARTIAL_CODES for f in result.findings):
        return None
    return result


def project_partial_output(job):
    """Modify a response DTO only; never mutate an ORM job or frozen evidence."""
    from .output_contracts import source_hash
    from dataclasses import asdict
    from collections import Counter
    from app.shared.types import JobStatus
    if job.status == JobStatus.COMPLETED and has_partial_output(job.runtime_metadata_json):
        job.status = JobStatus.PARTIAL
        job.error_message = PARTIAL_NOTICE
    elif (job.status == JobStatus.FAILED and job.response
          and "invalid output contract" in (job.error_message or "").lower()):
        recovered = recover_missing_cells(job.prompt, job.response)
        if recovered is not None:
            # Keep dated validation evidence separate from the read projection's findings.
            job.runtime_metadata_json = {**(job.runtime_metadata_json or {}),
                "partial_recovery": {"original_status": "failed", "original_error": job.error_message,
                                     "policy": "missing-cell-read-projection-v1",
                                     "original_deterministic_output": (job.runtime_metadata_json or {}).get("deterministic_output"),
                                     "original_response_hash": source_hash(job.response)},
                "deterministic_output": {"status": "valid", "safe_to_render": True,
                    "usage_status": "partial", "coverage": asdict(recovered.coverage),
                    "finding_counts": dict(Counter(f.code for f in recovered.findings))}}
            job.response = recovered.content
            job.status = JobStatus.PARTIAL
            job.error_message = PARTIAL_NOTICE
    return job
