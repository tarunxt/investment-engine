"""Offline contracts for the format-only path; no provider or database calls."""

import json
from pathlib import Path

import pytest

from app.domains.jobs.output_contracts import (
    CONTRACT_VERSION, REBALANCE_COLUMNS, SWING_COLUMNS, contract_hash, export_tables,
    normalize_output, parse_markdown, render_document, source_hash,
)
from app.domains.jobs.output_contracts.document import cell_text
from app.domains.jobs.output_contracts.validation import number


def swing_row(symbol="ABC", **overrides):
    row = {column.key: f"Supplied {column.key}" for column in SWING_COLUMNS}
    row.update({column.key: 0 for column in SWING_COLUMNS if column.key.startswith("score_rationale_")})
    row.update(llm_name_model="Provider / Model 1", exchange_symbol="NSE", stock_symbol=symbol,
               stock_name="Supplied company", entry_range="100-105", stop_loss=95, target=120,
               units_to_buy=2, price_per_unit=100, total_buy_amount=200, upside_horizon=20,
               weeks=8, confidence_score=80, run_number=1, run_date="2026-10-02", run_time="15:30:00", llm="Model 1")
    row.update(overrides)
    return row


def rebalance_row(symbol="ABC", **overrides):
    source = swing_row(symbol)
    row = {column.key: source.get(column.key) for column in REBALANCE_COLUMNS}
    row.update(current_units=10, action="Hold", units_change=0, final_units=10, units_to_buy=0, total_buy_amount=0)
    row.update(overrides)
    return row


def table(columns, rows):
    """Independent simple fixture serializer: fixture cells have no literal pipes."""
    headers = [column.label for column in columns]
    return "\n".join(["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in columns) + " |",
                      *("| " + " | ".join(str(row.get(column.key, "")) for column in columns) + " |" for row in rows)])


def codes(result):
    return {finding.code for finding in result.findings if finding.severity == "error"}


def holding(symbol="ABC", exchange="NSE", units=10, **extras):
    return dict(exchange_symbol=exchange, stock_symbol=symbol, current_units=units, **extras)


def test_contract_columns_match_frontend_exactly():
    root = Path(__file__).resolve().parents[2]
    swing = (root / "frontend/lib/swingTrade.ts").read_text()
    rebalance = (root / "frontend/lib/rebalance.ts").read_text()
    for columns, source, size in [(SWING_COLUMNS, swing, 31), (REBALANCE_COLUMNS, rebalance, 29)]:
        assert len(columns) == size
        assert "| " + " | ".join(column.label for column in columns) + " |" in source
        assert len({column.key for column in columns}) == size


@pytest.mark.parametrize("kind,columns,rows,holdings", [
    ("swing", SWING_COLUMNS, [swing_row()], None),
    ("rebalance", REBALANCE_COLUMNS, [rebalance_row()], [holding()]),
])
def test_parse_canonical_markdown_export_parse_roundtrip(kind, columns, rows, holdings):
    original = "## Supplied title\n\n" + table(columns, rows) + "\n\nSupplied dissent: watch liquidity.\n"
    result = normalize_output(original, kind, holdings=holdings)
    assert result.safe_to_replace, result.findings
    again = normalize_output(result.content, kind, holdings=holdings)
    assert again.safe_to_replace, again.findings
    assert result.rows[0].values == again.rows[0].values
    exports = export_tables(result)
    assert len(exports) == 1
    assert len(exports[0].headers) == len(columns)
    assert exports[0].rows[0] == tuple(result.rows[0].values[c.key] for c in columns)
    assert result.content.endswith("Supplied dissent: watch liquidity.\n")


