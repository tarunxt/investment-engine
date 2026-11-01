# SCANNER-TABLE-COMPARISON

Route: `/console/technical-setups`. Base: `1089c6f1c5dc01c6cb41be1da7b45e9e7a8b805b`.

## Source provenance

Native source reviewer `/root/verify_remaining_visual_requirements` reviewed actual PDF pixels and the complete preservation map on pages 126–130. The coordinator supplied that review, full source text and verified requirements to this implementation task. Source identity: `libfile_e735fdf1e9f48191b47cf49a5af5b476`; supplied SHA256 `99c8a31a06a854f1b7e8550eff6c79288713396ded6b211b315b138ad644ebf1`. Source interpretation below is attributed to that reviewer. This implementer did not see the PDF images or independently verify its bytes/hash. Earlier supported materialization attempts failed and were not retried after the coordinator's instruction. The supplied native review resolves the prior missing-mapping implementation blocker.

## Full mapping checklist

| Mapped item | Implementation / verification |
| --- | --- |
| Setup comparison, default view | Selected by default; named accessible tab and panel. Actual desktop/narrow renders captured. |
| Sorting guidance, separate view | Named accessible tab and panel; long help moved here. Purple active/lavender inactive tabs and pale neutral rounded workspace. |
| Existing sortable column headers | Functional existing buttons retained, with ascending/descending aria-sort. Every header in both tables exercised by keyboard. No inert prototype-annotation button added. |
| Shared loading-count status | One amber message: “Loading setup counts from run history and portfolio snapshots. No count is inferred as zero.” Both tables reference it; no repeated per-row loading suffix. |
| Setup / Confidence / Best use / Entry trigger / Invalidation | All five columns remain in main tables; entry and invalidation remain adjacent. Bearish table retains its specific “Sell / trim trigger” label. Headers are muted with thin row separators. |
| Breakout + retest | Existing catalogue: 8.8/10; High-quality continuation; Retest holds and bounces; Close below retest level. All five rendered fields verified. |
| Higher-low pullback | Existing catalogue: 8.8/10; Best trend-continuation setup; Bounce after higher low; Close below higher low. All five rendered fields verified. |
| Relative strength breakout | Existing catalogue: 8.8/10; Best breakout filter; Stock breaks out while index is flat/weak; Back inside base. All five rendered fields verified. |
| Volume dry-up pullback | Existing catalogue: 8.8/10; Strong swing continuation; Break above pullback high; Close below pullback low. All five rendered fields verified. |
| All unobserved/offscreen rows and rules | No catalogue changes. Test compares every rendered name, confidence, best-use text, trigger and invalidation across all 24 bullish + 21 bearish rows to the current catalogue. Descriptors remain catalogue text, not measured performance claims. |
| Bullish defaults | Guidance: Highest stock count, then highest confidence, then alphabetical. Existing data-driven sorting code retained. |
| Bearish defaults | Guidance: Highest confidence first. Existing data-driven sorting code retained. |
| Column heading toggle help | Guidance: Toggle descending and ascending order. Existing sorting remains functional. |
| SellAll, Add More, Buy New, Trim, Hold | Exact action-context labels moved from the long Setup header to guidance. Existing live count breakdowns and accessible labels retained. |
| Return to Setup comparison | Explicit return button; restores last focused comparison control (or comparison tab). Both table components stay mounted, preserving selected sorts across view switches. Arrow keys/Home/End manage tab selection/focus. |
| “No sort or trade was executed in this visual audit” | Excluded as report-only audit furniture; not a runtime claim. Report headers, footers, priority labels and preservation-map annotations likewise excluded. |
| Loaded counts, actions and navigation | Existing confirmed zeroes, grouped action counts, stock dialogs, currency/value strings, links and target-row navigation preserved. Loader, calculations, permissions and execution code unchanged. |
| Partial / unavailable / stale | Existing all-or-nothing source handling retained: source failure remains unavailable, never zero. Current schema has only loading/ready/error, with no independent per-row or freshness status. No invented status or freshness claim added. Historical saved display strings pass through unchanged in the fixture dialog. |
| Compact 100% / wide containers / narrow | Existing outer width and cell spacing retained. Only local workspace chrome added; no global density changes. Desktop 1180×757 and narrow 390×844 checked, with table overflow contained and horizontally reachable. |

## Verification

- `npx eslint app/console/technical-setups/page.tsx scripts/scanner-table-offline-playwright.mjs tests/full-run-history.test.mjs`: passed.
- `npx tsc --noEmit`: passed.
- `node --test tests/technical-price-evidence.test.mjs tests/final-actionables-run-identity.test.mjs tests/actionables-runs-matching.test.mjs tests/final-actionables-consensus-denominator.test.mjs tests/full-run-history.test.mjs`: 43 passed.
- `SCANNER_EVIDENCE_DIR=/workspace/scanner-evidence node scripts/scanner-table-offline-playwright.mjs tests/full-run-history.test.mjs`: passed. Actual scanner page rendered with isolated fixture dependencies; external requests denied. Covers all catalogue fields/rules/scores, both mapped views, return and retained sorting/focus, keyboard sorting for all headers, keyboard tab controls, loading, populated, empty, failed/retry, partial source failure, historical saved display values, repeated stock-dialog open/close, narrow horizontal scroll and browser back.
- Screenshots: `/workspace/scanner-evidence/loading-1180.png`, `loaded-1180.png`, `guidance-1180.png`, `loaded-narrow.png`, `guidance-narrow.png`, `failed-narrow.png`. Each also has a `-viewport.png` capture at the exact configured viewport. These are safe local fixture renders without the production shell, not production or PDF images.

- Exact aggregate dashboard regression command from `.github/workflows/pr-checks.yml`: 505 passed across 51 test files.

## Remaining limits and coordination

No separate stale-state or per-row availability contract exists in this page; introducing either would require data-contract work beyond this visual reorganization. The historical fixture verifies unchanged display-value pass-through, not a real provider freshness detector. Existing stock modal Escape/focus-trapping/return-to-trigger limitations are unchanged; button-close and repeated reopening are verified. No live provider, refresh, scan, trade, account mutation, merge or deployment was performed.

Only `frontend/app/console/technical-setups/page.tsx` is production code changed. Parallel work touching that file must reconcile the shared status IDs, tab/panel wrapper and Setup header label. The existing scanner assertion in `frontend/tests/full-run-history.test.mjs` was also updated for the shared loading requirement; parallel edits to that test should retain its safety assertions. No automated-rebalance or global layout files changed. The existing draft PR receives branch commits for coordinator integration; do not merge/deploy independently. Automatic approval review denied updating its title/body (stating metadata publication was not explicitly authorized), so its original description remains stale pending explicit authorization.

The exact earlier CI jobs 124732792241 (run 41267340844, ff7103e6) and 124735064465 (run 41268110475, e93c3547) were inspected. Both failed only the pre-existing scanner assertion requiring a per-row Loading suffix, which contradicts the mapped shared-status requirement. The updated test requires the plain loading setup name and shared loading status while retaining every unavailable/verified-zero/loaded-count assertion. No unavailable/zero safety assertion was removed.
