"""Synthetic report tests; no database, providers, credentials or network."""
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.domains.api_usage.coverage import MAX_EVENT_ROWS, summarize_attempt_coverage


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr("socket.socket.connect", Mock(side_effect=AssertionError("offline test")))
    monkeypatch.setattr("socket.socket.connect_ex", Mock(side_effect=AssertionError("offline test")))


def event(attempt_id, *, kind="finished", provider="openai", phase="request", status="success",
          usage_status="reported", cost_status="estimated_token_only", cost_reason="listed_token_tariff",
          cost=0.1, **extra):
    return {
        "attempt_id": attempt_id, "event_kind": kind, "actual_provider": provider,
        "phase": phase, "status": status, "tariff_estimated_cost_usd": cost,
        "inferred_usage": {"coverage": {
            "version": 1, "usage_status": usage_status, "cost_status": cost_status,
            "cost_reason": cost_reason,
        }},
        **extra,
    }


def test_lifecycle_replays_and_duplicate_responses_do_not_double_charge():
    finished = event("primary")
    started = event("primary", kind="started", status="started", cost=None)
    duplicate = event("duplicate", duplicate_of_attempt_id="primary", cost=100)
    rows = [finished, started, deepcopy(finished), duplicate]
    original = deepcopy(rows)
    report = summarize_attempt_coverage(rows)
    total = report["summary"]
    assert report["replayed_event_rows"] == 1
    assert report["unique_event_rows"] == 3
    assert total["attempts"] == total["finished_attempts"] == 2
    assert total["finished_without_start"] == 1
    assert total["duplicate_attempts"] == 1
    assert total["usage_status_counts"]["reported"] == 2
    assert total["cost_status_counts"]["duplicate_excluded"] == 1
    assert total["cost_reason_counts"]["duplicate_delivery"] == 1
    assert total["known_token_estimate_attempts"] == 1
    assert total["known_token_estimate_subtotal_usd"] == 0.1
    assert report["invoice_total_usd"] is None
    assert rows == original


def test_coverage_dimensions_group_provider_phase_status_independently():
    rows = [
        event("zero", cost=0),
        event("omitted", cost=None, usage_status="omitted", cost_status="unavailable", cost_reason="usage_omitted"),
        event("unknown_tariff", provider="anthropic", cost=None, cost_status="unpriced", cost_reason="tariff_unavailable"),
        event("partial", provider="gemini", status="error", phase="retry", cost=0.2),
        event("cancelled", status="cancelled", cost=None, usage_status="unavailable", cost_status="unavailable", cost_reason="usage_unavailable"),
        event("bad_usage", cost=None, usage_status="malformed", cost_status="unavailable", cost_reason="usage_malformed"),
        event("search", provider="tavily", phase="search", cost=None, cost_status="unpriced", cost_reason="tariff_unavailable", search_result_count=0),
    ]
    report = summarize_attempt_coverage(rows)
    total = report["summary"]
    assert total["usage_status_counts"] == {"reported": 4, "omitted": 1, "malformed": 1, "unavailable": 1, "legacy_unknown": 0, "ambiguous": 0}
    assert total["known_token_estimate_attempts"] == 2
    assert total["missing_token_estimate_attempts"] == 5
    assert total["zero_token_estimate_attempts"] == 1
    assert total["known_token_estimate_subtotal_usd"] == 0.2
    assert total["known_tool_estimate_subtotal_usd"] is None
    assert total["search_attempts_without_tool_estimate"] == 1
    groups = {(row["provider"], row["phase"], row["status"]): row for row in report["groups"]}
    assert groups["gemini", "retry", "error"]["known_token_estimate_subtotal_usd"] == 0.2
    assert groups["tavily", "search", "success"]["cost_status_counts"]["unpriced"] == 1


def test_legacy_usage_and_unfinished_attempts_remain_explicitly_unknown():
    rows = [
        SimpleNamespace(**event("legacy", inferred_usage=None, reported_usage={"input_tokens": 0}, cost=0)),
        event("pending", kind="started", status="started", inferred_usage=None, cost=999),
        event("legacy_missing", inferred_usage={"basis": "old_assumption"}, cost=None),
    ]
    total = summarize_attempt_coverage(rows)["summary"]
    assert total["usage_status_counts"]["legacy_unknown"] == 3
    assert total["cost_status_counts"]["legacy_unknown"] == 3
    assert total["known_reported_usage_attempts"] == 1
    assert total["missing_reported_usage_attempts"] == 2
    assert total["unmatched_starts"] == 1
    assert total["finished_without_start"] == 2
    assert total["known_token_estimate_attempts"] == total["zero_token_estimate_attempts"] == 1
    assert total["known_token_estimate_subtotal_usd"] == 0


