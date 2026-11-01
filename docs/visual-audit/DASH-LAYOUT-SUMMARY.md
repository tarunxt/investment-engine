# DASH-LAYOUT-SUMMARY

Base: `1089c6f1c5dc01c6cb41be1da7b45e9e7a8b805b` (current main fetched 1 November 2026).
Scope: `/console/dashboard` visual hierarchy only. This branch is for coordinator integration; no merge or deployment.

## Source and evidence limits

Read the supplied PDF's common pages 1–13 and 148, assessment/preservation pages 63–67, and all three proposed views on pages 68–70 through Library. The requested image-inclusive reads returned parsed text and sediment image pointers, without viewable image bytes. Both supported local materialization attempts (including a consumer-local destination retry) failed with `library file transfer failed: download failed` for:

- `CredX_Visual_Design_Simplicity_2026-11-01(1).pdf`, `libfile_e735fdf1e9f48191b47cf49a5af5b476`
- `image(20261101-024935).png`, `libfile_0d924221bd9881918bf2e207ee2d05a9`

Actual source page images and selection screenshot could not be inspected. Implementation is grounded in the supplied exact assessment, readable preservation map and current source; no invented production values. Local screenshots use fixture data only.

## Mapped coverage

- One neutral Dashboard / Portfolio overview header; removes the duplicate upper totals and competing command-center hero. Keeps existing page container width and density conventions.
- One aligned India / INDmoney / Bullpen summary, each explicitly portfolio + cash. Same financial inputs, total guards and native USD fallback. Combined INR remains omitted without complete sources and verified FX.
- Source identity, exact raw saved timestamp (time element/title), readable saved time, snapshot age, browser-cache age, refreshing, failure, last-available and incomplete-component disclosures remain beside each balance. One shared FX notice retains source and timestamp.
- Overview retains combined investments availability, oldest snapshot provenance, visibility control and all source refresh controls. Source information icons still open the corresponding methodology; dialogs trap focus, close on Escape and return focus to their opener.
- Sources and freshness retains all source status disclosures plus Portfolio and Cash components, missing-value dashes and source information/refresh controls. No partial source is represented as a complete total.
- Refresh behaviour retains stored-snapshot/FX reload scope, fresh Bullpen wallet read, open-workflow Zerodha sync context, last INDmoney import, no current-price guarantee and labelled last data on failure. The Refresh Board handler is unchanged and remains available above every view.
- Named "How portfolio totals are calculated" disclosure retains all source calculation descriptions. Warnings remain outside that disclosure.
- Portfolio history remains separately available with its existing portfolio/range preferences and financial calculations. Market cards, saved portfolio routes, threats and workflow destinations are unchanged.
- Initial route skeleton uses the same neutral three-column summary structure; client loading uses visible Loading labels without a duplicate hero.

## Validation

- Scoped ESLint and `tsc --noEmit`: passed.
- Dashboard portfolio totals, refresh errors, private dashboard cache and FX tests: 19 passed.
- Offline Playwright matrix: 14 states passed (loading, success, empty, failed, stale cache, partial source, missing cash, unavailable FX; deferred/loading/saved/cached/empty/failed report panels).
- Real client fixture at 1180×757, DPR 1/default zoom; all three views also exercised at 390px. No document horizontal overflow. All three views have screenshots.
- Keyboard arrow navigation between views; two repeated dialog open/close cycles, trapped focus, Escape, restored opener focus; visibility selection survives view changes; local Refresh Board requests verified. No unexpected external requests or browser runtime errors.
- Evidence generated in `/tmp/dash-layout-final/`: `results.json`, all state screenshots, `overview-1180.png`, `sources-1180.png`, `refresh-1180.png`, and corresponding `*-390.png` screenshots.
- Live authenticated back navigation, production UI and PDF pixel comparison were not tested. No provider jobs, scans, trades, payments or production refreshes were triggered.

## Integration

Shared-file conflict candidates: `frontend/app/console/dashboard/DashboardPageClient.tsx`, `_components/DashboardSkeletons.tsx`, `frontend/scripts/dashboard-freshness-playwright.mjs`, and `frontend/tests/dashboard-portfolio-totals.test.mjs`. Preserve unrelated availability fixes when integrating; no underlying financial/data-fetch logic is changed here.
