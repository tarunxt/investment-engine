# BOTS-OVERVIEW-RUNTIME

Actual source pixels were reviewed by native source reviewer `/root/verify_remaining_visual_requirements`; the coordinator supplied that reviewer’s complete visual requirements and source text for pages 131–136. This implementer did not view the PDF pixels or verify its bytes. The reviewer supplied SHA256 `99c8a31a06a854f1b7e8550eff6c79288713396ded6b211b315b138ad644ebf1`; it is attributed evidence, not a local hash result. No further transfer attempts were made.

Based on main `1089c6f1c5dc01c6cb41be1da7b45e9e7a8b805b`. Scope is the shared Bot Overview summary only. No API, calculation, scan, provider, execution, console routing, permission, or global density changes.

## Coverage

| Mapped item (report pages 132–136) | Implementation |
| --- | --- |
| Trading Bots Control Center / Overview; four named bots | Existing heading and scope retained in neutral header; four cards and console destinations retained. |
| Last refreshed, Refresh | Existing IST formatter, generated timestamp, passive refresh handler and disabled refresh state retained. |
| Bots running, total denominator | Runtime context row; existing count and “out of four” definition retained. |
| Bots paused/stopped and definition | Runtime context row; source count and existing definition retained. |
| Runtime caution | Visible beside runtime group; counts do not verify runtime or authorize starting a worker. |
| Total money invested, current value, P&L, return % | Capital and performance table with original values, USD/percent formatters and complete definitions. Missing metrics remain dashes. |
| Active positions, trades today, live exposure, dry-run exposure | Positions and exposure table with original values and complete definitions verified in source, including definitions outside the report crop. |
| Metric / Current display / Definition | Semantic tables with row and column headers in all three views. |
| Return to Runtime context | Button selects and focuses runtime tab. |
| Highest risk bot, Last updated (additional current fields) | Retained in Runtime context; no source metric dropped. |
| Source availability, partial and unavailable disclosures | Beside each group, with existing lower loading/error/fallback notices preserved. |
| Dedicated consoles, guardrails, details, history, warnings | Preserved; details button now exposes expanded state and panel relationship. |

The report's “lower content not certified” text is an audit limitation, not product copy. Current lower metrics, details, history and controls were inspected in the component and retained. Report sample amounts and dates are not used as production data.

## Validation