def test_hard_cap_consumes_one_lookahead_and_exposes_split_lifecycle_window():
    yielded = []

    def rows():
        for row in [event("a", kind="started", status="started"), event("b"), event("a"), event("c")]:
            yielded.append(row["attempt_id"])
            yield row

    report = summarize_attempt_coverage(rows(), max_event_rows=2)
    assert report["truncated"] is True
    assert report["processed_event_rows"] == 2
    assert yielded == ["a", "b", "a"]
    assert report["summary"]["unmatched_starts"] == 1
    assert report["summary"]["finished_without_start"] == 1
    assert report["scope"] == "supplied_event_window_only"
    assert summarize_attempt_coverage([event("a")], max_event_rows=1)["truncated"] is False


@pytest.mark.parametrize("limit", [0, -1, True, 1.5, MAX_EVENT_ROWS + 1])
def test_invalid_caps_are_rejected(limit):
    with pytest.raises(ValueError):
        summarize_attempt_coverage([], max_event_rows=limit)


def test_empty_missing_invalid_and_zero_costs_remain_distinct():
    assert summarize_attempt_coverage([])["summary"]["known_token_estimate_subtotal_usd"] is None
    rows = [event(str(i), cost=cost) for i, cost in enumerate([None, True, -1, float("nan"), float("inf")])]
    report = summarize_attempt_coverage([{}, event("bad", kind="other"), *rows])
    assert report["invalid_event_rows"] == 2
    assert report["summary"]["missing_token_estimate_attempts"] == 5
    assert report["summary"]["known_token_estimate_subtotal_usd"] is None
    zero = summarize_attempt_coverage([event("zero", cost=0, tool_tariff_estimated_cost_usd=0)])
    assert zero["summary"]["known_token_estimate_subtotal_usd"] == 0
    assert zero["summary"]["known_tool_estimate_subtotal_usd"] == 0
    assert zero["summary"]["zero_tool_estimate_attempts"] == 1


def test_report_does_not_return_sensitive_or_unrecognized_metadata():
    row = event("PRIVATE_ID", prompt="PRIVATE_PROMPT", provider_response_id="PRIVATE_RESPONSE", reported_usage={"private": "PRIVATE_USAGE"})
    row["inferred_usage"]["coverage"].update(usage_status="PRIVATE_STATUS", cost_reason="PRIVATE_REASON")
    report = summarize_attempt_coverage([row])
    assert "PRIVATE" not in repr(report)
    assert report["summary"]["usage_status_counts"]["legacy_unknown"] == 1


def test_reported_evidence_and_malformed_fields_are_independent_dimensions():
    row = event("mixed", cost=None, cost_status="unavailable", cost_reason="required_token_counts_missing")
    row["inferred_usage"]["coverage"].update(
        usage_sources=["response", "exception_body", "exception_body", "PRIVATE_SOURCE"],
        malformed_fields=["output_tokens", "output_tokens", "server_tool_use.web_search_requests", "PRIVATE_FIELD"],
    )
    total = summarize_attempt_coverage([row])["summary"]
    assert total["usage_status_counts"]["reported"] == 1
    assert total["attempts_with_malformed_fields"] == 1
    assert total["usage_source_counts"]["response"] == 1
    assert total["usage_source_counts"]["exception_body"] == 1
    assert total["malformed_field_counts"] == {"output_tokens": 1, "server_tool_use.web_search_requests": 1}
    assert "PRIVATE" not in repr(total)


def test_numeric_usage_presence_is_measured_separately_from_metadata_claims():
    rows = [
        event("reported_without_evidence", reported_usage={"input_tokens": None}),
        event("legacy_zero", inferred_usage=None, reported_usage={"input_tokens": 0, "output_tokens": 0}),
        event("invalid", reported_usage={"input_tokens": "12", "output_tokens": True, "total_tokens": -1}),
        event("tool_units", inferred_usage=None, reported_usage={"search_units": 2}),
        event("duplicate", reported_usage={"output_tokens": 1}, duplicate_of_attempt_id="legacy_zero"),
        event("started", kind="started", status="started", reported_usage=None),
    ]
    total = summarize_attempt_coverage(rows)["summary"]
    assert total["known_reported_usage_attempts"] == 3
    assert total["missing_reported_usage_attempts"] == 3
    assert total["usage_status_counts"]["legacy_unknown"] == 2
    assert total["usage_status_counts"]["reported"] == 4
    assert total["unmatched_starts"] == 1


