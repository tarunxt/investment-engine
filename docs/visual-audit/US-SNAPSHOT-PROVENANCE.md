# US-SNAPSHOT-PROVENANCE

Base: origin/main 1089c6f1. Scope: `/console/indmoney-us` only.

The page header now identifies manual snapshot provenance and the selected saved timestamp. The summary repeats source/time beside totals and states that parsed data does not imply current prices. Import snapshot expands the existing timestamp/paste/save workflow on a neutral surface. Refresh displayed data only reads saved overview/detail records, retains the selected historical snapshot, and keeps displayed records on failure. Holdings and Historical trend have simple headings. Narrow chart/table grids now contain horizontal overflow locally.

Preservation map (PDF 82–85): manual tracking/no API, capture timestamp, parse status, purpose, private values, holdings/allocation/returns/context, raw text and reconciliation warnings retained; timestamp guidance, textarea, character count and Save Snapshot retained; Portfolio/Swing Trade/Threats/Events/Rebalance/Final Actionables and India/US destinations retained in unchanged PortfolioAnalysisNav. No financial calculation, API contract, currency, selection policy, execution permission or provider job changed. No global density changes or shared-file edits.

Validation:
- Scoped ESLint and `npx tsc --noEmit`: pass.
- `node --test tests/us-snapshot-provenance.test.mjs tests/us-snapshot-rendering.test.mjs`: 6 pass. Covers retained historical/latest/missing selection, read failure, panel loaded partial/stale/empty/loading/failed states, expanded/collapsed form fixtures, disabled empty save, input focus and page overflow at 1180x757 and 390x757.
- `node --test tests/portfolio-history-integrity.test.mjs tests/portfolio-stage-history.test.mjs`: 10 pass.
- Synthetic component screenshots: `/tmp/us-snapshot-evidence/{1180,390}-{saved,import}.png`. Rendered component fixtures with actual Tailwind CSS; not production or hydrated full-page captures. Text-entry check resets the textarea before screenshot.

Source limits: Library preparation and supported helper transfer attempted for PDF libfile_e735fdf1e9f48191b47cf49a5af5b476 and screenshot libfile_0d924221bd9881918bf2e207ee2d05a9, including bounded consumer-local retry. Both downloads failed, so readable local bytes and actual page-image inspection could not be verified. Library extracted text for common pages 1–13,148 and scoped pages79–88 was read. Page image references were returned, but not usable local images; pages85/87 explicitly reported images unavailable. Implementation follows assessment/preservation text and inspected current source, without claiming visual matching to unavailable pixels.

Limits: no production access or side-effectful actions; no complete hydrated keyboard/open-close/back navigation or full-shell screenshots. No dialogs introduced. Draft PR/remote exact CI depend on available GitHub authentication. Coordinator must integrate, verify and deploy; this task does not merge or deploy.
