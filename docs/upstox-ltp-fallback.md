# Read-only Upstox LTP fallback

The authenticated `GET /zerodha/portfolio/quotes` endpoint keeps every valid Kite
price and reads Upstox independently for the full exact-venue batch. Only missing
Kite prices use Upstox in the selected quote list. The additive `upstox_quotes`
response field powers the separate Upstox LTP column immediately left of Quoted
LTP, including listings where Kite already supplies a valid price. Kite permission,
authentication, rate-limit and transport failures can also trigger the fallback.
Kite holdings, orders and credential handling are unchanged. This integration
does not place orders or change basket preparation or execution price guards.

## Secure configuration (not performed by this change)

After explicit operator approval and loading the repository-required
`aws-secrets-manager` skill, inject these backend runtime environment variables
using its approved secret mechanism:

- `UPSTOX_ANALYTICS_TOKEN`: the existing account's sensitive read-only token.
- `UPSTOX_LTP_OWNER_USER_ID`: the verified Cred-X user ID owning that token.

The canonical systemd configuration target is `/etc/investor/backend.env`, but
this does not authorize writing a raw token into that file. Follow the required
skill's Secrets Manager dynamic-reference and `asm-exec` instructions for runtime
resolution; verify the actual launcher before changing it. The official skill
and wrapper were read at immutable aws/agent-toolkit-for-aws commit
`9d76dd4494b7ff76105f52f5d59ae2180dc91289`. Resolution supports either SMA or
SigV4-signed AWS MCP; an AWS connector is not itself required. No wrapper was
installed or run in this task. Current production launcher, reachable resolution
backend, identity permission, actual secret identity/region and secure token
ingestion still require verification and separate approval. Historical UAT
wrapper availability does not establish production readiness.

Do not put the token in frontend configuration, source control, tickets, command
arguments, or logs. Missing configuration disables this fallback. Other users
cannot use the configured owner's token. For containers, inject the same names
through the deployment's secret environment mechanism. No database migration is
needed. The repository's AWS secret skill requirement still applies to actual
credential handling; this code change does not retrieve or configure secrets.

Release the reviewed change using the approved repository release workflow, then
apply approved configuration through the secure operator mechanism and restart
`investor-backend`. Verify a small read-only request as the configured owner and
check provenance and missing instruments. Verify another user cannot access the
fallback. Never expose the token in the verification output. Unset the two names
and restart the backend to disable the integration.

## Mapping, freshness and failures

The official public complete instrument master maps exact exchange and trading
symbol to Upstox instrument keys. Only NSE/BSE equity segments with valid ISIN
keys are included. Ambiguous or absent listings stay missing; no company-name or
cross-exchange match is attempted. The public mapping is cached for six hours
per process. An expired mapping must refresh successfully; there is no stale
mapping fallback. Authenticated display quotes use the bounded owner-scoped shared cache described below; they are never shared across users.

The implementation uses `GET /v2/market-quote/quotes` rather than LTP V3 because
the full quote response includes `last_trade_time`. A positive finite last price
is returned only with a valid non-future exchange trade timestamp. `as_of` is
the trade time, never HTTP receipt time. `source` identifies Upstox, exact venue,
trade age, retrieval time and display-only status. Trades older than 120 seconds
are explicitly labelled older last trades, potentially reflecting closed markets
or illiquidity. They remain available for overnight display sizing. No market-open
claim is inferred from age. Receipt time never makes an old trade fresh.

The display quote reader feeds derived display calculations only; it does not
mutate the executable `orders` collection. Technical validation also consumes this
route and continues to reject anchors older than its existing 15-minute limit.
Order preparation, protected orders and automated execution read Kite directly;
none call the Upstox provider or this display quote orchestration. Upstox LTPs
are not execution quotes and cannot satisfy those broker-side price guards.

One bounded quote batch follows the public mapping read. Each HTTP operation
times out after six seconds; the whole Upstox attempt has a 15-second deadline.
No retries or automatic token refresh occur. Auth/entitlement errors, rate limits,
timeouts, malformed responses and missing symbols preserve the missing list.
If Kite failed and Upstox supplies no prices, the existing safe Kite error is
preserved. If Upstox supplies a partial batch, valid prices and remaining missing
listings are returned. The existing labelled limit-price estimate remains in the
frontend; estimates are never fabricated by this endpoint.

## Official references checked 30 October 2026

- https://upstox.com/developer/api-documentation/analytics-token/
- https://upstox.com/developer/api-documentation/ltp-v3/
- https://upstox.com/developer/api-documentation/get-full-market-quote/
- https://upstox.com/developer/api-documentation/instruments/

