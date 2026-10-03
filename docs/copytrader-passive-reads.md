# CopyTrader passive display reads

## Scope

`GET /polymarket/state` and `GET /polymarket/history` project existing user-owned
evidence. They do not call the operational manager's `get_bot()` or `bot.init()`.
They cannot initialize balance, startup/doctor, net-worth, forced redeem/claim or
trading workers, auto-start a bot, repair a poller, seed a file, change a setting,
refresh a provider, submit an order or claim funds.

The CopyTrader page's mount and polling effects call only the state GET. Doctor
and balance refreshes remain explicit controls. The existing browser-local EC2
command-shortcut preference effect is unchanged; it is unrelated to bot/runtime
settings and does not call a backend/provider.

Explicit operational paths retain their existing manager, initialization and
execution behavior. The state builder's operational default still permits its
existing poller restoration; display callers explicitly disable that behavior.
No forced-redeem loop condition, execution guard, sizing or financial policy was
changed. In particular, the existing forced redeem/claim worker's treatment of
paused/stopped state is a separate financial-policy concern, not repaired here.

## Evidence and compatibility

- Existing state/history fields and authenticated per-user ownership are
  retained. Additive `read_source` and `read_message` explain provenance.
- A same-user, same-event-loop warm runtime is read under its existing lock.
  Full-history projection runs outside the event loop and is deeply detached
  before releasing that lock. Simultaneous reads coalesce onto one projection.
  Every reader receives its own deep copy, made in the executor, so changing a
  response cannot modify another reader or the private cached snapshot. This
  isolation also applies to coalesced cold state/history responses.
  Request cancellation leaves the lock held until that projection finishes.
- Lock acquisition is capped at 250 ms. A busy state read returns the last
  coherent captured snapshot with its original timestamp and a stale message;
  without one, it returns HTTP 503. A busy explicit history read returns 503.
  Neither path writes a timeout warning to bot logs.
- A cold process reads the existing per-user JSON files using inert dependencies
  and never registers a bot. Persisted config is respected, including auto-start
  and paused values, but is not acted on. Runtime, doctor, discovery, wallet
  balance and redeemed-wallet history are explicitly unavailable. Balance
  amounts remain null. The UI labels runtime status unavailable instead of
  claiming the bot stopped. Runtime, execution, doctor, lock, discovery, wallet
  and polling sections show unavailable values rather than default zeroes or
  failed/locked states. Claim eligibility and redeemed-wallet status remain
  unknown; saved trade history is retained and labelled as saved evidence.
- A new user with no saved evidence gets an explicitly unavailable projection,
  preserving access to setup and explicit controls without creating files.
  Empty saved-history lists in that response do not represent a verified empty
  wallet or a verified stopped runtime.
- For existing evidence, missing, corrupt, non-list, invalid-record, non-regular
  or oversized required files fail explicitly with HTTP 503. They are not
  silently replaced by successful zero metrics. Files and historical records
  are not rewritten or deleted.
- All accepted paper/live history participates in the existing aggregates and
  position formulas. Only the final state rows (50) and requested history rows
  (up to 200) are sliced, preserving the prior response limits. This is not a
  historical backfill or a new pagination API.

Cold reads have one shared **8 MiB aggregate source-byte budget** across every
file used by the request. State includes both histories, tracked accounts and
optional saved config; history includes both history files. Combined sizes are
checked before any JSON decoding. Every actual read also consumes the shared
remaining budget, detecting growth between preflight and reading. Oversized
combined evidence returns 503 before heavy parsing, without truncating history.

Cold JSON decoding/validation and cold/state projection aggregates and response
copies run in the executor. Warm history constructs and detaches its response
under the bot lock, bounded to 200 rows per history category.
Identical in-flight reads are coalesced; only **one distinct cold projection** is
admitted per manager. Other reads return an explicit busy 503. Cancellation does
not release admission until the underlying projection completes. These bounds
limit raw input and concurrent decoding, not expanded Python heap, process RSS,
CPU time or HTTP response size. They are reviewable availability tradeoffs, not
evidence of production file sizes or proof of a live timeout root cause. Final
operational sizing still needs authorized production evidence. There is no new
hard deadline for filesystem I/O or aggregate CPU work; existing HTTP transport
deadlines still apply. Warm history size is not silently capped, and large
position/pending-confirmation lists retain existing semantics.

