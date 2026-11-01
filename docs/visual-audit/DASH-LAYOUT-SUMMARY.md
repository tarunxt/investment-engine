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
- Initial route skeleton uses the same neutral three-row summary structure; client loading uses visible Loading labels without a duplicate hero.

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

## Native-source reconciliation (follow-up)

`/root/prepare_visual_task_excerpts` independently opened the native PDF pixels for pages 63, 68, 69 and 70 and read preservation maps 64–67. That review supplied the implementation handoff: pale lavender panel; navy/slate type; purple active/pale inactive tabs; amber currency strip above actions; white aligned tables with thin dividers. This code worker did not view the native PDF pixels and did not retry Library transfers.

The specific mapped table views supersede the earlier generic three-card interpretation. Overview now has Portfolio / Portfolio + cash / Snapshot age; Sources and freshness has Source / Refresh / Captured snapshot text / Age / INR; Refresh behaviour is a six-fact description list. The existing source controls, data, masking, omission guards and refresh handlers remain. Table overflow is local, focusable and keyboard scrollable at narrow widths. Loaded and unavailable rows share the same structure. Source text is no longer duplicated within an overview row. No report-only navigation, labels or example values are present.

The local follow-up renders were inspected by this worker against the reviewer's description. The parent subsequently relayed a native actual Dashboard pixel-review pass for scoped hierarchy and all 39 mapped items; final integration remains with the sole integrator. Live authenticated navigation remains untested.

### Complete preservation map checklist

All values below are runtime-driven; captured sample ages/amounts are never hardcoded.

| Map item | Preserved destination and verification |
| --- | --- |
| 64.1 Dashboard identity / overview | One Dashboard header and portfolio overview subtitle; browser verifies one h1. |
| 64.2 India Portfolio + cash label | India row under Portfolio + cash column; native table readback. |
| 64.3 India availability | Existing complete status / total input; loaded, empty, failed, partial fixtures. |
| 64.4 India incomplete-component warning | Inline availability text; missing data stays incomplete. |
| 64.5 India refresh outcome | Inline failure/last-available text; Sources Refresh column; failed/stale fixtures. |
| 64.6 India source identity / source-state text | Existing source text adjacent to balance and in Captured snapshot text; no inferred existence claim. |
| 64.7 India snapshot age | Snapshot age column and Sources Age; existing dataAge helper. |
| 64.8 INDmoney Portfolio + cash label | INDmoney row under Portfolio + cash; native currency preserved. |
| 64.9 INDmoney availability | Existing complete status; incomplete saved snapshot versus unavailable source labelled; no combined figure fabricated. |
| 64.10 INDmoney incomplete warning | Inline availability; missing-cash/partial fixtures. |
| 64.11 INDmoney refresh outcome | Inline failure and Sources Refresh; partial-source/failed fixtures. |
| 65.1 INDmoney source identity / source-state text | Runtime source text adjacent to balance and in Sources. |
| 65.2 INDmoney age | Overview Snapshot age / Sources Age; independent from cache age. |
| 65.3 INDmoney INR prerequisite | Inline INR unavailable notice, Sources INR and shared FX strip. |
| 65.4 Bullpen Portfolio + cash label | Bullpen row under Portfolio + cash. |
| 65.5 Bullpen availability | Existing status and resolved values; native USD fallback; loading/failed/empty fixtures. |
| 65.6 Bullpen incomplete warning | Inline availability text; never fills missing portfolio/cash with a made-up zero. |
| 65.7 Bullpen refresh outcome | Inline failure and Sources Refresh; local fixture wallet failure. |
| 65.8 Bullpen source identity / source-state text | Existing source text next to balance and in Sources. |
| 65.9 Bullpen age | Overview Snapshot age / Sources Age. |
| 65.10 Bullpen INR prerequisite | Inline notice, Sources INR and shared FX strip. |
| 65.11 Shared FX warning | Single amber strip with FX source/time or missing/stale warning; visible in all views. |
| 66.1 Browser cache age | Existing provenance strip plus per-source saved-copy age; distinct from snapshot age. |
| 66.2 Refresh board | Same handler moved below currency strip; available in all views; safe fixture verifies local requests. |
| 66.3 Stored portfolio / FX reload scope | Meaningful short action provenance plus Refresh behaviour fact 1. |
| 66.4 Fresh Bullpen wallet read | Short action provenance plus Refresh behaviour fact 2; handler unchanged. |
| 66.5 Zerodha open-workflow sync context | Refresh behaviour fact 3; original event dispatch retained. |
| 66.6 INDmoney last import | Refresh behaviour fact 4; no new import/provider behavior. |
| 66.7 No current-price guarantee | Action provenance plus Refresh behaviour fact 5. |
| 66.8 Last available data on read failure | Existing status fields rendered inline and in Sources; Refresh behaviour fact 6. |
| 66.9 Total investments / combined availability | Retained once beneath the mapped content; current omission guard and privacy control. |
| 66.10 Combined provenance / omission rule | Existing sources, oldest-snapshot age and incomplete omission disclosure beneath content. |
| 67.1 Native USD stays USD | Existing currency/value selection retained; missing/stale FX fixtures; INR column explicitly unavailable. |
| 67.2 Total visibility eye | Original boolean masking behavior; descriptive button name/pressed state; persists across views. |
| 67.3 Zerodha lower source identity / incomplete state | Sources row identity, status, Portfolio and Cash fields; underlying market card untouched. |
| 67.4 Zerodha info / circular controls | Real source-methodology dialog and original refresh callback; keyboard/focus/repeated-cycle checks. |
| 67.5 INDmoney lower source identity / incomplete state | Sources row identity, status, Portfolio and Cash fields; underlying market card untouched. |
| 67.6 INDmoney info / circular controls | Real methodology dialog and original refresh callback; no placeholder/report-only controls. |
| 67.7 Portfolio / Cash missing dashes | Original formatInr/formatUsd handling and privacy mask; missing-cash/empty fixtures; no component dropped. |
| 67 limitation: offscreen children | Current component inspected; market cards, chart options/ranges, holdings, threats, workflow and saved-data routes retained. |
| 67 limitation: failure is not verified absence | No data-fetch/calculation/cache logic changed; existing status fields only. Canonical TRUST availability ownership remains with integrator. |

