"""Synthetic offline evidence checks: no provider, portfolio or market refresh."""
from dataclasses import asdict, replace
import json

import pytest

from app.domains.jobs.output_contracts import normalize_output
from app.domains.jobs.output_contracts.consistency import (
    MAX_CONSISTENCY_DETAIL_CHECKS, MAX_CONSISTENCY_REPORT_BYTES, freeze_swing_source, inspect_output_consistency,
)
from test_output_contracts import holding, rebalance_row, swing_row


def inspect(*, statement="Current price is below 120.", price=124.2, source="Swing job #1", sources=None, **extra):
    row = rebalance_row(rationale_remarks=statement, price_per_unit=price, analyst_source=source, **extra)
    result = normalize_output(json.dumps([row]), "rebalance", holdings=[holding()])
    report = inspect_output_consistency(result, swing_sources=sources)
    return result, report


def field(report, name="rationale_remarks"):
    return [check for check in report.checks if check.field == name]


@pytest.mark.parametrize("statement,price,status", [
    ("Current price is below 120.", 124.2, "inconsistent"),
    ("Current price is below120", 119, "consistent"),
    ("Price per unit >= 120", 120, "consistent"),
    ("Current price is above 120", 120, "inconsistent"),
    ("Current price is at most 120.50", "120.50", "consistent"),
    ("Current price is less than 1,200.50.", "1200.51", "inconsistent"),
    ("Current price is equal to 0.", 0, "consistent"),
])
def test_direct_present_comparisons(statement, price, status):
    result, report = inspect(statement=statement, price=price)
    check, = field(report)
    assert check.status == status
    assert check.evidence["statement"] == statement
    assert check.source == result.rows[0].source
    assert report.response_hash
    json.dumps(asdict(report))


@pytest.mark.parametrize("statement", [
    "Current price is not below 120.", "Current price may be below 120.",
    "Current price will be below 120.", "Current price was below 120.",
    "If current price is below 120, buy.", "Buy when current price is below 120.",
    "Current price is below 120 if support breaks.", "Current price is below 120 tomorrow.",
    "Current price is below 120?", 'Analyst said "current price is below 120".',
    "Current price is below 120%;", "Current price is below 120 bps.",
    "Current price is below 120 per share.", "Current price is below $120.",
    "Current price is below 120-130.", "Target is below 120.",
    "Below 120 support; reduce on weakness.", "Current price is below 120; only if weakness continues.",
])
def test_unsupported_negated_future_conditional_and_other_units_stay_unchecked(statement):
    _, report = inspect(statement=statement)
    assert all(check.status == "unchecked" for check in field(report))
    assert report.check_counts["inconsistent"] == 0


def test_explicit_sentence_inside_narrative_keeps_other_sentences_unchecked():
    _, report = inspect(statement="Weak volume persists. Current price is below 120. Buy only if momentum improves.")
    checks = field(report)
    assert [check.status for check in checks] == ["unchecked", "inconsistent", "unchecked"]
    assert checks[1].evidence["statement"] == "Current price is below 120."


@pytest.mark.parametrize("statement,currency,status", [
    ("Current price is below USD 120.", "USD", "inconsistent"),
    ("Current price is below 120 INR.", "INR", "inconsistent"),
    ("Current price is below USD 120.", None, "unknown"),
    ("Current price is below USD 120.", "INR", "unknown"),
    ("Current price is below USD 120 INR.", "USD", "unknown"),
])
def test_currency_is_explicit_never_converted(statement, currency, status):
    _, report = inspect(statement=statement, currency=currency)
    assert field(report)[0].status == status


@pytest.mark.parametrize("price", [None, "", "USD 124.2", True, "unknown", "1e99999"])
def test_missing_or_unsupported_price_stays_unknown(price):
    _, report = inspect(price=price)
    assert field(report)[0].status == "unknown"


def test_exact_referenced_source_not_union_of_other_sources():
    first = freeze_swing_source(1, json.dumps([swing_row("OTHER")]), complete=True)
    second = freeze_swing_source(2, json.dumps([swing_row("ABC")]), complete=True)
    _, report = inspect(source="Swing job #1; Swing job #2", sources=[first, second])
    checks = field(report, "analyst_source")
    assert [check.status for check in checks] == ["inconsistent", "consistent"]
    assert [check.evidence["source_job_id"] for check in checks] == [1, 2]
    assert checks[0].evidence["response_hash"] == first.response_hash


@pytest.mark.parametrize("source", ["Not Swing job #1", "If Swing job #1", "Reuters", "Run #1", "Swing job #1 or #2"])
def test_unsupported_source_claims_are_not_guessed(source):
    _, report = inspect(source=source)
    assert field(report, "analyst_source")[0].status == "unchecked"


