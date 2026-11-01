# TRUST-DASH-SNAPSHOT-AVAILABILITY

Baseline: `8212f9e93772a8f5a91f3f782640aeeff0fe7cc8`, fetched from origin/main on 2026-11-01 UTC.

Presentation-only repair: dashboard source names no longer claim stored/imported records are absent when summary availability is unknown or failed. Each source reports checking, failed verification, last-known saved data, successful availability, or a successful empty response separately from portfolio/cash completeness. Snapshot existence does not depend on a timestamp being present. Source dates and browser-cache times remain separate and come only from existing response/cache fields.

Final labels read back:

- Unknown: “Checking saved snapshot availability”.
- Failed: “Refresh failed · Cannot verify saved snapshot availability”.
- Failed with saved data: “Refresh failed · Cannot verify saved snapshot availability · Last-known snapshot shown”.
- Pending with saved data: “Checking saved snapshot availability · Last-known snapshot shown”.
- Cached known: “Last-known saved snapshot · Current availability unverified”.
- Successful known: “Saved snapshot available”.
- Confirmed empty response: “No saved snapshot returned by the latest successful read”.
- History links: “View India saved portfolio history” and “View US saved portfolio history”. Plain anchors target the existing saved-history panels; they have no refresh/import/order handlers or prefetch.

Verification (2026-11-01 UTC): 24 Node tests pass, 0 fail, 0 skipped; TypeScript `npx tsc --noEmit` passes; scoped ESLint passes. Actual DashboardPageClient browser fixtures run at 1180×757 desktop (devicePixelRatio=1, visualViewport.scale=1) and 390×757 narrow width. All 15 scenarios pass: loading, success, empty, failed, stale-cache, stale-response (30-day-old successful saved response), partial-source, missing-cash, unavailable-fx, and six deferred/report scenarios. The fixture mocks summary/report APIs and blocks unexpected external effects; no production failures or provider operations were induced. Keyboard focus/Tab/Shift+Tab reaches history links; tables remain keyboard-scrollable at narrow width; statuses expose polite atomic announcements. Existing missing-FX and incomplete-total gates remain asserted.

Reproduce from frontend:

```sh
node --test tests/dashboard-snapshot-availability.test.mjs tests/dashboard-portfolio-totals.test.mjs tests/dashboard-refresh-errors.test.mjs tests/private-dashboard-cache.test.mjs
DASHBOARD_ESBUILD_PATH=/tmp/credx-build/node_modules/esbuild DASHBOARD_EVIDENCE_DIR=/tmp/trust-dash-after node scripts/dashboard-freshness-playwright.mjs
npx tsc --noEmit
npx eslint app/console/dashboard/DashboardPageClient.tsx app/console/dashboard/_components/TotalDataStatus.tsx
```

Before/after screenshots use synthetic fixtures and the real component and styles. `results.json` records the browser pass results. Production data, formulas, provider calls, persistence and execution code are unchanged. Browser tests verify DOM announcement semantics, not output from a physical screen reader. The older-response fixture verifies old source age disclosure, not a deliberately raced production request. Production build, merge, deployment, and live verification are reserved for the batch integrator and were not run by this worker.

Final fixture verification completed: 2026-11-01T06:22:57.808026+00:00
