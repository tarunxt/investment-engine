"""Pure, fail-closed normalization of already determined provider output."""

import hashlib
import json
from collections import Counter
from typing import Any, Mapping, Sequence

from .document import MISSING, cell_text, parse_json, parse_markdown, render_document
from .schemas import (
    CanonicalRow, CanonicalTable, Column, Coverage, ExportTable, Finding,
    METADATA_KEYS, NormalizationResult, Provenance, REBALANCE_COLUMNS, SWING_COLUMNS,
)
from .validation import aliases, header_key, holding_identity, prepare_holdings, validate_row

CONTRACT_VERSION = "credx-output-v1"
_CONTRACTS = {"swing": SWING_COLUMNS, "rebalance": REBALANCE_COLUMNS}
_PRESERVATION_KINDS = {"document", "technical", "threat"}


def contract_hash(kind: str) -> str:
    if kind not in _CONTRACTS and kind not in _PRESERVATION_KINDS:
        raise ValueError(f"Unsupported output kind: {kind}")
    payload = {"version": CONTRACT_VERSION, "kind": kind,
               "columns": [(column.key, column.label) for column in _CONTRACTS.get(kind, ())],
               "validation": "strict-fields-snapshot-identity-action-arithmetic-v1" if kind in _CONTRACTS else "preservation-only"}
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def source_hash(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


def normalize_output(
    content: str,
    kind: str,
    *,
    metadata: Mapping[str, Any] | None = None,
    holdings: Sequence[Mapping[str, Any]] | None = None,
    derive_arithmetic: bool = False,
    minimum_rows: int = 1,
) -> NormalizationResult:
    """Return replacement content only for a fully validated, preserving result.

    metadata may only supply llm_name_model, llm, run_number, run_date, run_time.
    holdings must use exchange_symbol, stock_symbol, current_units, optional currency.
    `minimum_rows` is caller policy, never a row cap. No semantic repairs are made.
    Technical/threat/document kinds preserve original bytes and never certify semantics.
    """
    if kind not in _CONTRACTS and kind not in _PRESERVATION_KINDS:
        raise ValueError(f"Unsupported output kind: {kind}")
    if not isinstance(content, str):
        raise TypeError("content must be the original provider string")
    if isinstance(minimum_rows, bool) or not isinstance(minimum_rows, int) or minimum_rows < 1:
        raise ValueError("minimum_rows must be a positive integer")
    blocks, findings = (parse_json(content) if content.lstrip().startswith(("[", "{")) and kind in _CONTRACTS
                        else parse_markdown(content))
    if not content.strip():
        findings.append(Finding("empty_content", "Provider output is empty."))
    source_rows = sum(len(block.rows) for block in blocks)
    if kind in _PRESERVATION_KINDS:
        findings.append(Finding("preservation_only", "All source blocks are preserved; domain semantics have not been revalidated.", "info"))
        return NormalizationResult("blocked" if any(f.severity == "error" for f in findings) else "preserved",
                                   content, content, blocks, (), tuple(findings),
                                   Coverage(len(blocks), len(blocks), source_rows, 0, 0, None, None))
    columns = _CONTRACTS[kind]
    key_aliases = aliases(columns)
    supplied_metadata = dict(metadata or {})
    if set(supplied_metadata) - METADATA_KEYS:
        findings.append(Finding("unsupported_metadata", "Caller metadata may only fill explicit run/model/time fields."))
    snapshot, snapshot_findings = prepare_holdings(holdings) if kind == "rebalance" else ({}, [])
    findings.extend(snapshot_findings)
    tables: list[CanonicalTable] = []
    for block in blocks:
        if block.kind != "table":
            continue
        keys = tuple(key_aliases.get(header_key(header), "extra:" + header) for header in block.headers)
        if "stock_symbol" not in keys:
            # Ancillary tables (sources, dissent, coverage, etc.) stay in place.
            findings.append(Finding("ancillary_table_preserved", "Non-trade table preserved without interpreting its data.", "info", Provenance(block.index, 0, block.line)))
            continue
        duplicate_keys = {key for key, count in Counter(keys).items() if count > 1}
        if duplicate_keys:
            findings.append(Finding("duplicate_columns", "Headers map to duplicate fields; no source column may be overwritten.", source=Provenance(block.index, 0, block.line)))
        canonical_keys = {column.key for column in columns}
        extra_columns = tuple(Column(key, header) for key, header in zip(keys, block.headers) if key not in canonical_keys)
        table_columns = (*columns, *extra_columns)
        rows: list[CanonicalRow] = []
        for index, cells in enumerate(block.rows, 1):
            source = Provenance(block.index, index, block.line + 1 + index if block.line else None)
            source_values = {key: value for key, value in zip(keys, cells) if value is not MISSING}
            try:
                values, filled, row_findings = validate_row(source_values, columns, source, supplied_metadata, snapshot,
                                                           kind, derive_arithmetic=derive_arithmetic)
            except ArithmeticError:
                values, filled = dict(source_values), ()
                row_findings = [Finding("unsupported_arithmetic", "Numeric representation cannot be validated safely; preserve the source values.", source=source)]
            findings.extend(row_findings)
            rows.append(CanonicalRow(values, source_values, source, filled,
                                     not duplicate_keys and len(cells) == len(keys) and not any(f.severity == "error" for f in row_findings)))
        tables.append(CanonicalTable(block.index, tuple(table_columns), tuple(rows)))
    rows = tuple(row for table in tables for row in table.rows)
    if len(rows) < minimum_rows:
        findings.append(Finding("insufficient_rows", f"Expected at least {minimum_rows} trade rows; found {len(rows)}. No rows were discarded."))
    covered_holdings: int | None = None
    if kind == "rebalance":
        identities = Counter(holding_identity(row.values, snapshot) for row in rows)
        covered_holdings = sum(identities[key] > 0 for key in snapshot)
        for key in snapshot:
            if identities[key] == 0:
                findings.append(Finding("missing_holding", f"Missing current holding {key[0]}:{key[1]}."))
        for key, count in identities.items():
            if key is not None and count > 1:
                findings.append(Finding("duplicate_decision", f"{count} decisions for {key[0]}:{key[1]}; all rows retained for review."))
    blocked = any(f.severity == "error" for f in findings)
    rendered = content
    if not blocked:
        try:
            rendered = render_document(blocks, tuple(tables))
            # Validate serialization itself: no escaped pipes/newlines or extra dimensions lost.
            roundtrip, roundtrip_findings = parse_markdown(rendered)
            actual = [block for block in roundtrip if block.kind == "table"]
            originals = [block for block in blocks if block.kind == "table"]
            replacement_by_id = {table.fragment: table for table in tables}
            if any(f.severity == "error" for f in roundtrip_findings) or len(actual) != len(originals):
                raise ValueError("Rendered fragment structure changed.")
            for original, parsed in zip(originals, actual):
                table = replacement_by_id.get(original.index)
                if table is None:
                    expected_headers, expected_rows = original.headers, original.rows
                else:
                    expected_headers = tuple(column.label for column in table.columns)
                    expected_rows = tuple(tuple(cell_text(row.values.get(c.key, MISSING)) for c in table.columns) for row in table.rows)
                if parsed.headers != expected_headers or parsed.rows != expected_rows:
                    raise ValueError("Rendered cells or row coverage changed.")
        except (ValueError, TypeError, ArithmeticError) as exc:
            findings.append(Finding("render_roundtrip_failed", str(exc)))
            blocked, rendered = True, content
    validated = sum(row.valid for row in rows)
    status = ("partial" if validated else "blocked") if blocked else "valid"
    return NormalizationResult(status, content, content if blocked else rendered, blocks, tuple(tables), tuple(findings),
                               Coverage(len(blocks), len(blocks), source_rows, len(rows), validated,
                                        len(holdings) if kind == "rebalance" and holdings is not None else None,
                                        covered_holdings if holdings is not None else None))


def export_tables(result: NormalizationResult) -> tuple[ExportTable, ...]:
    """Export every source table, including ancillary tables, without row filtering.

    Text blocks and findings remain on result and must accompany a full-document export.
    This deliberately does not call the legacy stock parser or ticker deduplicator.
    """
    if not result.safe_to_replace:
        raise ValueError("Only a fully validated result may be exported as canonical tables.")
    tables = {table.fragment: table for table in result.tables}
    exports: list[ExportTable] = []
    for block in result.blocks:
        if block.kind != "table":
            continue
        table = tables.get(block.index)
        if table is not None:
            exports.append(ExportTable(block.index, tuple(c.label for c in table.columns),
                                       tuple(tuple(row.values.get(c.key, "") for c in table.columns) for row in table.rows),
                                       tuple(row.source for row in table.rows)))
        else:
            exports.append(ExportTable(block.index, block.headers, block.rows,
                                       tuple(Provenance(block.index, index, block.line + 1 + index if block.line else None)
                                             for index in range(1, len(block.rows) + 1))))
    return tuple(exports)