def test_conflicting_finished_replay_quarantines_cost_and_uncertain_group_labels():
    first = event("same_attempt", provider="gemini", status="error", cost=0.03,
                  reported_usage={"input_tokens": 10, "output_tokens": 0})
    conflicting = event("same_attempt", provider="openai", status="success", cost=999,
                        reported_usage={"input_tokens": 1000, "output_tokens": 1000})
    report = summarize_attempt_coverage([first, conflicting, deepcopy(first)])
    assert report["replayed_event_rows"] == 1
    assert report["conflicting_event_rows"] == 1
    assert report["summary"]["attempts"] == 1
    assert report["summary"]["ambiguous_attempts"] == 1
    assert report["summary"]["known_token_estimate_attempts"] == 0
    assert report["summary"]["known_token_estimate_subtotal_usd"] is None
    assert report["summary"]["cost_status_counts"]["ambiguous"] == 1
    assert report["summary"]["cost_reason_counts"]["conflicting_event_representations"] == 1
    assert len(report["groups"]) == 1
    assert report["groups"][0]["provider"] == "unknown"
    assert report["groups"][0]["status"] == "unknown"


def test_zero_search_credits_partial_usage_and_missing_provider_ids_are_independent():
    rows = [
        event("zero_credits", provider="tavily", phase="search", cost=None,
              cost_status="unpriced", cost_reason="tariff_unavailable",
              reported_usage={"search_units": 0}),
        event("tokens_without_tariff", cost=None,
              cost_status="unpriced", cost_reason="tariff_unavailable",
              reported_usage={"input_tokens": 8, "output_tokens": 0}),
        event("partial", phase="retry", status="error", cost=None,
              cost_status="unavailable", cost_reason="required_token_counts_missing",
              reported_usage={"input_tokens": 0, "output_tokens": None}),
        event("cancelled", status="cancelled", cost=None,
              usage_status="unavailable", cost_status="unavailable", cost_reason="usage_unavailable"),
        event("start_only", kind="started", status="started", cost=None, inferred_usage=None),
    ]
    # Upstream IDs are genuinely absent; application attempt identity is enough
    # to keep all five independently observed calls in the report.
    assert all("provider_request_id" not in row and "provider_response_id" not in row for row in rows)
    report = summarize_attempt_coverage(rows)
    total = report["summary"]
    assert total["attempts"] == 5
    assert total["finished_attempts"] == 4
    assert total["unmatched_starts"] == 1
    assert total["known_reported_usage_attempts"] == 3
    assert total["missing_reported_usage_attempts"] == 2
    assert total["cost_reason_counts"]["tariff_unavailable"] == 2
    assert total["cost_reason_counts"]["required_token_counts_missing"] == 1
    assert total["known_token_estimate_subtotal_usd"] is None
    assert total["known_tool_estimate_subtotal_usd"] is None
    assert total["search_attempts_without_tool_estimate"] == 1


@pytest.mark.parametrize("replacement", [
    {"tariff_estimated_cost_usd": 0},
    {"tool_tariff_estimated_cost_usd": 0.2},
    {"status": "cancelled"},
    {"reported_usage": {"input_tokens": 5}},
    {"tariff_rates": {"input": 2, "output": 3}},
    {"provider_request_id": "different-request"},
    {"actual_model": "different-model"},
    {"inferred_usage": {"coverage": {"version": 1, "usage_status": "omitted", "cost_status": "unavailable", "cost_reason": "usage_omitted"}}},
])
def test_conflicting_accounting_projections_quarantine_the_whole_attempt(replacement):
    first = event("conflicted", reported_usage={"input_tokens": 1})
    second = {**deepcopy(first), **replacement}
    report = summarize_attempt_coverage([first, second])
    assert report["conflicting_event_rows"] == 1
    assert report["summary"]["ambiguous_attempts"] == 1
    assert report["summary"]["known_token_estimate_subtotal_usd"] is None
    assert report["summary"]["known_tool_estimate_subtotal_usd"] is None


def test_conflicting_start_quarantines_later_finish_and_identical_replays_remain_separate():
    start = event("a", kind="started", status="started", cost=None)
    conflict = {**start, "actual_provider": "gemini"}
    finished = event("a")
    report = summarize_attempt_coverage([start, deepcopy(start), conflict, finished])
    assert report["unique_event_rows"] == 2
    assert report["replayed_event_rows"] == report["conflicting_event_rows"] == 1
    assert report["summary"]["finished_attempts"] == 1
    assert report["summary"]["ambiguous_attempts"] == 1
    assert report["summary"]["known_token_estimate_subtotal_usd"] is None


