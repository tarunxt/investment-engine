# Deterministic output contracts

`app.domains.jobs.output_contracts` provides a pure offline formatting path for
already determined stock recommendations. It does not call providers, search,
change trading decisions, retrieve market data, mutate snapshots, or interact
with the Bullpen audit subsystem.

## Integration boundary

```python
from dataclasses import asdict
from app.domains.jobs.output_contracts import (
    CONTRACT_VERSION, contract_hash, normalize_output, source_hash,
)

result = normalize_output(
    original_provider_content,
    "swing",                      # or "rebalance"
    metadata=authoritative_metadata,
    minimum_rows=5,                # existing swing minimum; never a maximum
)
if result.safe_to_replace:
    formatted_content = result.content
else:
    assert result.content == original_provider_content
    # Continue the existing semantic repair/error path using the original.

report = {
    "contract_version": CONTRACT_VERSION,
    "schema_hash": contract_hash("swing"),
    "source_hash": source_hash(original_provider_content),
    "status": result.status,
    "coverage": asdict(result.coverage),
    "findings": [asdict(finding) for finding in result.findings],
}
```

Only `safe_to_replace == True` permits replacement or canonical export. `valid`
means all source trade rows pass the explicit field, identity, arithmetic, and
serialization contract. It does **not** certify market freshness, investment
quality, source truth, or completion of another workflow stage. Existing research
and semantic-repair stages remain responsible for those decisions. A minimum row
policy is explicit caller input; there is no five-row slicing or ticker/model
deduplication.

The contract version is `credx-output-v1`. The deterministic SHA-256 contract hash
includes kind, ordered key/label definitions, and validation policy identifier.
Bump the version/policy identifier when changing these semantics. `source_hash`
hashes the exact UTF-8 provider content, including all whitespace. Do not persist
an entire `asdict(result)` in the metering ledger: its source data is intentionally
retained for review, and would duplicate provider content. The small report above
is JSON-serializable and sufficient for audit linkage.

## Authoritative inputs and permitted computation

Only caller-supplied `llm_name_model`, `llm`, `run_number`, `run_date`, and
`run_time` may fill absent/empty swing metadata. Existing nonempty source metadata
is retained, including mixed-model provenance. Explicit null or unknown metadata
remains unknown. Metadata cannot supply prices, stops, sources, confidence,
rationales, or rationale scores.

Rebalance calls require a supplied snapshot:

```python
result = normalize_output(
    original_provider_content,
    "rebalance",
    holdings=[{
        "exchange_symbol": "NSE",
        "stock_symbol": "ABC",
        "current_units": "10",
        "currency": "INR",       # optional; never converted or inferred
    }],
    derive_arithmetic=False,
)
```

`holdings=None` is unverifiable and blocks replacement. `holdings=[]` is an
explicitly verified empty portfolio. Identity is the pair of exchange and symbol,
case-insensitive for comparisons only; original text is retained. NSE/BSE and
US/NASDAQ/NYSE identities are not collapsed. Duplicate snapshot identities or
duplicate rebalance decisions block replacement. Missing snapshot holdings and
current-unit discrepancies are explicit findings. Source rows are never removed.

Absent/empty current units may be copied only from an exact snapshot match.
Explicit null stays unknown. New-buy current units must be explicitly supplied as
zero; the renderer does not infer zero from the action. With
`derive_arithmetic=True`, the only computed field is absent/empty Final Units =
Current Units + Units Change. This option defaults off. It never chooses an
action, derives a signed delta, manufactures a missing zero, or converts a sell
quantity to a buy quantity.

Validation checks unit sums, action/sign consistency, buy quantities, nonnegative
remaining positions, and Total Buy Amount = Units to Buy × Price per Unit within
half a currency cent (0.005), accommodating the existing INR/USD amount display.
It does not modify amount, price, target, stop, upside, allocation, or score
formulas. Decimal arithmetic avoids binary floating-point comparison errors and
retains sufficient precision for supplied operands. Numeric values that cannot
remain finite/nonzero in the surrounding ordinary-number export domain fail
closed. No exchange-rate or currency conversion occurs.

## Information preservation

- Swing uses all 31 current frontend columns, including Score Rationale Cruxx and
  the final LLM column. Rebalance uses all 29 current frontend columns.
- Every required field is checked. All six rationale scores must be explicitly
  supplied integers from -3 through 3. No qualitative field or score is inferred.
- Zero is a value. Null, blanks and explicit unknown markers remain unknown and
  block a required-field check. Booleans, NaN, infinities, arbitrary unit/currency
  strings, malformed number grouping and unsupported structured cells fail.