Analytics Tokens are free, read-only, valid for one year and limited to one per
account. Market quote GET APIs need no static IP; account/private API categories
can require a whitelisted IP. Actual account entitlement and quote access still
require live verification after approved secure configuration.

### Shared request construction and manual diagnostic

Production and `backend/scripts/diagnose_upstox_quote.py` use the same
`build_quote_request` function and normal httpx transport, including GET, encoded
`instrument_key`, Bearer authorization, `Accept: application/json`, and the
`Content-Type: application/json` header shown in Upstox's official full-quote
example. No User-Agent override, proxy override, redirect following or retry is
introduced. Adding Content-Type aligns with the example; it does not establish a
fix for the previously observed browser-signature 403.

The diagnostic is import-safe and never runs automatically. A separately
approved live call may invoke it as a module with `PYTHONPATH=backend` and an
explicit `--instrument-key`, through the mandatory approved secret resolver; do
not pass a token on the command line or print raw HTTP responses. It retains at
most 8192 response bytes in process, outputs only sanitized status/error and
request-ID information, and makes one request. It must not be used to evade a
provider access block. Request-contract tests use only dummy credentials and
mocked transports. This change neither activates Upstox nor changes deployed
credentials, account scope, UI, or executable orders.

## Shared quote protection (31 October 2026)

The full-quote adapter uses existing `REDIS_URL` infrastructure, shared by all
production backend processes. Atomic Redis Lua sliding windows reserve a request
**before** dispatch: at most **20/second, 200/minute, 1,000/30 minutes** for this
owner/API. Failed, cancelled and uncertain requests consume their reservation.
No local fallback is allowed if Redis or coordination fails. The owner is
opaque-hashed in Redis key names; credential rotation isolates caches without
resetting the account budget. Exact venue and sorted instrument set scope each
cache/coalescing lock; another owner's cache cannot be served.

For unknown history on first use or Redis history loss, provider requests are
suppressed for **30 minutes** to cover the unknown preceding quota window. This
warm-up begins on the first quote request after release, not on deploy. If only
the reservation set disappears while recent history remains, the remaining
30-minute window is also suppressed. Counters record `history_warmup`. Normal
backend restarts do not clear Redis coordination. Do not flush these keys to
accelerate activation. Redis durability/eviction and all app processes using the
same Redis database remain operational requirements.

Successful normalized display quotes cache for **five seconds**, including
partial results; empty/failed results cache for **two seconds** to damp duplicate
proxy requests. An identical in-flight batch has one distributed leader, with a
20-second lease exceeding its 15-second HTTP deadline. Followers wait up to
800ms then report unavailable, never dispatch a duplicate. Real exchange `as_of`
and original retrieval source text are retained; cache hits are explicitly
labelled cached display quotes. No cache value qualifies as an execution quote.

HTTP 429 applies an account/API-wide cooldown for at least 60 seconds, honoring
longer numeric or HTTP-date `Retry-After`. A later shorter backoff cannot shorten
an active cooldown. No automatic provider retry occurs. Quota or cooldown blocks
return no fabricated quote; existing Kite-first fallback/missing-price behavior
remains. Other selected failures receive only the two-second negative cache.

Fixed-field cumulative counters live at the account's opaque Redis namespace
`upstox:full-quotes:v1:<sha256-owner>:counters`: `admitted`, `quota_blocked`,
`backoff_blocked`, `history_warmup`, `cache_hit`, `coalesced`,
`coalesced_unavailable`, `provider_429`, `provider_failure`, `invalid_response`,
`empty_response`, `unmapped`, `success`. They record reservations/results, not
billable usage, and disappear if Redis state is lost. Sanitized warning events
contain neither identities nor token/connection/response values. Read these
counters through existing authorized operations tooling; no public metrics
endpoint or new credentials are introduced.

The UI has no periodic quote polling: open/reopen/reload, snapshot changes and
explicit Refresh/Retry start cycles. It batches 50 instruments (up to 500 total),
so 13 mapped instruments normally produce one admitted full-quote read. The
separate public master mapping download keeps its existing six-hour process
cache. Other independent apps/manual diagnostics using the same Upstox account
are outside this limiter; the reserved headroom cannot guarantee their traffic
is below account-wide limits. Official standard REST limits are 50/second,
500/minute and 2,000/30 minutes per API/user; quote classification under standard
APIs is inferred from the docs. Full quotes accepts 500 instruments/request:
https://upstox.com/developer/api-documentation/rate-limiting/
https://upstox.com/developer/api-documentation/get-full-market-quote/