## Bot Overview

The summary/overview endpoints call the CopyTrader passive reader and the
existing Auto-Live `get_dashboard_summary()` projection. They never initialize
CopyTrader or Direct, and they never enter Auto-Live's operational legacy
`get_summary()` reconciliation/scheduling path. Direct has no safe passive
projection here, so its card is explicitly unavailable with unknown execution
mode and null metrics. CopyTrader persisted/unavailable responses receive the
same treatment in overview cards; their full saved evidence remains on the
CopyTrader page.

The overview's automatic Direct state fallback and Bullpen AI positions
fallback are removed because they can initialize a runtime or enrich data from
providers. The remaining automatic requests are summary, passive CopyTrader
state and passive Auto-Live dashboard summary. Bullpen AI's unavailable metrics
stay visible as a placeholder. Unavailable cards are not counted as stopped,
and cold defaults do not produce doctor-failed or armed/locked claims. The
overview cache namespace changes so older operationally derived cards are not
reused by this bundle. Explicit operational controls are unchanged.

This boundary does not certify every legacy route as passive: the dedicated
Direct console, runtime diagnostics/discovery endpoints, and the Bullpen AI
positions wrapper outside this overview retain their prior behavior. The
positions wrapper can still enrich cached data using external market lookups.
No production request to those paths was used to validate this patch.

## Runtime cache boundary

`GET /polymarket/runtime/health` uses `strict_read_only=True`.
`/runtime/positions` and `/runtime/positions/display` requests explicitly marked
`passive=true` use existing caches with `delete_invalid=False` and return
immediately from those caches. They do not use `get_positions_snapshot()`, wait
for a refresh, repair invalid Redis data, run the CLI, or fetch a requested
wallet from a provider. Freshness is computed from the saved fetch timestamp;
stale evidence is retained in `stale_snapshot`. A requested wallet mismatch
returns unavailable rather than another account's evidence. The existing
operational calls with `passive=false` retain their behavior and access checks.

The Bullpen Runs Audit synchronization contract was reviewed. This change is a
display/read boundary and adds no Stage 1–3 input, formula, decision, execution
or frozen audit-evidence change. Existing audit schemas and historical frozen
snapshots remain unchanged.

## Offline verification

All fixtures are synthetic. No production API, browser, credentials, wallet,
paid model, trade, claim or deployment is used for verification.

```sh
PYTHONPATH=backend PYTHONDONTWRITEBYTECODE=1 python -m pytest \
  backend/tests/test_polymarket_passive_reads.py \
  backend/tests/test_polymarket_runtime_router.py \
  backend/tests/test_bullpen_passive_healthcheck.py -q -p no:cacheprovider
cd frontend
node --test tests/polymarket-bot-passive-read.test.mjs tests/polymarket-bot-ec2-commands.test.mjs
node node_modules/eslint/bin/eslint.js app/console/polymarket-bot/page.tsx
```

Adversarial tests deny task creation, subprocesses, network connection attempts
and filesystem writes during reads. Coverage includes cold/warm state and
history, absent evidence versus corruption, auto-start enabled but unactivated,
5,000 synthetic history records with an early realized gain outside the visible
tail, cross-user/loop isolation, account mismatch, stale cache evidence,
concurrent runtime and response mutation, lock contention, request cancellation,
coalescing, aggregate preflight rejection, actual-byte accounting after file
growth, and resource admission. Frontend tests execute mount/polling with an API
write trap, render both cold read sources on main/settings screens, and verify
unavailable runtime sections and reachable explicit controls.

## Combined patch validation

Against the combined local patch, the required backend suite passed 726 tests,
the required frontend suite passed 242 tests, and deployment contract tests
passed 67 tests. Backend compilation, frontend ESLint and TypeScript checking
passed. The TypeScript check was rerun alone after a parallel run was killed by
the local environment. Independent review additionally exercised 78 targeted
backend and 15 targeted frontend tests. These counts overlap the required
suites; they are not additive.

No production endpoint, paid model run, transaction, infrastructure mutation or
deployment was used for this validation. Frontend production builds and remote
CI remain release-stage checks. The previous live release is unaffected by
this local patch until it is separately published and deployed.