def test_projection_ignores_raw_bodies_and_group_labels_are_allowlisted():
    first = event("PRIVATE_ID", provider="PRIVATE_PROVIDER", phase="PRIVATE_PHASE", status="PRIVATE_STATUS",
                  prompt="PRIVATE_PROMPT", response_body={"PRIVATE": "BODY"})
    second = {**first, "prompt": "DIFFERENT_PRIVATE_PROMPT", "response_body": {"OTHER": "BODY"}}
    report = summarize_attempt_coverage([first, second])
    assert report["replayed_event_rows"] == 1
    assert report["conflicting_event_rows"] == 0
    assert report["summary"]["known_token_estimate_subtotal_usd"] == 0.1
    group, = report["groups"]
    assert group["provider"] == group["phase"] == group["status"] == "unknown"
    assert "PRIVATE" not in repr(report)


def test_provider_identity_conflict_quarantines_linked_canonical_estimate():
    canonical = event("original", cost=0, reported_usage={"input_tokens": 0, "output_tokens": 0})
    flagged = event("conflict", cost=None, duplicate_of_attempt_id="original",
                    cost_status="ambiguous", cost_reason="conflicting_provider_identity",
                    reported_usage={"input_tokens": 20, "output_tokens": 2})
    related = event("related", cost=None, duplicate_of_attempt_id="conflict")
    independent = event("independent", cost=0.4)
    report = summarize_attempt_coverage([canonical, flagged, related, independent])
    total = report["summary"]
    assert report["provider_identity_conflict_attempts"] == 1
    assert report["linked_identity_attempts_outside_window"] == 0
    assert total["provider_identity_ambiguous_attempts"] == total["ambiguous_attempts"] == 3
    assert total["cost_reason_counts"]["conflicting_provider_identity"] == 3
    assert total["known_token_estimate_attempts"] == 1
    assert total["known_token_estimate_subtotal_usd"] == 0.4


def test_flagged_duplicate_with_canonical_outside_window_remains_unpriced():
    flagged = event("conflict", cost=999, duplicate_of_attempt_id="outside",
                    cost_status="ambiguous", cost_reason="conflicting_provider_identity")
    report = summarize_attempt_coverage([flagged])
    assert report["linked_identity_attempts_outside_window"] == 1
    assert report["summary"]["ambiguous_attempts"] == 1
    assert report["summary"]["known_token_estimate_subtotal_usd"] is None
    assert report["invoice_total_usd"] is None


def test_conflicting_usage_field_names_remain_allowlisted():
    row = event("a")
    row["inferred_usage"]["coverage"]["conflicting_fields"] = ["input_tokens", "PRIVATE_FIELD"]
    report = summarize_attempt_coverage([row])
    assert report["summary"]["attempts_with_conflicting_usage_fields"] == 1
    assert report["summary"]["conflicting_usage_field_counts"] == {"input_tokens": 1}
    assert "PRIVATE" not in repr(report)


@pytest.mark.parametrize("reverse", [False, True])
def test_flagged_request_response_bridge_quarantines_both_canonical_estimates(reverse):
    rows = [
        event("request_only", provider_request_id="PRIVATE_Q", cost=0.1),
        event("response_only", provider_response_id="PRIVATE_R", cost=0.2),
        event("bridge", provider_request_id="PRIVATE_Q", provider_response_id="PRIVATE_R",
              duplicate_of_attempt_id="request_only", cost=None,
              cost_status="ambiguous", cost_reason="conflicting_provider_identity"),
    ]
    report = summarize_attempt_coverage(reversed(rows) if reverse else rows)
    assert report["provider_identity_conflict_attempts"] == 1
    assert report["summary"]["provider_identity_ambiguous_attempts"] == 3
    assert report["summary"]["ambiguous_attempts"] == 3
    assert report["summary"]["known_token_estimate_attempts"] == 0
    assert report["summary"]["known_token_estimate_subtotal_usd"] is None
    assert "PRIVATE" not in repr(report)


def test_raw_identity_links_are_provider_and_namespace_scoped_and_only_propagate_flags():
    rows = [
        event("flagged", provider_request_id="same", cost=None,
              cost_status="ambiguous", cost_reason="conflicting_provider_identity"),
        event("other_provider", provider="gemini", provider_request_id="same", cost=0.2),
        event("other_namespace", provider_response_id="same", cost=0.3),
        event("unknown_provider", provider="unsupported", provider_request_id="same", cost=0.4),
        event("unflagged_a", provider_request_id="another", cost=0.5),
        event("unflagged_b", provider_request_id="another", cost=0.6),
    ]
    report = summarize_attempt_coverage(rows)
    assert report["summary"]["ambiguous_attempts"] == 1
    assert report["summary"]["known_token_estimate_attempts"] == 5
    assert report["summary"]["known_token_estimate_subtotal_usd"] == 2
    assert report["invoice_total_usd"] is None
