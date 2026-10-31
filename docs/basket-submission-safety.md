# Cred-X Basket submission safety

The basket and its submission callback use the same affordability check: selected
BUY amounts plus the existing max(₹50, 1%) buffer must fit saved available margin
plus estimated selected SELL proceeds. Unknown margin or amounts block buys.
SELL-only baskets remain valid without margin. Sell-first sequencing and the
backend's refreshed-margin affordability check remain authoritative.

Before calling the protected MARKET service, the browser persists an account-scoped
attempt record. A Web Lock serializes admission across tabs of the same origin.
Missing browser locking/storage fails closed. Submission-in-progress and quote
refresh are also checked in the parent, not only on the button.

A response clears the record only when counts and identities are consistent, every reviewed unit is accounted for, and every placed order has a unique nonempty broker ID. Failed rows, missing receipts, omitted results and unresolved partial quantities retain the lock. Explicit fully-accounted reductions/skips remain valid. Returned placed rows
are deselected. HTTP 401/403/422 rejects before this endpoint's execution are
retryable. Timeout, network failure, unexpected responses, 5xx and failed broker
rows retain the lock: neither a timeout nor a failed response proves cancellation.
Persisted records contain only timestamp and state; legacy listing details are removed on hydration. The lock survives closing/reopening the dialog, remount, reload and another tab
for the same user. Another user's record is isolated.

## Recovery limitation and release review

The current endpoint has no durable client request identifier/idempotency receipt,
and the order book cannot unambiguously correlate unknown attempts. This change
intentionally provides no automatic reset or user override of an uncertain record.
The operator must reconcile the attempt; adding a trustworthy recovery action
requires durable request correlation and is a separate integration decision. A
same-symbol/side/quantity match or an empty order book is not sufficient evidence
that a request cannot still execute. Do not describe this browser guard as backend
idempotency or protection across devices or cleared browser storage. Root must
review this recovery limitation before release.

## Offline verification

- `node --test tests/basket-*.test.mjs tests/zerodha-*.test.mjs`
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node scripts/basket-submission-safety-playwright.mjs`
- `node --test tests/bounded-api-transport.test.mjs`
- `python backend/scripts/verify-basket-preexecution-offline.py` (from repository root)
- `npx tsc --noEmit`

The browser fixture mounts the production basket and actual production submission
callback in a controlled stateful parent. It does not mount the entire dashboard.
Stock drilldown children are stubbed, the market is explicitly open, and every
service is an in-memory mock. An origin allowlist blocks external browser requests.
The mock distinguishes timeout before dispatch from dispatch followed by a lost
response; the application must conservatively lock both when transport cannot
prove whether dispatch occurred. Tests cover budget rejection, missing/old prices,
Add More/Buy More, accessible blocker descriptions, close/reopen, reload,
definitive rejection and resolved skipped responses. No live orders are submitted.

The pre-execution Python verifier runs AST-extracted production authentication,
request schemas and the sequenced endpoint through an in-memory FastAPI ASGI app.
It fakes database/JWT/service boundaries and forbids sockets/DNS. It proves 401,
403 and 422 rejection paths make no placement calls, without importing application
startup or connecting services; it is not the complete backend integration suite.
The BFF transport test verifies these rejections stay authoritative, with at most
one same-origin authentication refresh and no mutation transport fallback.
The browser suite also exercises simultaneous admission from two pages using
real Web Locks and shared localStorage; only one mock dispatch is admitted.
