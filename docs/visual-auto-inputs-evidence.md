# AUTO-INPUTS-EVIDENCE

Base: `1089c6f1c5dc01c6cb41be1da7b45e9e7a8b805b` (fetched `origin/main`, 2026-11-01).

## Source and interpretation

The native reviewer `/root/prepare_visual_task_excerpts` inspected page 38 and full proposal images 41–42 and read every preservation-map row on 39–40. Implementation is reconciled against that reviewer's verified visual guidance and the complete transcription supplied by the coordinator. This worker did not open the source PDF images itself. Earlier transfers of PDF `libfile_e735fdf1e9f48191b47cf49a5af5b476` and screenshot `libfile_0d924221bd9881918bf2e207ee2d05a9` failed; no further transfers were attempted after the coordinator supplied reviewed source evidence.

## Full mapping checklist

| Source record | Implementation / verification |
| --- | --- |
| Stage: Select Threat Scan inputs | Existing dynamic modal title retained; labelled dialog. |
| Purpose: choose previous-stage outputs for next prompt | Existing purpose text retained. |
| Selected outputs count | Included in this run shows actual selected available source count and separately discloses unavailable selected IDs; no capture-specific default. |
| Select all | Original callback and multi-select checkbox behavior preserved; both/none transitions tested. |
| Reset defaults | Original callback retained; upcoming-only default verified in regression suite and browser. |
| Expand Upcoming run | Actual row button retains original job name in accessible label and expands preserved child fields. |
| Expand Latest snapshot | Actual row button retains original job name in accessible label and expands preserved child fields. |
| Done | Original close callback retained; focus restored. |
| Close | Original close and backdrop callbacks retained; Escape supported. |
| Rationale | Amber strip describes available upcoming/saved sources without asserting unselected evidence will be used. |
| Input / Selected / Timestamp or reservation / State / Cost | Aligned five-column wide table; accessible horizontal scroll on narrow viewports. |
| Upcoming run / INDIA / selected fraction / reservation / Reserved / n/a | Plain Upcoming output row, actual market as text, actual checkbox and 1/1 or 0/1 count, reserved/not generated wording; unknown cost stays n/a. |
| Latest snapshot / INDIA / selected fraction / timestamp / Synced / n/a | Plain Saved snapshot row; dynamic existing status, timestamp, market and cost. Example source date never hardcoded. Partial/error and unknown timestamps retained. Zero remains distinguishable from unknown cost. |
| Included: Upcoming run / INDIA | Included evidence tab derives included source list exclusively from actual selected IDs; no fixed example. |
| Not included: Latest snapshot / INDIA | Not included section derives excluded sources from actual selection; supports saved-only/both/none. |
| Expanded source content | Inspected existing code before restoring details: child checkbox, Job, Timestamp, Status, Market, LLM / Source, Cost (INR), Error all retained with original dynamic values and currency formatter. No invented source payload viewer. |
| Return to Select sources | Real button returns to source view and focuses its tab; selection and expansion states retained. |
| Existing source expansion controls in Included evidence | Same expansion buttons and preserved child table available in both views; state survives switching. |
| Audit boundary: no source was selected/reset/submitted | Report-only boundary omitted from product. Local fixture tests exercise controls without live side effects. |
| Proposed pair of views | Select sources default; Included evidence actual selection summary. Accessible tabs support Arrow keys, Home/End and selected state. |
| Visual grouping | Pale lavender modal, blue-gray border, navy headings, slate secondary text, purple active tab/white text, pale lavender inactive tab, amber rationale, white rows and light header. No decorative row badges. |

## Verification

- `node --test tests/rebalance-stage-inputs.test.mjs tests/rebalance-workflow-resilience.test.mjs`: 37 passed, including read-only opening, reset-to-upcoming and paid-stage source guardrails with local mocks.
- `npx tsc --noEmit`: passed.
- New component and browser-script ESLint: passed.
- Shared workflow ESLint: 2 errors/22 warnings, reproduced on `origin/main`; existing synchronous state updates at baseline lines 2826 and 2936. No new diagnostics.
- `node tests/input-evidence-offline.mjs`: passed. Real extracted dialog and row component, local React fixture, no backend/provider requests. Both views, included/excluded groups, original expansion fields and child selection, selection/reset/select-all, tab/view return, loading/empty/missing/failed states in both views, partial/error details, stale source timestamp, unknown vs zero costs, repeated open/close, Escape, focus restoration, Tab containment and tab Arrow/Home/End behavior. Desktop 1180×757 and narrow 390×844; no document overflow, source table and expanded children scroll independently.
- `git diff --check`: passed.
- Actual local fixture render screenshots inspected by this worker: `/tmp/auto-inputs-evidence/desktop-1180x757.png`, `included-desktop-1180x757.png`, `narrow-390x844.png`, `included-narrow-390x844.png`. Values are test fixtures, never production data.

## Integration and limits

`frontend/app/console/dashboard/_components/RebalanceWorkflowSections.tsx` is shared with Models/Stages work. Changes are confined to the input-picker import/dialog and input-loading error state; existing other-stage group rendering is preserved. Modal accessibility and responsive padding apply to this input picker only. Reconcile these hunks with Models/Stages branches during coordinator integration. Existing regression test receives only an error-setter mock. The new component and browser test are separate files.

Original selection persistence, source IDs, timestamps/currency formatter, permissions, reset/select-all, calculations and execution safeguards remain unchanged. No global density/container-width reduction. No live jobs, refreshes, scans, trades, payments, preferences or messages were triggered. Authenticated production integration and browser back-navigation remain untested; no routing logic changed. No independent merge/deploy or approval review.