def test_sixty_unique_rows_across_chunks_preserve_all_dimensions_and_prose():
    from app.domains.jobs.output_contracts.schemas import Column

    extras = (Column("source_id", "Evidence ID"), Column("currency", "Currency"), Column("dissent", "Dissent"))
    fragments = []
    for chunk in range(5):
        rows = [swing_row(f"STOCK{index}", llm=f"model-{chunk}", source_id=f"id-{index}",
                          currency="INR", dissent=f"Source dissent {index}") for index in range(chunk * 12, (chunk + 1) * 12)]
        fragments.append(f"## Chunk {chunk}\nAnalyst context {chunk}.\n\n" + table((*SWING_COLUMNS, *extras), rows) + f"\n\nCaveat {chunk}.\n")
    original = "\n".join(fragments) + "\n| Source | Limitation |\n| --- | --- |\n| A | Stale event date |\n| B | Disagrees |\n"
    result = normalize_output(original, "swing", minimum_rows=5)
    assert result.safe_to_replace, result.findings
    assert result.coverage.source_rows == 62
    assert result.coverage.canonical_rows == result.coverage.validated_rows == 60
    assert result.coverage.source_fragments == result.coverage.preserved_fragments
    assert len({row.values["stock_symbol"] for row in result.rows}) == 60
    assert len(result.tables) == 5
    assert sum(len(export.rows) for export in export_tables(result)) == 62
    for index, row in enumerate(result.rows):
        assert row.values["extra:Evidence ID"] == f"id-{index}"
        assert row.values["extra:Dissent"] == f"Source dissent {index}"
        assert row.values["currency"] == "INR"
        assert len(row.source_values) == 34
    for chunk in range(5):
        assert f"Analyst context {chunk}." in result.content
        assert f"Caveat {chunk}." in result.content
    assert "Stale event date" in result.content
    again = normalize_output(result.content, "swing")
    assert [row.values for row in again.rows] == [row.values for row in result.rows]


def test_repeated_ticker_and_model_are_not_deduplicated():
    original = table(SWING_COLUMNS, [swing_row(rationale_remarks=f"Distinct source {i}") for i in range(12)])
    result = normalize_output(original, "swing")
    assert result.safe_to_replace
    assert len(result.rows) == 12
    assert {row.values["rationale_remarks"] for row in result.rows} == {f"Distinct source {i}" for i in range(12)}


def test_all_numerical_zeroes_are_values_not_missing():
    row = swing_row(entry_range="0", stop_loss=0, target=0, units_to_buy=0, price_per_unit=0,
                    total_buy_amount=0, upside_horizon=0, weeks=0, confidence_score=0, run_number=0)
    result = normalize_output(json.dumps([row]), "swing")
    assert result.safe_to_replace, result.findings
    assert result.rows[0].values["score_rationale_cruxx"] == 0
    assert result.rows[0].values["units_to_buy"] == 0


@pytest.mark.parametrize("invalid", [True, False, float("nan"), float("inf"), float("-inf"), "NaN", "Infinity", "1e99999999", "1e-99999999", "USD 100", "100 USD", "13 weeks", "12%", {}, []])
def test_bad_numbers_fail_without_replacing_or_dropping_rows(invalid):
    original = json.dumps([swing_row("GOOD"), swing_row("BAD", price_per_unit=invalid)])
    result = normalize_output(original, "swing")
    assert not result.safe_to_replace
    assert result.status == "partial"
    assert result.content == result.original == original
    assert result.coverage.canonical_rows == 2
    assert result.coverage.validated_rows == 1
    assert "invalid_number" in codes(result)


@pytest.mark.parametrize("unknown", [None, "", "unknown", "N/A", "Not found", "—"])
def test_unknown_required_fields_stay_unknown(unknown):
    original = json.dumps([swing_row(score_rationale_cruxx=unknown)])
    result = normalize_output(original, "swing")
    assert result.rows[0].values["score_rationale_cruxx"] == unknown
    assert result.content == original
    assert "required_field_unknown" in codes(result)


@pytest.mark.parametrize("score", [-4, 4, 2.0, "2.0", "2%", "bullish", "1-3"])
def test_no_rationale_score_inference_or_relaxed_integer_contract(score):
    original = json.dumps([swing_row(score_rationale_cruxx=score, rationale_remarks="Very bullish breakout")])
    result = normalize_output(original, "swing")
    assert not result.safe_to_replace
    assert result.rows[0].values["score_rationale_cruxx"] == score
    assert result.content == original