### Follow-up verification and artifacts

Scoped ESLint, TypeScript and 19 focused regression tests pass. The expanded offline browser harness exercises all three views for every primary loading/success/empty/failed/partial/stale/FX state at both 1180×757 and 390×757, plus six deferred report states (14 states total). It verifies DPR 1, visual viewport scale 1, no document overflow, reachable rightmost table columns, keyboard scrolling, non-overlapping tabs and currency notice, arrow-key tabs, all three source dialogs/focus return, source refresh event/read semantics, repeated keyboard methodology open/close and persisted masking selection. No real provider/sync actions run.

Updated committed evidence is under `docs/visual-audit/evidence/dash-layout-summary/`. The six principal screenshots are native viewport captures: `overview-1180.png`, `sources-1180.png`, `refresh-1180.png` and corresponding `*-390.png` files. Additional primary-state screenshots and `results.json` support availability readback. Full local evidence remains in `/tmp/dash-native-accepted/`.

## Baseline masking exception verified after native screenshot review

The total-visibility eye is **summary-scoped, not whole-page masking**. Native review observed an unmasked India amount in the retained history chart while the summary was masked. This is unchanged baseline behavior, not a new chart exposure introduced by this task.

Exact source evidence against baseline `1089c6f1c5dc01c6cb41be1da7b45e9e7a8b805b`:

- `DashboardPageClient.tsx` baseline lines 603–615 declare `showInvestmentNumbers` inside `PortfolioCommandSummary` and apply it only through that function's `formatPrivateInvestmentValue`. Baseline lines 700–724 bind the eye and combined amount to that local state. Its source-component Portfolio/Cash amounts use the same formatter.
- Baseline lines 1804–1807 render the separate `PortfolioCommandChart` with only `userId` and `options`; no masking value or callback crosses into the chart. Current lines 1915–1918 retain exactly those chart props. Moving the chart into a separately named history section changed layout, not masking.
- `PortfolioCommandChart.tsx` has the identical Git blob at baseline and implementation head `7e3831ec3f64a4b3d49f230c2ad105c5c12d3607`: `262e0afc64a44df82fb3a4cc119eb683ab6a700d`. `git diff 1089c6f1 HEAD -- frontend/app/console/dashboard/_components/PortfolioCommandChart.tsx` is empty. Both insufficient-history and populated-history branches render `formatInr(selectedOption.currentValue)` directly at lines 290 and 364. History change/hover values are also independent of the summary eye.
- Current `PortfolioCommandSummary` lines 583–594 retain the same false initial state and formatter-based masking. The consolidated source totals and source Portfolio/Cash components and combined total still use it. Source timestamps and warnings are readable independent of the eye.
- The removed duplicate top overview was itself unmasked at baseline; market-detail cards also have independent unmasked financial values. This task makes no whole-page privacy guarantee. Expanding masking to chart/history/market cards requires separate scope and is not part of this preservation change.

A safe fixture regression verifies the actual rendered scope: summary amount contains asterisks and no digits when hidden; Show reveals its synthetic India amount; Hide masks it again; the retained history chart continues displaying the same synthetic India amount throughout. Native 1180×757 screenshots are `masking-scope-summary-hidden-1180.png` and `masking-scope-summary-shown-1180.png`. No financial/chart implementation was changed in response to this observation.
