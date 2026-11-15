# JOURNEY-INDIA-SNAPSHOT-DISCOVERY

Implementation baseline: `c7d4942e03a3d0be320195b11fbbf24c5e83b94c` (origin/main).
Task branch checkout began 2026-11-01 04:18:34 UTC, recorded in git reflog.
The supplied page-17 finding was verified by the parent native source reviewer;
this worker did not independently view the PDF pixels.

Current main already collapsed connection guidance and showed saved-data metadata.
It lacked the requested prominent anchor and a named, focusable destination.
This change adds read-only navigation without changing data, permissions or calculations.

Labels and routes:
- `View saved snapshot` → `/console/zerodha#saved-portfolio-snapshots`
- `View any saved portfolio data without signing in to Zerodha. Reconnect separately to sync new provider data.`
- `Saved portfolio snapshots` is the named destination region.
- `Back to portfolio top` → `/console/zerodha#portfolio-top`

Both targets accept programmatic focus. Native anchors retain browser history and
keyboard behavior. Initial fragment focus is restored after the existing status
placeholder mounts the page. Connection guidance and both connection options remain separate.
The existing application authentication boundary remains in place; no Zerodha login
or provider calls are required by these links.

Validation:
- `cd frontend && node scripts/india-snapshot-discovery-playwright.mjs`: PASS.
- `cd frontend && npx tsc --noEmit`: PASS.
- `cd frontend && npx eslint app/console/zerodha/page.tsx scripts/india-snapshot-discovery-playwright.mjs`: PASS.
- `git diff --check`: PASS.

The fixture renders the actual production page with local API substitutes and blocks
external requests. Tested at 1180×757 and 390×844, device scale 1: saved, loading,
confirmed empty, failed, partial, unavailable connection status, unconfigured and
connected. Checks include native anchor keyboard focus/order, return to header,
browser Back, direct deep link after asynchronous mount, no overflow, disabled sync
while disconnected, retained snapshot provenance and existing connection links.
No state was inapplicable. Zero external requests and zero forbidden API actions.
Navigation adds no API calls beyond the existing page's fixture reads.

Evidence: `baseline-{1180,390}.png`, `saved-{1180,390}.png`,
`saved-destination-{1180,390}.png`, and `results.json` in this directory.
The complete per-state screenshot set is generated under
`/tmp/india-snapshot-discovery-evidence` by default (override `INDIA_EVIDENCE_DIR`).
Desktop and narrow saved-state screenshots were visually inspected in this worker.
These are standalone page fixtures, without application shell chrome.

No production QA, connection, sync, order, account change, paid action, merge or
deployment was performed. The parent owns serial integration and deployment.
The only production-code overlap is `frontend/app/console/zerodha/page.tsx`;
no dialog/accessibility subsystem changes are included.