- Every recognized source table remains a separate ordered canonical table.
  Extra source columns follow the canonical columns; they are not projected
  away. Headers that would overwrite a canonical field block replacement.
- Prose, headings, qualifications, dissent, source lists, ancillary tables and
  source errors remain in their original positions. Unparsed/malformed table-like
  lines block replacement. Unknown JSON envelopes, including envelope-level
  notes/status/errors, remain entirely unchanged and block replacement.
- JSON input accepts a record array or a one-key `stocks`, `rows`, or
  `recommendations` envelope. Duplicate JSON keys block replacement. A missing
  record key is distinct from explicit null internally.
- Every canonical row retains its source values and fragment/row/line provenance.
  Findings record every metadata/snapshot/arithmetic fill. Coverage distinguishes
  all source-table rows, canonical trade rows, validated trade rows and snapshot
  holding coverage. Validation counts are not completion percentages.
- Literal pipes, backslashes, newlines, carriage returns, tabs, HTML/entity text
  and boundary spaces use reversible HTML entities in Markdown cells. The
  renderer verifies rendered table/row/cell coverage before permitting replacement.
  Markdown cells are text; original JSON scalar types remain in source values and
  the direct export values.

`status` is `valid`, `partial`, `blocked`, or `preserved`. Partial means some rows
pass field validation but at least one document/row/coverage finding blocks the
whole replacement. Both partial and blocked return the original string exactly.
Never export just the rows with `row.valid=True` or reinterpret a coverage count
as permission to complete the job.

## Export and technical/threat documents

`export_tables(result)` requires `safe_to_replace` and returns every source table,
including ancillary tables, as headers, raw scalar rows and row provenance. It
does not call the legacy stock filter/parser or perform symbol deduplication.
When exporting a full report, include `result.blocks` prose and `result.findings`;
tables alone are not a lossless full-document export. Existing integrations that
reparse Markdown through the legacy stock exporter are outside this guarantee;
they must adopt the direct canonical export before claiming its preservation.

`normalize_output(content, "technical")`, `"threat"`, or `"document"` captures
ordered blocks and returns the original content byte-for-byte. It uses status
`preserved` and `safe_to_replace=False` for well-formed documents. This deliberately
does not certify approved technical-setup names/confidence, holding coverage, or
the ten threat-table semantics without their existing domain validators. The
technical eight-column output, threat Summary/Tables 1–10/Bottom Line, empty
optional technical cells, unknown levels, and explanatory prose are preserved.

## Offline verification

```sh
PYTHONPATH=backend python -m pytest -q backend/tests/test_output_contracts.py
```

The focused suite covers frontend schema parity; parse/canonical/Markdown/export
round trips; sixty unique rows across five chunks with source dimensions and
ancillary tables; repeated tickers/models; numeric/null/boolean/nonfinite cases;
snapshot coverage, exchange/currency identity, actions and arithmetic; metadata
fills; literal pipes/newlines; malformed/empty content; no invented judgments; and
preservation-only technical/ten-table threat documents. These are independent
fixtures, not the unrelated reported Bullpen 51/60-row-loss fixture.

## Current workflow integration

Only a job that declares the complete current 31-column swing or 29-column
rebalance schema opts in. Its market/stage is resolved from the primary job
identity, so quoted input prompts cannot switch its validator. A rebalance must
have a valid captured holdings table before generation. INDmoney's explicit
`US` market snapshot matches a known US listing venue only for an unambiguous
symbol; venue-specific India identities remain exact.

The worker uses validated canonical rendering before legacy table projection.
DeepSeek can skip its formatting-only call when complete supplied JSON already
meets the contract. Missing qualitative facts or invalid quantities are not
invented. The existing bounded semantic repair attempts remain; a deterministic
contract failure does not retry the whole paid job. Swing top-up fragments keep
all source fields and fail on duplicate or excess decisions instead of truncating
to five rows. Current-schema repair preserves the original currency and budget.
Terminal completed/partial/failed task redelivery does not generate again; this guard
does not claim to serialize concurrent first deliveries.

Job runtime metadata records schema version/hash, response hash, observed
fragment/row/holding coverage, and finding counts. Research quality is explicitly
`not_evaluated`; task completion is not a quality percentage. Provider attempt
metering records the same schema hash separately from billed costs. Context is
reset on success, cancellation, and failure. Generic/custom historical contracts
retain their existing path. No production savings have been measured.