def test_missing_ambiguous_incomplete_and_wrong_exchange_sources():
    complete = freeze_swing_source(1, json.dumps([swing_row(exchange_symbol="BSE")]), complete=True)
    incomplete = freeze_swing_source(1, json.dumps([swing_row("OTHER")]), complete=False)
    malformed = freeze_swing_source(1, "unparsed output", complete=True)
    for sources, code in [(None, "source_unavailable"), ([complete, complete], "source_ambiguous"),
                          ([incomplete], "source_incomplete"), ([malformed], "source_incomplete")]:
        _, report = inspect(sources=sources)
        check, = field(report, "analyst_source")
        assert check.status == "unknown" and check.code == code
    _, report = inspect(sources=[complete])
    assert field(report, "analyst_source")[0].status == "inconsistent"


def test_no_row_field_content_validity_or_order_loss():
    rows = [rebalance_row(symbol=f"A{i}", price_per_unit=124.2, rationale_remarks="Current price is below 120.",
                          analyst_source="Swing job #1", currency="INR", extra_evidence=f"untouched-{i}") for i in range(30)]
    original = json.dumps(rows)
    result = normalize_output(original, "rebalance", holdings=[holding(f"A{i}") for i in range(30)])
    before = asdict(result)
    source = freeze_swing_source(1, json.dumps([swing_row("OTHER")]), complete=True)
    report = inspect_output_consistency(result, swing_sources=[source])
    assert asdict(result) == before
    assert result.original == original and result.safe_to_replace
    assert report.row_count == 30 and report.check_counts["inconsistent"] == 60
    assert [row.source_values["stock_symbol"] for row in result.rows] == [f"A{i}" for i in range(30)]


def test_explicit_run_citation_is_not_job_citation_and_preserves_independent_samples():
    other = replace(freeze_swing_source(1, json.dumps([swing_row("OTHER")]), complete=True),
                    run_id=5, run_complete=True, market="india")
    matching = replace(freeze_swing_source(2, json.dumps([swing_row("ABC")]), complete=True),
                       run_id=5, run_complete=True, market="india")
    _, report = inspect(source="Swing Trade Run #5 Zerodha; Swing job #1", sources=[other, matching])
    run, job = field(report, "analyst_source")
    assert run.status == "consistent" and run.evidence["matching_job_ids"] == [2]
    assert run.evidence["selected_job_ids"] == [1, 2]
    assert job.status == "inconsistent" and job.evidence["source_job_id"] == 1
    _, report = inspect(source="Swing Trade Run #1", sources=[other, matching])
    assert field(report, "analyst_source")[0].status == "unknown"  # ID 1 is a job, not this run.


def test_run_negative_requires_server_proven_complete_coverage_but_positive_needs_known_member():
    other = replace(freeze_swing_source(1, json.dumps([swing_row("OTHER")]), complete=True), run_id=5)
    _, report = inspect(source="Swing Trade Run #5", sources=[other])
    assert field(report, "analyst_source")[0].code == "referenced_run_coverage_incomplete"
    _, report = inspect(source="Swing Trade Run #5", sources=[replace(other, run_complete=True)])
    assert field(report, "analyst_source")[0].status == "inconsistent"
    member = replace(freeze_swing_source(2, json.dumps([swing_row("ABC")]), complete=False), run_id=5)
    _, report = inspect(source="Swing Trade Run #5", sources=[other, member])
    assert field(report, "analyst_source")[0].status == "consistent"
    _, report = inspect(source="Swing Trade Run #5 IndMoney US", sources=[replace(other, market="india")])
    assert field(report, "analyst_source")[0].code == "source_market_unverified"


def test_adversarial_sentence_counts_cannot_amplify_persisted_metadata_without_bound():
    rows = [rebalance_row(symbol=f"A{i}", rationale_remarks="x. " * 1300,
                          rationale_technical_short_term="Current price is below 120.", price_per_unit=124.2)
            for i in range(10)]
    result = normalize_output(json.dumps(rows), "rebalance", holdings=[holding(f"A{i}") for i in range(10)])
    before = asdict(result)
    report = inspect_output_consistency(result)
    assert len(report.checks) <= MAX_CONSISTENCY_DETAIL_CHECKS
    assert len(json.dumps(asdict(report), ensure_ascii=False).encode("utf-8")) < MAX_CONSISTENCY_REPORT_BYTES
    assert report.check_counts["unchecked"] >= 13_000
    assert report.check_counts["inconsistent"] == 10
    assert sum(check.status == "inconsistent" for check in report.checks) == 10
    assert report.detail_limit_reached and report.omitted_check_counts["unchecked"] > 0
    assert asdict(result) == before and report.row_count == 10
