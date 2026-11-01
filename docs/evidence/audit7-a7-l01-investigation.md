# A7-L01: India partial Rebalance investigation

Status: open investigation; no parser defect established and no production acceptance claimed.

Revalidated against fetched `origin/main` at
`da317a1097cef97089e3a745b9e20b4952af6a48` on 2026-11-01.
Scope follows the supplied verbatim A7-L01 assessment and preservation map;
the original report bytes and pixels could not be independently verified here.

## Existing canonical work

This is a continuation of [A6-14 and A6-04](audit6-integration.md), not a second
implementation of their fixes. A6-14 (`3bfce38e`) already preserves original
historical validation metadata, error and response hash separately from the
bounded partial read projection in
`backend/app/domains/jobs/partial_output.py`. The response DTO projection does
not mutate the stored ORM record. Its projected `status: valid` describes the
renderable normalized fragment; `usage_status: partial` and the job's partial
status remain necessary qualifications. It does not certify the original
provider output or historical input coverage.

A6-04 already shares selected Swing input markers/counts. Current selection
helpers are in `frontend/lib/rebalanceStageInputs.ts`; neither these helpers nor
a displayed row count establish the identities selected for a historical run.

The canonical schema remains the 29-column `REBALANCE_COLUMNS` in
`backend/app/domains/jobs/output_contracts/schemas.py`. Runtime validation in
`backend/app/domains/jobs/output_runtime.py` reports observed coverage and
finding counts. Counts alone cannot reconstruct exact historical excluded cells.

## Evidence unavailable

The checkout contains no saved evidence bundle for the historical run under investigation.
No authenticated historical API or database read was performed. In particular,
the original response, normalized response, saved validation diagnostics,
prompt/schema version, holdings snapshot and selected Swing universe have not
been reconciled. No financial root cause or provider limitation is inferred.

The supplied Library reference returned `NOT_FOUND` before materialization.
Search resolved a candidate report, but source-byte identity remains unverified.
The complete unchanged structured search result was passed to the current
Library download helper, selecting only that candidate with an executor-local
destination. It failed with `hosted apps tools/list request failed: network`.
The supported resolved-reference preparation then returned a signed transfer;
the current transfer helper failed with `download failed` at the local
destination `/workspace/a7-l01-source/audit7.pdf`. No URL bypass was attempted.
No readable PDF, SHA-256 match or actual-pixel inspection is claimed.

## Required continuation and acceptance

Obtain the existing saved evidence read-only through the authorized owner;
do not rerun paid providers or regenerate the historical input universe.
Retain original IDs, timestamps, raw response and validation metadata unchanged.
For each frozen exchange/symbol identity, map every required
column to its original source position, normalized value and runtime decision.
Record known zero separately from unknown, missing, excluded and unaligned
values. Recompute quantities and amounts only from evidenced valid inputs and
the historical contract; trace each exclusion into downstream consumption.
Compare coverage to the frozen holdings and selected Swing identities, not to
current portfolio data or the displayed row count.

Classify established provider-format limitations separately from parser and UI
defects. Link any proven defect to A6-14 or A6-04 as appropriate. Seek the
separate implementation authority specified by A7-L01 before changing behavior.
Preserve partial status and action permissions. Synthetic tests can validate
code safeguards but cannot close this saved-run investigation.

No runtime code, formulas, snapshots, raw responses, financial values,
permissions, provider execution, broker operations or external exports changed.

## Local verification

Existing backend suites `test_historical_partial_provenance.py`,
`test_output_contracts.py` and `test_output_runtime.py`: **134 passed**, with
the existing AnyIO pytest API and passlib `crypt` deprecation warnings, using
Python 3.12 and an isolated temporary environment. The provenance fixture
checks repeated DTO projection, original metadata/error/hash preservation,
unaligned cells and unchanged source objects. The contract suite covers
29-column widths, missing values, explicit zero and invalid values. No new
fixtures purport to represent the historical run.

Initial backend invocation could not start because pytest was absent; installing
the existing requirements and test dependencies in the temporary environment
resolved this environment issue. Frontend `rebalance-input-counts` and
`rebalance-stage-inputs` tests could not start because TypeScript was absent.
`npm ci --ignore-scripts --no-audit --no-fund` emitted repeated registry tarball
errors and was stopped; frontend/component browser verification remains unmet.
No application baseline test failure was demonstrated. No UI change was made.
