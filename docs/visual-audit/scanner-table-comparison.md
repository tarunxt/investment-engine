# SCANNER-TABLE-COMPARISON

Route: `/console/technical-setups`. Base: `1089c6f1c5dc01c6cb41be1da7b45e9e7a8b805b` (fetched current main).

## Implemented

The existing five-column comparison tables already satisfy the supplied assessment's preserve-only layout record. Keep their compact cell spacing, wider container, 24 bullish and 21 bearish catalogue entries, confidence descriptors, best-use text, triggers, invalidation rules, default/custom sorting and target-row navigation unchanged.

Remove repeated per-row `Loading…` labels. Use the existing shared count-loading message with the explicit disclosure that no count is inferred as zero. Both tables reference the shared loading/error status with `aria-describedby`. Retain row-level unavailable labels, error details and retry; retain confirmed loaded zeroes, action breakdowns, stock dialogs, currency/value strings and links. The data loader, calculations, permissions and execution paths are unchanged. Its existing all-or-nothing source handling remains fail-closed on partial source failure. It exposes no separate row-specific or stale availability schema; this change does not manufacture one.

## Verification

- `npx eslint app/console/technical-setups/page.tsx scripts/scanner-table-offline-playwright.mjs`: passed.
- `npx tsc --noEmit`: passed.
- `node --test tests/technical-price-evidence.test.mjs tests/final-actionables-run-identity.test.mjs tests/actionables-runs-matching.test.mjs tests/final-actionables-consensus-denominator.test.mjs`: 30 passed.
- `SCANNER_EVIDENCE_DIR=/workspace/scanner-evidence node scripts/scanner-table-offline-playwright.mjs`: passed. Uses the actual scanner page with isolated fixture dependencies and denies external browser requests. Checks 45 rows, five columns, one loading message, no inferred zero while loading/failed/partial, populated/empty states, retry, keyboard sorting, repeated dialog open/close, back navigation, desktop 1180×757 and narrow 390×844 with contained horizontal table scrolling. Screenshots: loading-1180.png, loaded-1180.png, loaded-narrow.png, failed-narrow.png. These show local fixture values and omit the production application shell.

## Limits and coordination

The original report identity `libfile_69395435517c8191aa25b189d62b27a5` failed supported Library materialization twice (initial request and one bounded retry with an explicit consumer-local destination). No readable PDF bytes were delivered, so its expected SHA256 could not be verified. Actual page images 1–13, 126–130 and 148, every proposed state and the complete preservation map remain unverified. The separate selection screenshot was not needed under the supplied full-PDF alternative. Implementation is limited to the exact assessment text supplied in the task and current source inspection, rather than invented visual evidence. Full mapped-item acceptance remains blocked on the report.

The existing stock modal's Escape handling, focus trapping and return-to-trigger behavior are not implemented by this scoped count-presentation change; keyboard sorting and clickable close/reopen were verified. Stale timestamps have no distinct UI state in the current scanner schema. No live provider, scan, refresh, trade or production mutation was performed. No merge or deployment was performed.

Only the scanner page is a production-code edit. Other parallel work touching that page must reconcile the shared status IDs and loading-name branch. No automated-rebalance or global layout files were changed.
