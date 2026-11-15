# Corrective availability disclosure after 1822d4d7

Fetched current main `1822d4d7` on 2026-11-01 UTC. Corrects residual presentation claims in the market-card and chart fallbacks; no data, calculations, provider reads, import behavior, or execution code changed.

- Failed or pending source reads and cached unverified data no longer show “Connect Zerodha and sync at least one snapshot to unlock India portfolio cards and threat prioritization here.” or “Paste an INDmoney US snapshot to surface allocations, return metrics, and threat signals on the dashboard.” They show the existing precise availability status instead. Both original guidance messages remain for a successful empty response.
- Missing connection metadata on a failed/pending read says “Unverified”, rather than “Disconnected”.
- Empty top-holdings rows on failed/pending/cached reads say “Holdings availability is unverified. View saved portfolio history.” Successful empty holdings guidance remains unchanged.
- A chart with too few displayed points and an unverified source says “Cannot verify saved snapshot history for All Time. History sufficiency is unknown; view saved portfolio history.” (or “Past Day” for that selected range), with a plain saved-history link for the selected India/US source. Its live status is polite. No count is asserted. Combined charts inherit constituent read/cache states. Missing required FX also prevents a false insufficiency claim.
- A verified successful short history retains exactly “Insufficient genuine snapshot history for All Time. The chart appears after at least 4 verified snapshots are available.” Genuine retained history still renders after refresh failure; the count is not thrown away or fabricated.

Actual-component isolated browser fixtures: 16 scenarios pass at desktop 1180px, 100% zoom and narrow 390px. The new failed-retained-history scenario first loads four genuine synthetic saved points, then fails the next mocked summary read, asserts the retained chart still renders, then selects 1D and asserts unknown range sufficiency. Failed/partial/cached scenarios assert the exact sync/import phrases are absent and all affected portfolio chart choices report unknown history; successful empty asserts those original phrases and the original four-point guidance remain. Failure, empty, and retained-history cards and charts have desktop/narrow screenshots. Existing keyboard/overflow and missing-FX tests remain in the runner. All network effects are isolated mocks; no live refresh/import was performed.

Node regression tests: 24 pass, 0 fail, 0 skipped. TypeScript passes. Scoped ESLint has one pre-existing `react-hooks/set-state-in-effect` error in the unchanged chart local-history effect, reproduced against the exact main baseline (baseline and current logs included). All other scoped lint rules pass when that one rule is disabled on the command line; source configuration is unchanged. Production build, physical screen-reader readback, merge, deployment and live readback were not run by this worker. PR creation was not retried.

Reproduce from frontend:

```sh
DASHBOARD_ESBUILD_PATH=/tmp/credx-build/node_modules/esbuild DASHBOARD_EVIDENCE_DIR=/tmp/trust-dash-residual node scripts/dashboard-freshness-playwright.mjs
node --test tests/dashboard-snapshot-availability.test.mjs tests/dashboard-portfolio-totals.test.mjs tests/dashboard-refresh-errors.test.mjs tests/private-dashboard-cache.test.mjs
npx tsc --noEmit
```

Final verification completed: 2026-11-01T06:52:15.238473+00:00
