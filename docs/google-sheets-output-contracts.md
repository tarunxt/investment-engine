# Validated stock output export to Google Sheets

The job and run export tasks use the current deterministic output contract only
when the job's own stage identity and instruction prefix explicitly declare the
current swing or rebalance schema. A schema quoted inside an input bundle does
not activate this path. Historical and custom schemas retain the existing stock
parser and formatting path, including the existing legacy partial-export rule.

For current contracts, the exporter reuses the runtime validator with the job's
frozen prompt, metadata, requested stock count, and rebalance holdings snapshot.
It resets the scoped runtime context after each job. Only a fully valid result
can be exported; required unknown fields, wrong stock counts, duplicate decisions,
or snapshot coverage errors cannot fall through to the legacy partial-row parser.
A failed current-contract validation marks the export failed before a Sheets
write. In a run export, an invalid completed current-contract job blocks the whole
write, so an already collected valid subset is not silently exported instead.

The export adapter consumes `export_tables(result)` directly. It does not reparse
canonical output through the legacy stock filter or convert it into a reduced
stock dictionary:

- All 31 swing or 29 rebalance columns, additional source columns, and every
  source table row are retained. `stocks_count` counts canonical stock rows;
  ancillary rows, headings, and findings do not inflate it.
- Source tables remain ordered sections with their own headers. Prose, headings,
  caveats, ancillary tables, and validator findings accompany the stock tables.
  The first header is also used as the Sheet's normal top header; it is repeated
  at its section when preceding prose requires a local header.
- Every source table row includes its export job ID, fragment index, source row
  number, source line when available, and run stage when supplied. These added
  column names are suffixed on collision; source columns are never renamed.
- Independent job samples retain separate sections, even when model and ticker
  overlap. No run-level ticker/model deduplication or row limit is applied.
- Existing Run #, Run Date, Run Time, and LLM columns (including known aliases)
  are preserved. Only absent metadata columns are appended. Current job exports
  use persisted job creation time for appended run dates/times when available;
  run exports use run creation time. No existing nonempty source provenance is
  overwritten by export-time metadata.
- Values go to the existing Sheets service with `valueInputOption="RAW"`, so
  formulas or source text are not interpreted. Supplied numeric zero, false,
  empty text, whitespace, and rationale strings are not stripped or truth-tested.
  Explicit JSON null in an optional source column is written as the literal
  `null`, because the Sheets API skips native null cells. This preserves its
  visible unknown state separately from a blank; Sheets is not a typed JSON
  archive. A required-field null still blocks the entire current-contract export.

The stored job response is unchanged. Contract validity certifies the defined
field, row-count, snapshot, and serialization rules, not market accuracy,
investment quality, or completion of unrelated workflow stages.

## Offline verification

```sh
PYTHONPATH=backend python -m pytest -q \
  backend/tests/test_google_sheets_output_contracts.py \
  backend/tests/test_google_sheets_tasks.py \
  backend/tests/test_google_sheets_service.py \
  backend/tests/test_stock_service.py \
  backend/tests/test_rebalance_export_parser.py
```

The focused fixtures exercise the actual Celery task boundary and a mocked Google
client, including all sixty rows across five current-schema tables, two ancillary
rows, all rationale columns, prose, per-row provenance, mixed source metadata,
zero/null/blank behavior, strict validation failures, and independent same-model
samples. No provider, Sheets API, database, credential service, or other network
call is performed. These fixtures are independent of the unrelated Bullpen chunk
merger and do not claim to repair its row coverage.
