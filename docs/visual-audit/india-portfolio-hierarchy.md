# India portfolio hierarchy reconciliation

Scope: `/console/zerodha`, draft PR #1355. Main inspected at
`1089c6f1c5dc01c6cb41be1da7b45e9e7a8b805b` on 1 November 2026.

Actual PDF pixels on pages 137–144 were reviewed by native source reviewer
`/root/verify_remaining_visual_requirements`. This implementer did not access the
PDF pixels: both supported Library downloads failed. This reconciliation uses the
reviewer's supplied full preservation map and the repository implementation. No
further transfers were attempted. PDF SHA256 supplied by the reviewer:
`99c8a31a06a854f1b7e8550eff6c79288713396ded6b211b315b138ad644ebf1`.

| Mapped rows | Implementation and verification |
| --- | --- |
| p137 compact heading, India, dated snapshot, connection state | One heading and wrapping metadata line; selected historical date updates from saved response. Loading, absent, unavailable and disconnected states remain distinct. |
| p137 default saved access, wider margins and density | Setup is a closed native disclosure; snapshot is the first substantial content at desktop 100%. Outer container and global density styles remain unchanged. Main and changed fixture screenshots render independently. |
| p138 portfolio-history description, Connect Zerodha explanation, two options | Original integration description retained inside connection guidance alongside existing token exchange and post-login sync explanation. |
| p138 Quick Connect, steps 1/2/3 | Existing small-popup instructions, approval and connection-refresh/newest-snapshot steps retained verbatim. Popup and callback handlers unchanged. |
| p138 Connect with Zerodha and Open full-page login | Original button handler and target/rel/href retained. Fixture verifies control visibility and full-page href without clicking either. |
| p138 no connection action during audit | Execution constraint, not product copy. All unrecognized fixture API actions fail closed; network requests outside local origin are blocked. |
| p139 current India/Portfolio and six stages | Shared navigation retains Portfolio, Swing Trade, Threats, Events, Rebalance and Final Actionables. Current stage remains selected; header names India. Route-scoped CSS supplies purple/lavender colors with dark variants. |
| p139 India and US; p140 Stage/Markets and all six route pairs | All 18 existing anchors retained. Twelve unique market/stage destinations verified. Proposed inventory table is represented by working links, not added as inert duplicate rows. Shared component and route definitions unchanged. |
| p140 saved date/time and source | Existing snapshot date, capture time and detailed captured-at/source provenance remain; header binds selected saved date. No report example dates are inserted into production. |
| p140 holdings count, holdings values and available margin | Explicit count uses selectedSnapshot.holdings_count. Existing INR values, holdings/position rows, sorting, chart, and all private fields remain. No privacy placeholder replaces actual runtime values. |
| p141 existing snapshot controls | Historical selection verified; Sync retains connected/syncing disablement and original handler. Connection details, redirect details, disconnect and connected order controls remain. No dummy preservation button added. |
| p141 browser-worker statement and private crop limits | Evidence annotations are excluded from runtime. Screenshots contain only synthetic fixtures. Private/offscreen source rows are preserved from current code, not claimed as visually certified. |
| p141 second connection method offscreen | Existing Manual Token explanation, request_token input, required validation, disabled-empty Connect button and submit/callback implementation retained. Fields are inspected in source and rendered locally; no token is submitted. |
| p142 connection mapped view | Available through collapsed Connection guidance; desktop/narrow screenshots captured after opening. Native Enter open/close and focus tested repeatedly. |
| p143 market/stage mapped view | Always available beneath title; all destination hrefs verified. No provider work triggered by validation. |
| p144 snapshot mapped view | Saved data displayed directly; separate context screenshot includes saved provenance. Initial failure does not falsely render no-snapshot; partial overview failure retains loaded snapshot. |

Validation commands (frontend directory):

- `npx eslint app/console/zerodha/page.tsx app/console/zerodha/_components/PortfolioSnapshotsPanel.tsx app/console/zerodha/_components/ZerodhaConnectionGuide.tsx scripts/india-portfolio-hierarchy-playwright.mjs`
- `npx tsc --noEmit`
- `node --test tests/zerodha-sync-preflight.test.mjs`
- `node scripts/india-portfolio-hierarchy-playwright.mjs`

Evidence defaults to `/tmp/india-portfolio-evidence`: baseline-1180.png,
baseline-390.png, desktop-saved.png, narrow-saved.png, desktop-connection.png,
narrow-connection.png, desktop-context.png, desktop-dark.png and results.json.
Screenshots render real components and CSS in an isolated shell, with fixtures;
they do not certify full production-shell or real account interactions. No new
dialog is introduced. Connection, token submission, sync, disconnect and order
execution are deliberately unexercised. Database/query behavior is unchanged.

Integration conflict surface: the Zerodha page, its PortfolioSnapshotsPanel and
ZerodhaConnectionGuide. New CSS is scoped to this route. Do not merge/deploy
independently of the twenty-task coordinator.
