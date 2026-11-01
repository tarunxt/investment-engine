# STATE-API-Usage-FailedVersusEmpty verification

Initial verification 2026-11-01 06:19 UTC; follow-up 2026-11-01 06:21 UTC against fetched origin/main and HEAD
`8212f9e93772a8f5a91f3f782640aeeff0fe7cc8`.

Outcome: the original failed-versus-empty rendering remains correct. Follow-up
focus-persistence testing reproduced one regression: native disabled Refresh lost
keyboard focus during loading. The smallest application change uses aria-disabled
and guards its existing click callback while loading. Styling, inputs and reads
remain unchanged. No merge or deployment.
Preceding Visual, Journey and Accessibility changes are preserved.

## Reproduction and results

From frontend:

```
node --test tests/api-usage-failed-versus-empty.test.mjs tests/api-read-fallbacks.test.mjs tests/api-errors.test.mjs
API_COST_SCREENSHOT_DIR=/workspace/investment-engine/artifacts/state-api-usage-verification node scripts/api-cost-provenance-playwright.mjs
```

Node: 12 passed, 0 failed, 0 skipped.
Final browser result: 1 expanded composite actual-component fixture passed,
0 failed, 0 skipped. The new focus assertion failed once before the fix and passed
afterward at both widths. The existing fixture now retains the regression checks.
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

Contract verified directly against repository handlers and their called functions;
no third party was contacted. The browser asserts every breakdown request is GET,
no-store, same-origin, period=custom with equal start/end dates. No provider refresh,
execution, scan or write endpoint is invoked by the breakdown Refresh.

Call-chain evidence:
- frontend/app/backend-api/[...path]/route.ts: GET delegates to
  proxyBackendRequest, which forwards request.method and search parameters with
  no GET body; existing bounded transport and authentication remain untouched.
- corrected_router.py:1078 llm_usage_breakdown calls _window_utc (router.py:170):
  IST midnight inclusive to next midnight exclusive, converted to UTC.
- fx_rates/service.py:64 load_persisted_usd_inr_rate performs a SELECT for the
  latest verified stored FX rate; it never downloads or refreshes a rate.
- corrected_router.py:549 _load_usage_sources calls _load_usage_rows (:212),
  _load_provider_call_rows (:379), _load_provider_snapshot_rows (:456).
  These execute SQLAlchemy SELECTs for persisted jobs/run metadata, audit subcalls,
  Auto-Live run records, provider call records and daily snapshots, with user/date
  filters. No job execution, provider adapter, enqueue or persistence write.
- _run_breakdown_rows (:739), _aggregate_usage (:786), _aggregate_run_items (:882)
  reconcile and aggregate in memory. Provider ledger precedence is preserved.
- infrastructure/database/session.py:54 get_async_db only yields a session.
  auth/dependencies.py:50 authenticates active users with a SELECT. Existing
  auth-disabled/development bypass can create a dev user; this is not enabled or
  exercised here, and is not a new write introduced by retry.

Focus checks now automate date input focus after initial failure, Refresh focus
while loading and after populated recovery, stale failure and empty recovery,
and edited date value/focus after date-triggered completion. Repeated Enter/Space
while loading produces no duplicate request. Runs pass at both widths.

Limitations: authenticated production-shell capture is not tested here; the parent
handles safe live QA. Original PDF pixels were not used; scope came from the
coordinator's complete transcription. Screenshots are isolated actual components.

## Saved evidence hashes

failed-1180.png SHA256:
53958fddef28ef758ad9a361ae6d3e7ec6112bc9d6c1e350e057e4031504abbe

verified-empty-1180.png SHA256:
8b407032abd5dc8268473a487143adf9eb3da8526a1bb8da4b76af7bea64ad86

Dependency setup initially failed because the default npm cache was outside the
writable workspace; npm ci using /tmp/state-api-npm-cache succeeded. This was a
local setup failure, not a test failure or publication denial.

Scoped ESLint, TypeScript no-emit, and git diff --check pass. An initial ESLint
invocation from repository root could not locate the frontend config; rerunning
from frontend succeeded. focus-recovered-1180.png was reopened and read back: the
keyboard focus outline remains on Refresh after confirmed-empty recovery.
