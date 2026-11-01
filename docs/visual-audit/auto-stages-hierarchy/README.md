# AUTO-STAGES-HIERARCHY

Scope: `/console/automated-rebalance`, based on main `1089c6f1c5dc01c6cb41be1da7b45e9e7a8b805b`.

Source attribution: implementation follows the parent reviewer’s actual-pixel review and transcribed preservation map for source PDF pages 43–56. The implementing worker did **not** view the PDF: both source Library downloads failed, including the bounded consumer-local retry. No further transfers were attempted after the reviewer handoff. This document does not certify unseen source content.

## Mapping checklist

- [x] India stage ledger and US stage ledger: one shared semantic six-row ledger; existing ordered labels Sync Portfolio, Threats Scan, Swing Scan, Rebalance, Technical Scan, Actionables, numbered 01–06.
- [x] Stage / Saved time / Completion-inputs / Stocks / Duration / Error columns. Values come from existing `getIdleStageRows` and its existing timestamp, completion, stock, cost and error formatters. No report sample values enter production code. Dash, unavailable classifications, n/a and stock count zero remain distinct.
- [x] Completion passed/partial/failed/unresolved counts and Actionables rebalance-input counts survive unchanged. Every measured scan retains its own cost provenance in the completion column.
- [x] US partial warning is derived from the actual stage data, names the affected stage, and leaves the affected row’s existing partial error/details intact. Other stages and markets are not marked failed. The same behavior also handles partial data in any other actual stage.
- [x] Existing workflow title, last run, cumulative time, last total cost, cost history, run history and footer Stock Flow trigger are preserved in the original workflow component.
- [x] Saved evidence and configuration: selected-stage Inputs, Models, Prompt, Saved output, Duration, Calculation, Stock Flow, History and original stage navigation use existing callbacks/routes. Only applicable controls are shown (for example, Calculation belongs to Actionables). No private content or unavailable output is fabricated.
- [x] Four functional view buttons: India stage ledger, US stage ledger, Saved evidence and configuration, Run and order controls. Evidence/execution changes retain the selected market. A restored active workflow initially selects its market; otherwise India is the default where there was previously no single selected market. This does not change account selection.
- [x] Run, pause/kill, Run specific Stages, Sync Now, Place Order (India only), Final Order (US only), confirmations, basket safety and readiness callbacks remain owned by the existing workflow. Explicit per-stage checkboxes preserve selected-stage context and are also available in execution view.
- [x] Ledger is opt-in from AutomatedRebalanceClient. Embedded dashboard keeps its prior cards and two-column market layout. Containers are not globally narrowed, scaled or densified.
- [x] Loading/queued with existing data, loaded, empty, failed, partial, stale-labelled data and stock-zero fixtures; stage-specific error details and unavailable completion data.
- [x] Semantic table headings, named scroll region, visible keyboard focus, selectable rows, keyboard view activation, independent controls and keyboard-reachable stage selection. Actual duration and error dialogs exercised twice with Escape and focus restoration; duration focus stays contained.
- [x] Narrow table scroll retains all six columns, page has no horizontal overflow, and evidence/order actions remain outside the scroller and reachable. History hash/back navigation covered in fixture.

## Validation

From `frontend/`:

```
npx tsc --noEmit
npx eslint components/shared/WorkflowStageLedger.tsx scripts/auto-stages-ledger-offline-playwright.mjs app/console/automated-rebalance/_components/AutomatedRebalanceClient.tsx
node --test tests/rebalance-workflow-resilience.test.mjs tests/rebalance-stage-inputs.test.mjs tests/rebalance-readiness.test.mjs tests/automated-rebalance-popup-reliability.test.mjs
node scripts/auto-stages-ledger-offline-playwright.mjs
```

Types pass. New/changed standalone files lint clean. Focused regression tests: **56 passed**. Browser acceptance passes. Full changed-workflow lint still reports the baseline's two `react-hooks/set-state-in-effect` errors and 22 warnings; linting the exact original HEAD source reproduces those findings. No changes were made to unrelated effects.

Screenshots are of the **real ledger and view-navigation components rendered with deterministic local fixtures**, real Tailwind styles, browser scale 1, desktop viewport 1180×757 and narrow viewport 390×844. They are not production account captures or exact historical values. Header/footer scaffolding and execution callback stubs are fixture-only. Test network is restricted to its local HTTP server; no real Run, Sync, order, provider or other execution callback was triggered.

- [India desktop](india-desktop.png)
- [US partial desktop](us-partial-desktop.png)
- [Saved evidence desktop](evidence-desktop.png)
- [Execution desktop](execution-desktop.png)
- [Narrow left columns](us-partial-narrow-left.png)
- [Narrow scrolled right columns](us-partial-narrow.png)

Limits: no authenticated production data read-back or full-route browser check was performed. Detailed Inputs/Models/Prompt/output dialogs remain separate tasks; this branch preserves their invocation and has not independently browser-tested their internals. Real execution confirmations were not exercised. Shared workflow integration conflicts must be reconciled serially with the other automated-rebalance branches. No merge or deployment is part of this branch.

Shared-file conflict points: `RebalanceWorkflowSections.tsx` import, component props/state, presentation wrapper around its unchanged stage callback map, Run heading and market-view render; `AutomatedRebalanceClient.tsx` opt-in prop. The existing shared `WorkflowStageTile.tsx`, duration dialog and all financial/runtime helpers are unchanged.
