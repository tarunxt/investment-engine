"""Offline, advisory checks of explicit claims against supplied output evidence.

This is deliberately not financial-language understanding or a completion gate.
It never changes rows, chooses sources, refreshes prices, or requests a repair.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass
import json
import re
from typing import Any, Mapping, Sequence

from .normalize import normalize_output, source_hash
from .schemas import NormalizationResult, Provenance
from .validation import identity, number, unknown


CONSISTENCY_VERSION = "credx-output-consistency-v1"
MAX_CONSISTENCY_DETAIL_CHECKS = 400
MAX_CONSISTENCY_REPORT_BYTES = 100_000
PRICE_TEXT_FIELDS = (
    "technical_setup", "rationale_remarks", "rationale_technical_short_term",
    "rationale_technical_medium_term", "rationale_technical_long_term",
    "rationale_fundamentals_short_term", "rationale_fundamentals_medium_long_term",
)
_DECIMAL = r"[+-]?(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?"
_CURRENCY = r"(?:USD|INR|EUR|GBP|JPY|CAD|AUD|CHF|CNY|HKD|SGD)"
_PRICE_ASSERTION = re.compile(
    r"(?:current price|price per unit)\s+(?:is\s+)?"
    r"(?P<operator>below|above|less than|greater than|at most|at least|equal to|<=|>=|<|>|=)\s*"
    rf"(?:(?P<prefix>{_CURRENCY})\s+)?(?P<amount>{_DECIMAL})"
    rf"(?:\s+(?P<suffix>{_CURRENCY}))?\.?",
    re.IGNORECASE,
)
_SOURCE_REFERENCE = re.compile(
    r"Swing(?: Trade)? (?P<kind>job|run)\s+#(?P<id>[1-9][0-9]*)"
    r"(?:\s+(?P<market>Zerodha|IndMoney US))?", re.IGNORECASE,
)
_SOURCE_SEPARATOR = re.compile(r"\s*(?:;|,|\band\b)\s*", re.IGNORECASE)


@dataclass(frozen=True)
class FrozenSwingSource:
    """Exact frozen source identity index. Build from an authorized full response."""

    job_id: int
    response_hash: str
    identities: tuple[tuple[str, str], ...]
    complete: bool
    parsing_status: str = "unknown"
    finding_counts: Mapping[str, int] | None = None
    run_id: int | None = None
    run_complete: bool = False
    market: str | None = None


@dataclass(frozen=True)
class ConsistencyCheck:
    source: Provenance
    field: str
    status: str
    code: str
    evidence: Mapping[str, Any]


@dataclass(frozen=True)
class ConsistencyReport:
    version: str
    status: str
    response_hash: str
    row_count: int
    check_counts: Mapping[str, int]
    checks: tuple[ConsistencyCheck, ...]
    detail_limit_reached: bool
    omitted_check_counts: Mapping[str, int]


def freeze_swing_source(job_id: int, content: str, *, complete: bool) -> FrozenSwingSource:
    """Index validated source rows; absence is conclusive only for a full contract.

    The caller must verify ownership, source stage/market and terminal status.
    No source content or job is fetched here. Repeated identities remain intact.
    """
    if isinstance(job_id, bool) or not isinstance(job_id, int) or job_id < 1:
        raise ValueError("A positive source job ID is required")
    result = normalize_output(content, "swing")
    identities = tuple(key for row in result.rows if row.valid and (key := identity(row.source_values)) is not None)
    return FrozenSwingSource(job_id, source_hash(content), identities,
                             complete is True and result.safe_to_replace, result.status,
                             dict(Counter(f.code for f in result.findings)))


def _source_checks(row: Any, sources: Sequence[FrozenSwingSource] | None) -> list[ConsistencyCheck]:
    value = row.source_values.get("analyst_source")

    def check(status: str, code: str, **evidence: Any) -> ConsistencyCheck:
        return ConsistencyCheck(row.source, "analyst_source", status, code, evidence)

    if unknown(value):
        return [check("unknown", "source_reference_missing")]
    # A whole-field grammar avoids treating a negated/conditional mention as a citation.
    if not isinstance(value, str) or len(value) > 4096:
        return [check("unchecked", "unsupported_source_reference")]
    parts = _SOURCE_SEPARATOR.split(value.strip())
    matches = [_SOURCE_REFERENCE.fullmatch(part) for part in parts]
    if not parts or not all(matches):
        return [check("unchecked", "unsupported_source_reference", statement_hash=source_hash(value))]
    key = identity(row.source_values)
    checks = []
    for part, match in zip(parts, matches):
        reference_id, kind = int(match.group("id")), match.group("kind").lower()
        evidence = {"statement": part, f"source_{kind}_id": reference_id}
        candidates = [source for source in sources or ()
                      if (source.job_id if kind == "job" else source.run_id) == reference_id]
        market = {"zerodha": "india", "indmoney us": "us"}.get((match.group("market") or "").lower())
        if key is None:
            checks.append(check("unknown", "row_identity_missing", **evidence))
        elif not candidates or len({item.job_id for item in candidates}) != len(candidates):
            checks.append(check("unknown", "source_unavailable" if not candidates else "source_ambiguous", **evidence))
        elif market and any(item.market != market for item in candidates):
            checks.append(check("unknown", "source_market_unverified", **evidence))
        elif kind == "run":
            matching = [item.job_id for item in candidates if key in item.identities]
            evidence.update(exchange_symbol=key[0], stock_symbol=key[1],
                            selected_job_ids=[item.job_id for item in candidates],
                            response_hashes=[item.response_hash for item in candidates],
                            matching_job_ids=matching)
            if matching:
                checks.append(check("consistent", "referenced_run_contains_identity", **evidence))
            elif all(item.run_complete and item.complete for item in candidates):
                checks.append(check("inconsistent", "referenced_run_identity_mismatch", **evidence))
            else:
                checks.append(check("unknown", "referenced_run_coverage_incomplete", **evidence))
        else:
            source = candidates[0]
            evidence.update(response_hash=source.response_hash, exchange_symbol=key[0], stock_symbol=key[1])
            if key in source.identities:
                checks.append(check("consistent", "referenced_source_contains_identity", **evidence))
            elif not source.complete:
                checks.append(check("unknown", "source_incomplete", **evidence,
                                    parsing_status=source.parsing_status, finding_counts=source.finding_counts))
            else:
                checks.append(check("inconsistent", "referenced_source_identity_mismatch", **evidence))
    return checks


def _price_checks(row: Any, field: str) -> list[ConsistencyCheck]:
    value = row.source_values.get(field)

    def check(status: str, code: str, **evidence: Any) -> ConsistencyCheck:
        return ConsistencyCheck(row.source, field, status, code, evidence)

    if unknown(value):
        return [check("unknown", "price_statement_missing")]
    if not isinstance(value, str) or len(value) > 4096:
        return [check("unchecked", "unsupported_price_statement")]
    checks = []
    # Only complete sentences are eligible. Decimal points do not split numbers;
    # conditions, negations, time qualifiers and clauses in a sentence fail fullmatch.
    for sentence_index, statement in enumerate(re.split(r"(?<=[.!?])\s+|\n+", value.strip())):
        match = _PRICE_ASSERTION.fullmatch(statement)
        if match is None:
            checks.append(check("unchecked", "unsupported_price_statement", sentence_index=sentence_index,
                                statement_hash=source_hash(statement)))
            continue
        evidence = {"statement": statement, "price_field": "price_per_unit"}
        price = number(row.source_values.get("price_per_unit"))
        threshold = number(match.group("amount"))
        prefix, suffix = (match.group(key) for key in ("prefix", "suffix"))
        currency = (prefix or suffix or "").upper()
        supplied_currency = row.source_values.get("currency")
        if price is None or threshold is None:
            checks.append(check("unknown", "supplied_price_unavailable", **evidence))
            continue
        if prefix and suffix and prefix.upper() != suffix.upper():
            checks.append(check("unknown", "comparison_currency_ambiguous", **evidence))
            continue
        if currency and (not isinstance(supplied_currency, str) or supplied_currency.strip().upper() != currency):
            checks.append(check("unknown", "comparison_currency_unverified", **evidence, comparison_currency=currency))
            continue
        operator = match.group("operator").lower()
        comparisons = {
            "below": price < threshold, "less than": price < threshold, "<": price < threshold,
            "above": price > threshold, "greater than": price > threshold, ">": price > threshold,
            "at most": price <= threshold, "<=": price <= threshold,
            "at least": price >= threshold, ">=": price >= threshold,
            "equal to": price == threshold, "=": price == threshold,
        }
        evidence.update(supplied_price=str(price), comparison_price=str(threshold), operator=operator,
                        comparison_currency=currency or None)
        consistent = comparisons[operator]
        checks.append(check("consistent" if consistent else "inconsistent",
                            "supplied_price_comparison_agrees" if consistent else "supplied_price_comparison_contradiction",
                            **evidence))
    return checks


def inspect_output_consistency(
    result: NormalizationResult, *, swing_sources: Sequence[FrozenSwingSource] | None = None,
) -> ConsistencyReport:
    """Inspect all rows without changing canonical validation or original content.

    A matching source means only exact exchange/symbol membership. A price check
    means only arithmetic consistency with this row's supplied price, never live
    accuracy, source truth, strategy quality, or a recommendation to trade.
    """
    counts = {status: 0 for status in ("consistent", "inconsistent", "unknown", "unchecked")}
    candidates: dict[str, list[tuple[int, ConsistencyCheck, int]]] = {status: [] for status in counts}
    candidate_bytes = {status: 0 for status in counts}
    ordinal = 0

    def observe(checks: Sequence[ConsistencyCheck]) -> None:
        nonlocal ordinal
        for check in checks:
            counts[check.status] += 1
            size = len(json.dumps(asdict(check), ensure_ascii=False).encode("utf-8")) + 2
            bucket = candidates[check.status]
            if len(bucket) < MAX_CONSISTENCY_DETAIL_CHECKS and candidate_bytes[check.status] + size < MAX_CONSISTENCY_REPORT_BYTES - 4096:
                bucket.append((ordinal, check, size))
                candidate_bytes[check.status] += size
            ordinal += 1

    for row in result.rows:
        observe(_source_checks(row, swing_sources))
        for field in PRICE_TEXT_FIELDS:
            observe(_price_checks(row, field))
    retained: list[tuple[int, ConsistencyCheck, int]] = []
    retained_bytes = 0
    for priority in ("inconsistent", "unknown", "consistent", "unchecked"):
        for item in candidates[priority]:
            if len(retained) < MAX_CONSISTENCY_DETAIL_CHECKS and retained_bytes + item[2] < MAX_CONSISTENCY_REPORT_BYTES - 4096:
                retained.append(item)
                retained_bytes += item[2]
    checks = tuple(item[1] for item in sorted(retained, key=lambda item: item[0]))
    retained_counts = Counter(check.status for check in checks)
    omitted_counts = {status: count - retained_counts[status] for status, count in counts.items()}
    status = ("issues_found" if counts["inconsistent"] else
              "no_supported_issues_found" if counts["consistent"] else "not_evaluated")
    return ConsistencyReport(CONSISTENCY_VERSION, status, source_hash(result.original), len(result.rows),
                             counts, checks, any(omitted_counts.values()), omitted_counts)
