# JOURNEY-AUTO-RUN-BOUNDARY

Implementation against fetched `origin/main` at `c7d4942e03a3d0be320195b11fbbf24c5e83b94c` (2026-11-01). The previously deployed stage ledger exposes saved evidence, but its Run strip does not explain processing effects or the later manual order boundary, so this finding requires a copy change. Work started approximately 04:17 UTC; first exact recorded clock was 04:18:02 UTC.

Source requirement: parent's verified transcription of PDF page 10, Library `libfile_12a60dd135d88191a3701e3376b755f2`, SHA256 `2ef2fa2a03dcb0b3974fba5ca3d1d80b349a0f73b5e619db42c91ec5b4cb70ce`. This worker did not personally inspect PDF pixels.

The new `WorkflowRunBoundary` is static presentation, used only when `stageLedger` is enabled. The only shared workflow changes are its import and one render below Last run. There are no new effects, API calls, callbacks, dialogs, processing rules, order logic or routes.

## Behavior evidence used for wording

- `RebalanceWorkflowSections.tsx`: `runWorkflow` uses `specificMode`, `selectedStages` and `shouldRunCurrentStage`; Sync queues Zerodha portfolio sync or uses the US import flow; Threats requests a queued job; Swing, Rebalance and Technical create runs; Actionables freezes a calculation. Run does not call the order submission functions.
- `backend/app/domains/zerodha/router.py`: `queue_portfolio_sync` authenticates and queues `sync_portfolio_snapshot_task.delay`.
- `backend/app/domains/zerodha/threats_router.py`: `run_threat_analysis` creates a job using `CreateJobUseCase`; no inline provider execution.
- `backend/app/domains/runs/router.py`: `create_run` validates model targets; `/auto-rebalance-completion-email` checks persisted workflow/stage completion and creates a durable completion event. The frontend requests that notification only when Actionables is included and history completion verifies. Thus copy says it *can* queue an email, without promising delivery.
- `showStageOutput` fetches saved snapshots, threats, runs and outputs. `AutoRebalanceHistoryClient` reads history with `getAutoRebalanceHistory` / `getAutoRebalanceHistoryDetail`. Their preview paths do not start processing.
- Actionables' `onPlaceOrderClick` opens `openZerodhaBasketPreview` / `openIndmoneyBasketPreview`. India submission uses a later `window.confirm` and separate order API. `confirmIndmoneyFinalOrder` displays a manual execution review alert, so copy does not promise automated US order submission.

## Resulting labels and routes

Visible link: **Review saved run history (read-only)**. India: `/console/auto-rebalance-runs/zerodha`; US: `/console/auto-rebalance-runs/indmoneyUs`. The copy also names **Saved evidence and configuration → Saved output**, **Sync Now**, **Place Order (India)** and **Final Order (US)**, and states **Run does not submit orders**. Full browser readback is in `after/labels-and-routes.json`.

## Safe verification

- `node --test tests/automated-rebalance-popup-reliability.test.mjs tests/automated-rebalance-history-limit-guard.test.mjs tests/rebalance-stage-inputs.test.mjs`: 37 passed, 0 failed.
- `node_modules/.bin/tsc --noEmit`: passed, exit 0.
- `npx eslint app/console/automated-rebalance/_components/WorkflowRunBoundary.tsx app/console/dashboard/_components/RebalanceWorkflowSections.tsx`: new component has zero findings; shared workflow retains exactly the baseline 2 errors and 22 warnings. `eslint-comparison.json` records both baseline and after errors. Existing errors are `react-hooks/set-state-in-effect` in basket UI at baseline lines 2831 and 2941; this task does not alter those systems.
- Baseline: `AUTO_STAGES_EVIDENCE=/tmp/journey-auto-run-boundary-before node scripts/auto-stages-ledger-offline-playwright.mjs`: passed.
- After: `node scripts/journey-auto-run-boundary-offline-playwright.mjs`: passed. Real new summary and existing ledger components, deterministic local data, all external browser network blocked. Checks India/US history hrefs, keyboard Enter navigation and browser back, saved evidence callbacks, default zoom / device scale 1 at 1180×757 and 390×844, summary narrow bounds and keyboard focus, loading, saved success, confirmed empty, failed, partial, stale, zero-stock and stage selection states. Summary remains present in every status. All execution callbacks remain uncalled. No application backend is running.
- `git diff --check`: passed.

Before/after desktop: `before/india-desktop.png`, `after/india-desktop.png`. Narrow: `before/us-partial-narrow-left.png`, `after/us-partial-narrow-left.png`. Remaining after screenshots cover states and saved evidence. These are isolated component fixtures with a representative Run strip, not screenshots of authenticated production. Default responsive header styling in the after fixture matches the current workflow; the earlier baseline fixture used its existing simplified header.

No paid scan, provider refresh, order, real job, account change or message was triggered. No production or full authenticated application QA is claimed. Parent owns integration, authenticated read-only review and deployment. Accessibility dialog behavior was exercised only through existing tests and was not changed. Shared-file integration overlap is limited to the import and conditional summary render in `RebalanceWorkflowSections.tsx`.