def test_authoritative_metadata_fills_missing_fields_but_preserves_existing_provenance():
    row = swing_row()
    del row["run_number"]
    del row["llm"]
    row["run_time"] = ""
    result = normalize_output(json.dumps([row]), "swing", metadata={"run_number": 7, "llm": "persisted model",
                                                                               "run_time": "01:00", "llm_name_model": "do not overwrite"})
    assert result.safe_to_replace, result.findings
    assert result.rows[0].values["run_number"] == 7
    assert result.rows[0].values["llm"] == "persisted model"
    assert result.rows[0].values["llm_name_model"] == "Provider / Model 1"
    assert set(result.rows[0].filled_fields) == {"run_number", "llm", "run_time"}
    assert "run_number" not in result.rows[0].source_values
    null = normalize_output(json.dumps([swing_row(run_number=None)]), "swing", metadata={"run_number": 7})
    assert not null.safe_to_replace
    assert null.rows[0].values["run_number"] is None


def test_metadata_cannot_fill_price_stop_score_or_judgment():
    original = json.dumps([swing_row(technical_setup=None, stop_loss=None)])
    result = normalize_output(original, "swing", metadata={"stop_loss": 90, "technical_setup": "Invented"})
    assert "unsupported_metadata" in codes(result)
    assert result.rows[0].values["stop_loss"] is None
    assert result.rows[0].values["technical_setup"] is None


def test_no_missing_qualitative_column_is_invented():
    row = swing_row()
    del row["analyst_source"]
    del row["rationale_fundamentals_short_term"]
    original = json.dumps([row])
    result = normalize_output(original, "swing")
    assert not result.safe_to_replace
    assert "analyst_source" not in result.rows[0].values
    assert "rationale_fundamentals_short_term" not in result.rows[0].values
    assert result.content == original


def test_holdings_require_exact_exchange_identity_and_complete_coverage():
    rows = [rebalance_row("ABC"), rebalance_row("ABC", exchange_symbol="BSE", current_units=5, final_units=5)]
    snapshot = [holding(), holding(exchange="BSE", units=5)]
    result = normalize_output(json.dumps(rows), "rebalance", holdings=snapshot)
    assert result.safe_to_replace, result.findings
    assert result.coverage.expected_holdings == result.coverage.covered_holdings == 2
    missing = normalize_output(json.dumps(rows[:1]), "rebalance", holdings=snapshot)
    assert "missing_holding" in codes(missing)
    assert missing.coverage.covered_holdings == 1
    assert not missing.safe_to_replace
    no_snapshot = normalize_output(json.dumps(rows), "rebalance")
    assert "missing_snapshot" in codes(no_snapshot)
    assert no_snapshot.coverage.expected_holdings is None


def test_missing_current_units_only_copy_from_snapshot_and_final_units_need_opt_in():
    row = rebalance_row()
    del row["current_units"]
    del row["final_units"]
    original = json.dumps([row])
    result = normalize_output(original, "rebalance", holdings=[holding()], derive_arithmetic=True)
    assert result.safe_to_replace, result.findings
    assert result.rows[0].values["current_units"] == 10
    assert result.rows[0].values["final_units"] == "10"
    assert set(result.rows[0].filled_fields) == {"current_units", "final_units"}
    no_arithmetic = normalize_output(original, "rebalance", holdings=[holding()])
    assert not no_arithmetic.safe_to_replace
    assert "final_units" not in no_arithmetic.rows[0].values
    no_snapshot = normalize_output(original, "rebalance", holdings=[], derive_arithmetic=True)
    assert not no_snapshot.safe_to_replace
    assert "current_units" not in no_snapshot.rows[0].values


def test_missing_buy_new_current_units_are_not_assumed_zero():
    row = rebalance_row(action="Buy New", current_units=None, units_change=1, final_units=1, units_to_buy=1, total_buy_amount=100)
    original = json.dumps([row])
    result = normalize_output(original, "rebalance", holdings=[], derive_arithmetic=True)
    assert not result.safe_to_replace
    assert result.rows[0].values["current_units"] is None


@pytest.mark.parametrize("action,delta,final,buy,amount", [
    ("Hold", 0, 10, 0, 0), ("Trim", -4, 6, 0, 0), ("Sell All", -10, 0, 0, 0),
    ("Buy", 2, 12, 2, 200), ("Add", 2, 12, 2, 200), ("Buy/Add", 2, 12, 2, 200),
])
def test_valid_actions_and_arithmetic(action, delta, final, buy, amount):
    row = rebalance_row(action=action, units_change=delta, final_units=final, units_to_buy=buy, total_buy_amount=amount)
    result = normalize_output(json.dumps([row]), "rebalance", holdings=[holding()])
    assert result.safe_to_replace, result.findings


