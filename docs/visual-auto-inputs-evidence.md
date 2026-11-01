# AUTO-INPUTS-EVIDENCE

Base: `1089c6f1c5dc01c6cb41be1da7b45e9e7a8b805b` (fetched `origin/main`, 2026-11-01).

## Coverage

The supplied assessment text identifies the Threat Scan input picker with an upcoming portfolio snapshot and a saved snapshot. Its rows now say **Upcoming output** and **Saved snapshot**, retain native checkboxes, and show explicit selection, source timestamp, availability/status and errors. The upcoming row says **Reserved — not yet generated**. The summary derives from actual selected IDs; missing selected IDs remain disclosed rather than being silently dropped. No saved snapshot is automatically selected.

Existing selection persistence, select-all, reset-to-upcoming defaults, source identities, timestamp formatter, execution paths, permissions, currency conversion and financial calculations are preserved. The other stages retain their existing grouped job picker. Dialog semantics, focus containment, Escape and focus restoration apply to the shared input dialog. No global density or container-width changes.

Shared-file integration: `frontend/app/console/dashboard/_components/RebalanceWorkflowSections.tsx` changes are confined to the input-picker import, dialog, and input-loading error state. Other automated-rebalance branches may touch this file. `frontend/tests/rebalance-stage-inputs.test.mjs` gains only a mock for that error-state setter. The new row component and browser test are separate files.

## Verification

- `node --test tests/rebalance-stage-inputs.test.mjs tests/rebalance-workflow-resilience.test.mjs`: 37 passed, including read-only opening, reset-to-upcoming and paid-stage source guardrails using local mocks.
- `npx tsc --noEmit`: passed.
- Focused new component/browser-script ESLint: passed.
- Shared workflow ESLint: 2 errors and 22 warnings, exactly reproduced on `origin/main`; errors are existing synchronous state updates in effects at baseline lines 2826 and 2936. No new lint diagnostics.
- `node tests/input-evidence-offline.mjs`: passed. Real extracted dialog and row component, local React fixture only, no backend/provider requests. Covers upcoming-only, saved-only, both, none, select-all/reset, partial/error disclosures, retained timestamp, loading, empty, missing and failed sources, repeated open/close, Escape, Tab/Shift+Tab containment and focus restoration. Desktop 1180×757 and narrow 390×844 checked without horizontal overflow. Existing wider dialog retained.
- Screenshots are local fixture evidence: `/tmp/auto-inputs-evidence/desktop-1180x757.png` and `/tmp/auto-inputs-evidence/narrow-390x844.png`. Timestamp and values are fixtures, not production data.
- `git diff --check`: passed.

## Limits

Both supplied Library items were resolved through `prepare_materialize` with consumer-local destination `/workspace/evidence-auto-inputs`, using the current Library skill and both current transfer helpers. The transfer helper returned `library file transfer failed: download failed` for each. No readable bytes were produced for `libfile_e735fdf1e9f48191b47cf49a5af5b476` (PDF) or `libfile_0d924221bd9881918bf2e207ee2d05a9` (selection screenshot). Source page images 1–13, 38–42 and 148, proposed tabs/states and preservation-map inspection are blocked. Implementation follows only the exact assessment text supplied in the task; visual equivalence to unavailable page images is not claimed.

Authenticated production integration and browser back-navigation were not exercised. Local dialog tests preserve selections on close/reopen; no routing logic changed. No jobs, refreshes, scans, trades, payments or messages were triggered. No merge or deployment is authorized for this branch independently; the coordinator integrates it.