- `npx eslint app/console/trading-bots/_components/TradingBotsOverviewPage.tsx scripts/bots-overview-offline-playwright.mjs`
- `npx tsc --noEmit`
- `node --test tests/trading-bots-passive-summary.test.mjs tests/trading-bots-navigation.test.mjs` — 10 passed.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium BOTS_EVIDENCE_DIR=/tmp/bots-evidence node scripts/bots-overview-offline-playwright.mjs`

Browser fixture renders the actual component and shared CSS/Tabs. API reads are local promises. The existing UniversalPolymarketScan is stubbed out because it is unchanged and outside this task. External requests are blocked and asserted absent. Seven cases: loading, populated summary, unavailable summary, empty summary (retains four unknown bots), failed reads, partial summary, and stale source timestamp. All three views, 1180×757 at default scale, 390×844, no page overflow or tab/content overlap, arrow-key tabs, return/focus, repeated details open/close, all four exact console destinations and browser back navigation are checked. Failed Refresh is disabled in flight and preserves the selected capital view plus loaded $400 total. Active-tab white text is checked after its transition. Loaded fixture asserts $400 invested from four $100 balances. Stale source date remains January; no new freshness threshold is invented.

Tabs now use the source-reviewed purple/white active treatment and pale lavender inactive treatment, with dark-theme variants and a neutral content surface. All changes remain local to the overview; no global density or shared Tabs change.

Screenshots are fixture-only, containing no account data. [Before desktop](evidence/bots-overview-runtime/before-loading-desktop.png), [runtime](evidence/bots-overview-runtime/loaded-Runtime.png), [capital](evidence/bots-overview-runtime/loaded-Capital.png), [positions](evidence/bots-overview-runtime/loaded-Positions.png), [narrow](evidence/bots-overview-runtime/loaded-Capital-narrow.png). The evidence directory includes all three views at desktop and narrow for each of seven states, plus loaded dark-theme desktop captures (46 images total). Desktop captures are 1180×757 at scroll origin; narrow captures show the complete summary surface rendered in a 390×844 viewport so every definition is independently reviewable. [Runtime narrow](evidence/bots-overview-runtime/loaded-Runtime-narrow.png), [capital narrow](evidence/bots-overview-runtime/loaded-Capital-narrow.png), [positions narrow](evidence/bots-overview-runtime/loaded-Positions-narrow.png).

## Limits and coordinator follow-up

- Source PDF bytes could not be materialized. The current Library helper returned `download failed` for original `libfile_69395435517c8191aa25b189d62b27a5` and reupload `libfile_e735fdf1e9f48191b47cf49a5af5b476`, with explicit consumer-local destination `/workspace/bots-design/source.pdf`. No bytes were installed, so SHA256 cannot be verified. Supported Library read returned page text for 1–13, 131–136 and 148, but images were opaque asset pointers rather than inspectable pixels. Direct source page-image comparison remains unavailable to this implementer; reconciliation uses the native source reviewer’s actual-pixel requirements supplied by the coordinator. No image URLs were guessed or fetched. Separate task screenshot is unnecessary to identify this resolved scope and was not downloaded.
- Existing session cache write effect runs before the cache-read effect, overwriting a pre-seeded snapshot on mount. Observed with a local stale-cache fixture; left unchanged because this task is visual reorganization. Stale-source rendering is tested separately. Coordinator should track cache restoration as a separate behavior fix.
- Existing paused/stopped definition mentions error/setup-needed states while the current calculation counts paused and stopped only. Both original wording and calculation are preserved per task constraints; coordinator should reconcile that separately.
- Full authenticated production shell and live console navigation are not exercised; no production refresh or operational action was triggered. No dialog was introduced; existing detail disclosures were exercised.
- Shared-file conflict surface is only `frontend/app/console/trading-bots/_components/TradingBotsOverviewPage.tsx`. No shared global component/styles edited.
- Not merged or deployed. Coordinator owns serial integration and release.

## Native reviewer reconciliation checklist

- [x] Compact wide `max-w-7xl` container retained; neutral header replaces gradient prominence.
- [x] Three separate accessible views; Runtime context is default; selected purple/white and inactive lavender styling, light/dark variants.
- [x] Shared Trading Bots Control Center / Overview header retained.
- [x] All four identities remain in scope text and dedicated cards, including existing console destinations.
- [x] Last refreshed binds existing generated timestamp with IST formatter, never the source example date.
- [x] Running count, four-bot denominator and paused/stopped count bind existing calculations.
- [x] Existing paused/stopped definition retains paused, stopped, error and setup-needed wording; existing calculation mismatch disclosed above.
- [x] Refresh remains passive, disabled while refreshing; selected view and loaded values survive failed refresh.
- [x] Clear warning beside counts: displayed counts do not establish runtime or authorize a worker.
- [x] Capital table preserves Metric / Current display / Definition columns.
- [x] Total money invested and complete original definition preserved.
- [x] Total current value and complete original definition preserved.
- [x] Total P&L and complete original definition preserved.
- [x] Total return % and complete original definition preserved.
- [x] Unknown financial values remain dashes; source availability remains beside each group.
- [x] Positions table preserves the same three columns.
- [x] Total active positions and complete original definition preserved.
- [x] Total trades today and complete original definition preserved.
- [x] Live exposure uses actual existing definition: exposure on live-read or live-trading bots.
- [x] Dry-run exposure uses actual existing definition: paper, dry-run or analysis-only workflows.
- [x] Return to Runtime context selects and focuses the runtime tab.
- [x] Additional Highest risk bot / Last updated, lower cards, guardrails, history and links retained.
- [x] Audit certification notices, report header/footer, severity and NOT DEPLOYED badges excluded from product chrome.
- [x] Seven source states; all three views at 1180×757 and 390×844; narrow tabs do not overlap content and page does not overflow.
- [x] Keyboard arrows, return focus, repeated details open/close, back navigation, exact console destinations covered.
- [x] API calls, calculations, permissions, execution safeguards unchanged; browser fixture blocks external requests.
- [ ] Full authenticated shell and actual destination-page execution remain unverified; unchanged scanner is stubbed, no production or operational action performed.
- [ ] Independent visual comparison of these screenshot artifacts against source pixels remains coordinator/reviewer work.
