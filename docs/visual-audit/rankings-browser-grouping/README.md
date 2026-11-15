# Rankings browser grouping implementation evidence

Source interpretation: native reviewer `/root/verify_remaining_visual_requirements` inspected the PDF pixels and preservation maps on pages 120–125 (SHA256 `99c8a31a06a854f1b7e8550eff6c79288713396ded6b211b315b138ad644ebf1`). The implementer used that supplied verified interpretation; direct Library materialization failed and the implementer did not view the PDF.

## Preservation checklist

- [x] Sports Rankings, repository purpose, 15-minute feed cadence, one-minute page cadence and analysis-disabled warning remain in the compact neutral heading.
- [x] All five counters retain their calculations and show dashes for initial loading/failure. Failed list count is unknown, never confirmed zero/empty.
- [x] A single amber repository recovery banner preserves the original diagnostic summary, Retry now and View details handlers. Automatic attempts are described without claiming successful recovery.
- [x] Two semantic tab views use purple/white active and lavender inactive styling; arrow keys, Home/End, roving focus and an explicit return control work.
- [x] Real search, original placeholder, All sports and All sources selectors remain functional. Filter values and disclosure state persist across view changes. Successful empty results retain their distinct empty state.
- [x] Full-match head-to-head rules and complete wording are preserved as a native keyboard-operable disclosure.
- [x] Complete competition navigation, participant searches, imported-only filter, ranking groups, every table column, row, source/status/timestamp field, link and imported-event disclosure remain. Cricket reconciliation and refresh controls retain their original effects and disabled states. Selecting a competition returns to the repository view and its tab focus.
- [x] Data reads, retry policy, source calculations, matching/classification, permissions and execution safeguards are unchanged. Partial polling failures retain loaded data; stale source warnings remain.
- [x] No audit headers, sample production values, severity badges or prototype labels became product controls. No global CSS/density changes.

## Verification

- `node --test tests/sports-rankings-{summary,recovery,error-dialog}.test.mjs`: 14 passed, including existing fixture retry coverage and new view/filter preservation coverage.
- `npx tsc --noEmit`: passed.
- ESLint on the browser harness and updated test: passed. Page ESLint retains the documented baseline `react-hooks/set-state-in-effect` error in deep-link initialization; no new lint findings.
- `node scripts/rankings-browser-offline-playwright.mjs`: passed. See `results.json`. Runs the actual component, actual read client and production CSS against local fixtures, blocking nonlocal requests and non-GET actions. Covers loading, loaded, successful empty, failed, partial and stale, tabs/focus, disclosure keyboard, return, retained filters and desktop/narrow overflow. Tab/view changes issue no additional reads. Recovery and provider controls are not clicked by this browser QA.
- `git diff --check`: passed.

PNG artifacts are actual Chromium renders at 1180×757, device scale 1, and 390×844 narrow layout (full-page capture). They exclude the application shell and use clearly marked fixture data. They are implementation evidence, not production screenshots or source PDF images. Dialog internals are unchanged and covered by the existing static regression test; browser open/close, dialog focus and browser-history navigation are not newly certified by this fixture harness. No production/provider actions were performed.

No merge or deployment is part of this branch. Only Rankings page, scoped tests/harness and this evidence directory change; no shared-file conflicts introduced.