@pytest.mark.parametrize("overrides", [
    {"units_change": 1}, {"final_units": 9}, {"action": "Sell All", "units_change": -9, "final_units": 1},
    {"action": "Trim", "units_change": -10, "final_units": 0}, {"action": "Add", "units_change": -1, "final_units": 9},
    {"current_units": 11, "final_units": 11}, {"units_to_buy": 1, "total_buy_amount": 100},
    {"total_buy_amount": 20}, {"action": "Buy New"}, {"action": {}},
])
def test_action_contradictions_preserve_original(overrides):
    original = json.dumps([rebalance_row(**overrides)])
    result = normalize_output(original, "rebalance", holdings=[holding()], derive_arithmetic=True)
    assert not result.safe_to_replace
    assert result.content == original


def test_fresh_buy_fractional_currency_arithmetic_and_no_exchange_rewriting():
    row = rebalance_row("AMZN", exchange_symbol="NASDAQ", current_units=0, action="Buy New", units_change=0.081,
                        final_units=0.081, units_to_buy=0.081, price_per_unit=246, total_buy_amount=19.93,
                        currency="USD")
    result = normalize_output(json.dumps([row]), "rebalance", holdings=[])
    assert result.safe_to_replace, result.findings
    assert result.rows[0].values["exchange_symbol"] == "NASDAQ"
    assert result.rows[0].values["currency"] == "USD"
    mismatch = normalize_output(json.dumps([rebalance_row(currency="USD")]), "rebalance", holdings=[holding(currency="INR")])
    assert "currency_mismatch" in codes(mismatch)


def test_duplicate_rebalance_decisions_and_invalid_snapshot_stay_visible():
    original = json.dumps([rebalance_row(), rebalance_row(rationale_remarks="Dissent")])
    result = normalize_output(original, "rebalance", holdings=[holding()])
    assert "duplicate_decision" in codes(result)
    assert len(result.rows) == 2
    assert result.content == original
    bad_snapshot = normalize_output(json.dumps([rebalance_row()]), "rebalance", holdings=[holding(units=True)])
    assert "invalid_holding" in codes(bad_snapshot)
    duplicate_snapshot = normalize_output(json.dumps([rebalance_row()]), "rebalance", holdings=[holding(), holding()])
    assert "duplicate_holding" in codes(duplicate_snapshot)
    assert duplicate_snapshot.coverage.expected_holdings == 2


def test_literal_pipes_newlines_entities_backslashes_and_boundary_spaces_roundtrip():
    text = "  source | dissent\nsecond line\r\n\\path \\| literal &#124; <br> & <tag>\t  "
    row = swing_row(rationale_remarks=text, analyst_source="https://example.test/?a=1&b=2")
    result = normalize_output(json.dumps([row]), "swing")
    assert result.safe_to_replace, result.findings
    assert "&#124;" in result.content and "&#10;" in result.content
    again = normalize_output(result.content, "swing")
    assert again.safe_to_replace, again.findings
    assert again.rows[0].values["rationale_remarks"] == text
    assert export_tables(result)[0].rows[0][15] == text
    escaped_original = table(SWING_COLUMNS, [swing_row(rationale_remarks=r"Supply \| demand")])
    parsed = normalize_output(escaped_original, "swing")
    assert parsed.safe_to_replace, parsed.findings
    assert parsed.rows[0].values["rationale_remarks"] == "Supply | demand"


@pytest.mark.parametrize("original", ["", "nothing tabular", "| Stock Symbol | Technical Setup |\n| ABC | unknown |", "[]", "{}", "[", "{\"stocks\":[]}", "[false]"])
def test_malformed_and_empty_data_fail_closed(original):
    result = normalize_output(original, "swing")
    assert not result.safe_to_replace
    assert result.content == original
    with pytest.raises(ValueError):
        export_tables(result)


