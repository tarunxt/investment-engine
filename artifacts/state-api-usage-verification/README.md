# STATE-API-Usage-FailedVersusEmpty verification

Verified 2026-11-01 06:19 UTC against fetched origin/main and HEAD
`8212f9e93772a8f5a91f3f782640aeeff0fe7cc8`.

Outcome: preserve existing application implementation. No remaining regression was
reproduced in this objective. No application source changes, merge or deployment.
Preceding Visual, Journey and Accessibility changes are preserved.

## Reproduction and results

From frontend:

```
node --test tests/api-usage-failed-versus-empty.test.mjs tests/api-read-fallbacks.test.mjs tests/api-errors.test.mjs
API_COST_SCREENSHOT_DIR=/workspace/investment-engine/artifacts/state-api-usage-verification node scripts/api-cost-provenance-playwright.mjs
```

Node: 12 passed, 0 failed, 0 skipped.
Browser: 1 composite actual-component fixture passed, 0 failed, 0 skipped.
It bundles the existing page and breakdown with real React and compiled Tailwind;
all data reads use controlled promises and external browser traffic is blocked.
1180x757 and 390x757 viewports use default device scale/100% baseline.

Verified loading, populated success, confirmed empty, timeout, failure after empty,
retained populated content with stale warning, recovery, selected-day navigation,
partial provider-history sources and rejection of out-of-order breakdown responses.
Keyboard Enter recovery, chart controls, four provider filters, native USD when FX
is unavailable, and no document overflow pass. No external calls or writes occurred.
No live orders, paid calls or submissions were used.

## Read-back and contract inspection

The saved failed-1180.png was reopened and visually inspected: the breakdown shows
the four-second fixture error and 'Usage unavailable for the selected day. No
zero-usage conclusion can be drawn.' Its date input remains present. The separate
provider table is independently successful-empty in this fixture and is preserved.

Breakdown Refresh calls GET /backend-api/api-usage/llms/breakdown with
period=custom and custom_start=custom_end=selectedDate, cache=no-store and
credentials=same-origin. Date boundaries remain Asia/Kolkata. Request sequencing
and abort guards protect the breakdown from superseded responses. Prior values
retain their response date and client load timestamp.

Inspected backend/app/domains/api_usage/corrected_router.py llm_usage_breakdown:
authenticated current-user scope, _window_utc, persisted FX read, and persisted
job/provider-call/provider-snapshot reads. No refresh/execution/write was added.
Provider-ledger precedence, persisted-job attribution, calculations and permissions
are unchanged. Failed-read handling is confined to its own source; genuine zeros
in the separate provider table remain valid.

Limitation: direct API-owner confirmation of the exact retry contract is pending;
this executor has source evidence but no identified API-owner communication channel.
No owner confirmation is claimed. Original PDF pixels and authenticated live-shell
capture were not used; scope came from the coordinator's complete transcription.
The screenshots are isolated actual components, not a production-shell capture.
Keyboard activation and width checks are automated; focus persistence was inspected
in the unchanged component structure, not exhaustively tested in every transition.

## Saved evidence hashes

failed-1180.png SHA256:
2cdffd94ec72848fb84221452f784462456398336a92f5fede0686767a0365cd

verified-empty-1180.png SHA256:
b438ae2aea137846f2862b62d7fb227243a50474675526f22da45eca3660f963

Dependency setup initially failed because the default npm cache was outside the
writable workspace; npm ci using /tmp/state-api-npm-cache succeeded. This was a
local setup failure, not a test failure or publication denial.
