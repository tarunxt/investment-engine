"""Bounded, read-only summaries of already selected attempt ledger events.

This module does not select a database window or establish invoice coverage. A
caller must supply its authorized window, and lifecycle matching stays inside
that window. No request/response bodies or identifiers are returned.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date, datetime
from math import fsum, isfinite

from app.domains.api_usage.usage_metadata import ALIASES, DETAILS, has_reported_usage, number


MAX_EVENT_ROWS = 10_000
USAGE_STATUSES = ("reported", "omitted", "malformed", "unavailable", "legacy_unknown", "ambiguous")
COST_STATUSES = (
    "estimated_token_only", "unpriced", "unavailable", "duplicate_excluded", "legacy_unknown", "ambiguous",
)
COST_REASONS = (
    "listed_token_tariff", "tariff_unavailable", "usage_unavailable", "usage_omitted",
    "usage_malformed", "required_token_counts_missing", "invalid_tariff_or_usage",
    "duplicate_delivery", "legacy_unknown", "conflicting_event_representations", "conflicting_provider_identity",
)
PROVIDERS = ("openai", "anthropic", "deepseek", "gemini", "tavily", "duckduckgo", "bing")
PHASES = ("request", "initial_generation", "tool_round", "search", "retry", "recovery", "empty_recovery", "format_repair", "row_repair")
STATUSES = ("started", "success", "error", "cancelled")
GROUP_LABELS = {"actual_provider": PROVIDERS, "phase": PHASES, "status": STATUSES}
USAGE_SOURCES = ("response", "exception", "exception_response", "exception_body", "exception_details")
MALFORMED_FIELDS = frozenset({"usage", "usage_metadata", *ALIASES, *DETAILS}) | {
    f"{container}.{name}" for container, fields in DETAILS.items() for name in fields
}


def _get(row: object, key: str):
    try:
        return row.get(key) if isinstance(row, Mapping) else getattr(row, key, None)
    except Exception:
        return None


def _label(value: object, allowed: tuple[str, ...], default: str = "unknown") -> str:
    return value if isinstance(value, str) and value in allowed else default


def _text(value: object) -> str | None:
    # Identity and tariff text stays internal to conflict comparison, never in
    # returned groups. Persisted fields are at most 255 characters.
    return value if isinstance(value, str) and len(value) <= 255 else None


def _allowed_values(value: object, allowed) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(sorted({item for item in value[:128] if isinstance(item, str) and item in allowed}))


def _cost(value: object) -> int | float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            if value >= 0 and isfinite(value):
                return value
        except OverflowError:
            pass
    return None


def _metadata(row: object):
    metadata = _get(_get(row, "inferred_usage"), "coverage")
    if _get(metadata, "version") != 1 or isinstance(_get(metadata, "version"), bool):
        return None
    return metadata


def _coverage(row: object) -> tuple[str, str, str]:
    metadata = _metadata(row)
    if metadata is None:
        return "legacy_unknown", "legacy_unknown", "legacy_unknown"
    usage_status = _get(metadata, "usage_status")
    cost_status = _get(metadata, "cost_status")
    cost_reason = _get(metadata, "cost_reason")
    return (
        usage_status if usage_status in USAGE_STATUSES else "legacy_unknown",
        cost_status if cost_status in COST_STATUSES else "legacy_unknown",
        cost_reason if cost_reason in COST_REASONS else "legacy_unknown",
    )


def _projection(row: object) -> dict:
    """A fixed-size accounting projection, never recursive/raw serialization."""
    usage = _get(row, "reported_usage")
    normalized_usage = {key: number(_get(usage, key), integral=key != "search_units") for key in ALIASES}
    normalized_usage.update({
        name: {key: number(_get(_get(usage, name), key), integral=True) for key in fields}
        for name, fields in DETAILS.items()
    })
    metadata = _metadata(row)
    usage_status, cost_status, cost_reason = _coverage(row)
    normalized_metadata = None if metadata is None else {
        "version": 1, "usage_status": usage_status, "cost_status": cost_status, "cost_reason": cost_reason,
        "usage_sources": _allowed_values(_get(metadata, "usage_sources"), USAGE_SOURCES),
        "malformed_fields": _allowed_values(_get(metadata, "malformed_fields"), MALFORMED_FIELDS),
        "conflicting_fields": _allowed_values(_get(metadata, "conflicting_fields"), MALFORMED_FIELDS),
    }
    inferred = _get(row, "inferred_usage")
    rates = _get(row, "tariff_rates")
    effective_date = _get(row, "tariff_effective_date")
    return {
        **{key: _label(_get(row, key), allowed) for key, allowed in GROUP_LABELS.items()},
        **{key: _text(_get(row, key)) for key in (
            "duplicate_of_attempt_id", "provider_request_id", "provider_response_id",
            "request_dedupe_key", "response_dedupe_key", "requested_provider",
            "requested_model", "actual_model", "tariff_version", "instrumentation_scope", "reuse_status",
        )},
        **{key: _cost(_get(row, key)) for key in (
            "tariff_estimated_cost_usd", "tool_tariff_estimated_cost_usd",
            "provider_billed_cost_usd", "tool_provider_billed_cost_usd", "allocated_cost_usd",
        )},
        "reported_usage": normalized_usage,
        "inferred_usage": {
            "basis": _text(_get(inferred, "basis")),
            "cache_read_input_tokens": number(_get(inferred, "cache_read_input_tokens"), integral=True),
            "cache_miss_input_tokens": number(_get(inferred, "cache_miss_input_tokens"), integral=True),
            "coverage": normalized_metadata,
        },
        "tariff_rates": {key: _cost(_get(rates, key)) for key in ("input", "output", "cache_hit_input", "cache_miss_input")},
        "tariff_effective_date": effective_date.isoformat() if isinstance(effective_date, (date, datetime)) else _text(effective_date),
        "search_result_count": number(_get(row, "search_result_count"), integral=True),
    }


def _new_totals() -> dict:
    return {
        "attempts": 0,
        "finished_attempts": 0,
        "unmatched_starts": 0,
        "finished_without_start": 0,
        "duplicate_attempts": 0,
        "ambiguous_attempts": 0,
        "provider_identity_ambiguous_attempts": 0,
        "known_reported_usage_attempts": 0,
        "missing_reported_usage_attempts": 0,
        "usage_status_counts": dict.fromkeys(USAGE_STATUSES, 0),
        "usage_source_counts": dict.fromkeys(USAGE_SOURCES, 0),
        "attempts_with_malformed_fields": 0,
        "malformed_field_counts": {},
        "attempts_with_conflicting_usage_fields": 0,
        "conflicting_usage_field_counts": {},
        "cost_status_counts": dict.fromkeys(COST_STATUSES, 0),
        "cost_reason_counts": dict.fromkeys(COST_REASONS, 0),
        "known_token_estimate_attempts": 0,
        "missing_token_estimate_attempts": 0,
        "zero_token_estimate_attempts": 0,
        "known_tool_estimate_attempts": 0,
        "zero_tool_estimate_attempts": 0,
        "search_attempts_without_tool_estimate": 0,
        "_token_estimates": [],
        "_tool_estimates": [],
    }


def _add_attempt(totals: dict, row: object, *, started: bool, finished: bool,
                 ambiguous: bool, identity_ambiguous: bool, known_usage: bool) -> None:
    totals["attempts"] += 1
    totals["finished_attempts"] += int(finished)
    totals["unmatched_starts"] += int(not finished)
    totals["finished_without_start"] += int(finished and not started)
    totals["known_reported_usage_attempts"] += int(known_usage)
    totals["missing_reported_usage_attempts"] += int(not known_usage)
    usage_status, cost_status, cost_reason = _coverage(row)
    duplicate = bool(_get(row, "duplicate_of_attempt_id"))
    if duplicate:
        cost_status, cost_reason = "duplicate_excluded", "duplicate_delivery"
        totals["duplicate_attempts"] += 1
    if ambiguous:
        cost_status = "ambiguous"
        cost_reason = "conflicting_provider_identity" if identity_ambiguous else "conflicting_event_representations"
        totals["ambiguous_attempts"] += 1
        totals["provider_identity_ambiguous_attempts"] += int(identity_ambiguous)
    totals["usage_status_counts"][usage_status] += 1
    totals["cost_status_counts"][cost_status] += 1
    totals["cost_reason_counts"][cost_reason] += 1
    metadata = _metadata(row)
    sources, fields = _get(metadata, "usage_sources"), _get(metadata, "malformed_fields")
    if isinstance(sources, (list, tuple)):
        for source in {value for value in sources if isinstance(value, str) and value in USAGE_SOURCES}:
            totals["usage_source_counts"][source] += 1
    if isinstance(fields, (list, tuple)):
        known_fields = {value for value in fields if isinstance(value, str) and value in MALFORMED_FIELDS}
        totals["attempts_with_malformed_fields"] += int(bool(known_fields))
        for field in sorted(known_fields):
            counts = totals["malformed_field_counts"]
            counts[field] = counts.get(field, 0) + 1
    conflicts = _allowed_values(_get(metadata, "conflicting_fields"), MALFORMED_FIELDS)
    totals["attempts_with_conflicting_usage_fields"] += int(bool(conflicts))
    for field in conflicts:
        counts = totals["conflicting_usage_field_counts"]
        counts[field] = counts.get(field, 0) + 1

    # An unmatched start is not a settled response. Duplicate delivery remains
    # a fact in the counts, even if a malformed input retained a cost on it.
    if not finished or duplicate or ambiguous:
        return
    token_cost = _cost(_get(row, "tariff_estimated_cost_usd"))
    if token_cost is None:
        totals["missing_token_estimate_attempts"] += 1
    else:
        totals["known_token_estimate_attempts"] += 1
        totals["zero_token_estimate_attempts"] += int(token_cost == 0)
        totals["_token_estimates"].append(token_cost)
    tool_cost = _cost(_get(row, "tool_tariff_estimated_cost_usd"))
    if tool_cost is not None:
        totals["known_tool_estimate_attempts"] += 1
        totals["zero_tool_estimate_attempts"] += int(tool_cost == 0)
        totals["_tool_estimates"].append(tool_cost)
    elif _get(row, "phase") == "search":
        totals["search_attempts_without_tool_estimate"] += 1


def _finish_totals(totals: dict) -> dict:
    result = dict(totals)
    for component in ("token", "tool"):
        values = result.pop(f"_{component}_estimates")
        try:
            subtotal = round(fsum(values), 12) if values else None
        except OverflowError:
            subtotal = None
        result[f"known_{component}_estimate_subtotal_usd"] = subtotal
        result[f"{component}_subtotal_overflow"] = bool(values and subtotal is None)
    return result


def summarize_attempt_coverage(
    events: Iterable[object], *, max_event_rows: int = MAX_EVENT_ROWS,
) -> dict:
    """Summarize mappings or objects, consuming at most ``max_event_rows + 1``.

    Identical accounting projections are replays. Conflicting representations
    quarantine the entire attempt's estimates. A finished event takes precedence
    over its start regardless of input order. Pairing, replay
    detection and cost deduplication describe only the supplied event window;
    absence here is not evidence that an event or charge does not exist elsewhere.
    """
    if (not isinstance(max_event_rows, int) or isinstance(max_event_rows, bool)
            or not 1 <= max_event_rows <= MAX_EVENT_ROWS):
        raise ValueError(f"max_event_rows must be an integer from 1 to {MAX_EVENT_ROWS}")

    attempts: dict[str, dict[str, dict]] = {}
    identity_links: dict[str, set[str]] = {}
    provider_identities: dict[tuple[str, str, str], str] = {}
    identity_conflicts: set[str] = set()
    consumed = replays = conflicts = invalid = 0
    truncated = False
    for index, row in enumerate(events):
        if index >= max_event_rows:
            truncated = True
            break
        consumed += 1
        attempt_id, kind = _get(row, "attempt_id"), _get(row, "event_kind")
        if not isinstance(attempt_id, str) or not attempt_id or kind not in ("started", "finished"):
            invalid += 1
            continue
        lifecycle = attempts.setdefault(attempt_id, {})
        projection = _projection(row)
        duplicate_of = projection["duplicate_of_attempt_id"]
        if duplicate_of:
            identity_links.setdefault(attempt_id, set()).add(duplicate_of)
            identity_links.setdefault(duplicate_of, set()).add(attempt_id)
        provider = projection["actual_provider"]
        if provider in PROVIDERS:
            for identity_kind in ("request", "response"):
                identity = projection[f"provider_{identity_kind}_id"]
                if not identity:
                    continue
                # Raw IDs can bridge initially disjoint request-only and
                # response-only rows even after dedupe keys were cleared.
                # Separate providers and request/response namespaces remain
                # independent. These links only propagate an existing flag.
                key = (provider, identity_kind, identity)
                first_attempt = provider_identities.setdefault(key, attempt_id)
                if first_attempt != attempt_id:
                    identity_links.setdefault(attempt_id, set()).add(first_attempt)
                    identity_links.setdefault(first_attempt, set()).add(attempt_id)
        metadata = _metadata(projection)
        if (_get(metadata, "cost_status") == "ambiguous"
                and _get(metadata, "cost_reason") == "conflicting_provider_identity"):
            identity_conflicts.add(attempt_id)
        if kind in lifecycle:
            bucket = lifecycle[kind]
            if projection == bucket["projection"]:
                replays += 1
            else:
                conflicts += 1
                bucket["ambiguous"] = True
            bucket["known_usage"] |= has_reported_usage(projection["reported_usage"])
            for name in GROUP_LABELS:
                bucket["labels"][name].add(projection[name])
            metadata = _metadata(projection)
            for name in ("usage_sources", "malformed_fields", "conflicting_fields"):
                bucket[name].update(_get(metadata, name) or ())
            continue
        metadata = _metadata(projection)
        lifecycle[kind] = {
            "projection": projection, "ambiguous": False,
            "known_usage": has_reported_usage(projection["reported_usage"]),
            "labels": {name: {projection[name]} for name in GROUP_LABELS},
            **{name: set(_get(metadata, name) or ()) for name in ("usage_sources", "malformed_fields", "conflicting_fields")},
        }

    # Propagate a persisted identity conflict through supplied duplicate links
    # and scoped raw IDs, including canonical estimates. No outside-window lookup.
    ambiguous_identity_nodes = set(identity_conflicts)
    pending = list(identity_conflicts)
    while pending:
        current = pending.pop()
        for linked in identity_links.get(current, ()):
            if linked not in ambiguous_identity_nodes:
                ambiguous_identity_nodes.add(linked)
                pending.append(linked)

    totals = _new_totals()
    groups: dict[tuple[str, str, str], dict] = {}
    for attempt_id, lifecycle in attempts.items():
        finished, started = "finished" in lifecycle, "started" in lifecycle
        bucket = lifecycle["finished" if finished else "started"]
        row = dict(bucket["projection"])
        identity_ambiguous = attempt_id in ambiguous_identity_nodes
        ambiguous = identity_ambiguous or any(item["ambiguous"] for item in lifecycle.values())
        if bucket["ambiguous"]:
            # Do not choose one contradictory provider/phase/status or usage
            # classification as authoritative. Numeric availability means some
            # supplied representation contains evidence, not that its count is trusted.
            row.update({name: next(iter(values)) if len(values) == 1 else "unknown" for name, values in bucket["labels"].items()})
            row["inferred_usage"] = {"coverage": {
                "version": 1, "usage_status": "ambiguous",
                "cost_status": "ambiguous", "cost_reason": "conflicting_event_representations",
                **{name: sorted(bucket[name]) for name in ("usage_sources", "malformed_fields", "conflicting_fields")},
            }}
        key = (
            row["actual_provider"], row["phase"], row["status"],
        )
        options = {"started": started, "finished": finished, "ambiguous": ambiguous,
                   "identity_ambiguous": identity_ambiguous, "known_usage": bucket["known_usage"]}
        _add_attempt(totals, row, **options)
        _add_attempt(groups.setdefault(key, _new_totals()), row, **options)

    return {
        "scope": "supplied_event_window_only",
        "max_event_rows": max_event_rows,
        "processed_event_rows": consumed,
        "truncated": truncated,
        "unique_event_rows": consumed - replays - conflicts - invalid,
        "replayed_event_rows": replays,
        "conflicting_event_rows": conflicts,
        "provider_identity_conflict_attempts": len(identity_conflicts),
        "linked_identity_attempts_outside_window": len(ambiguous_identity_nodes - attempts.keys()),
        "invalid_event_rows": invalid,
        "summary": _finish_totals(totals),
        "groups": [
            {"provider": provider, "phase": phase, "status": status, **_finish_totals(group)}
            for (provider, phase, status), group in sorted(groups.items())
        ],
        "invoice_total_usd": None,
        "limitations": [
            "Lifecycle pairs and replay detection are limited to the supplied event window; truncation can split pairs.",
            "Known estimates are partial tariff subtotals, not complete costs or provider bills.",
            "Missing coverage metadata is legacy_unknown; historical omission and unavailability are not inferred.",
            "Conflicting event representations quarantine all estimates for the attempt; available usage in those representations is not a trusted quantity.",
            "Persisted provider identity conflicts propagate through duplicate links and shared provider-scoped request/response IDs; this does not establish invoice deduplication.",
            "Linked identities outside this window are counted but not fetched or priced; missing or unrecognized provider identities cannot establish a bridge.",
            "Hidden SDK retries, telemetry persistence gaps and unpriced native tools are not measured by this report.",
        ],
    }