def test_missing_extra_cells_and_duplicate_aliases_cannot_overwrite_source():
    original = table(SWING_COLUMNS, [swing_row()]) + "\n| extra | malformed |"
    result = normalize_output(original, "swing")
    assert "row_width" in codes(result)
    assert len(result.rows) == 2
    assert result.content == original
    duplicate = json.dumps([dict(swing_row(), **{"Stock Symbol": "Different"})])
    result = normalize_output(duplicate, "swing")
    assert "duplicate_columns" in codes(result)
    assert result.content == duplicate
    duplicate_json = json.dumps([swing_row()]).replace('"ABC"', '"ABC", "stock_symbol": "OTHER"')
    assert "duplicate_json_key" in codes(normalize_output(duplicate_json, "swing"))


def test_json_envelope_notes_are_never_silently_lost():
    original = json.dumps({"stocks": [swing_row()], "dissent": "Do not claim complete"})
    result = normalize_output(original, "swing")
    assert "unsupported_json_envelope" in codes(result)
    assert result.content == original


def test_minimum_row_policy_never_discards_rows():
    original = json.dumps([swing_row("ONE")])
    result = normalize_output(original, "swing", minimum_rows=5)
    assert "insufficient_rows" in codes(result)
    assert len(result.rows) == 1 and result.content == original


@pytest.mark.parametrize("kind", ["technical", "threat", "document"])
def test_generic_documents_preserve_every_block_without_claiming_semantic_validation(kind):
    original = "## Summary\nRisk assessment and minority opinion.\n\n"
    original += "\n".join(f"## Table {i}: Supplied section\n| Exchange | Stock Symbol | Detail |\n| --- | --- | --- |\n| NSE | ABC | Section {i} risk \\| dissent |\n" for i in range(1, 11))
    original += "\n## Bottom Line\nA supplied qualified conclusion.\n"
    result = normalize_output(original, kind)
    assert result.status == "preserved"
    assert not result.safe_to_replace
    assert result.content == original
    assert result.coverage.source_rows == 10
    assert sum(block.kind == "table" for block in result.blocks) == 10
    assert render_document(result.blocks) == original
    blocks, findings = parse_markdown(original)
    assert not findings
    assert render_document(blocks) == original


def test_technical_eight_column_table_and_unknown_levels_are_preserved():
    original = "| Exchange Symbol | Stock Symbol | Primary Setup | Secondary Setups | Bias | Confidence Score | Trigger Level | Invalidation Level |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| NSE | ABC | Support bounce | | Bullish | 7.8 | Not found | Not found |\n"
    result = normalize_output(original, "technical")
    assert result.content == original and result.status == "preserved"
    assert len(result.blocks[0].headers) == 8


def test_hashes_are_stable_and_distinguish_schema_and_source():
    assert CONTRACT_VERSION == "credx-output-v1"
    assert contract_hash("swing") == contract_hash("swing")
    assert len({contract_hash(kind) for kind in ("swing", "rebalance", "technical", "threat")}) == 4
    assert source_hash("one") != source_hash("two")


def test_strict_number_parser_preserves_numeric_meaning_only():
    assert number("1,234.50") == number("1234.50")
    assert number("12,34") is None
    assert number("12 cats") is None
    assert number(False) is None
    assert number("0") == 0
    assert cell_text(None) == "null"


def test_export_missing_optional_value_is_blank_not_explicit_null():
    source=json.dumps([swing_row('A', optional_note=None),swing_row('B')])
    result=normalize_output(source,'swing')
    assert result.safe_to_replace
    exported=export_tables(result)[0]
    index=exported.headers.index('optional_note')
    assert exported.rows[0][index] is None
    assert exported.rows[1][index]==''


@pytest.mark.parametrize('literal',['20.1234567890123456789012345','1e-999999','1e999999'])
def test_json_numeric_precision_loss_blocks_without_replacing_source(literal):
    source=json.dumps([swing_row()]).replace('"upside_horizon": 20','"upside_horizon": '+literal)
    result=normalize_output(source,'swing')
    assert not result.safe_to_replace and result.content==source
    assert 'numeric_precision_loss' in codes(result)


def test_extreme_json_exponent_is_blocked_without_exception_or_replacement():
    source=json.dumps([swing_row()]).replace('"upside_horizon": 20','"upside_horizon": 1e99999999999999999999999')
    result=normalize_output(source,'swing')
    assert not result.safe_to_replace and result.content==source
