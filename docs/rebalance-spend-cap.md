# Automated Rebalance spending admission

Policy: ₹20 per **separately authorized logical Zerodha workflow** and ₹20 per
separately authorized logical INDmoney workflow (₹40 for the pair). This is not a
lifetime owner/market allowance. Paid stages, repairs, tools, retries and explicitly
linked continuation sequences consume that logical workflow's same scope.

The existing authenticated `POST /runs/auto-rebalance-label` accepts:

- `spend_intent: new_workflow` plus a stable `spend_request_id` UUID: explicit
  authorization for a genuinely separate operation and its own20INR scope.
- `spend_intent: continue_workflow`, a new stable request UUID and the existing
  `spend_scope_id`: another sequence sharing the original allowance.

Repeated authorization UUIDs return the original scope/sequence. Reusing a UUID
for a different market/intent, resetting a bound sequence, or continuing a foreign
owner/market scope is rejected. Workers cannot mint grants. No reset or billing
settings route was added. This is a consent contract on the existing Run boundary;
a new sequence or retry by itself never authorizes fresh spending.

The native Run boundary now offers explicit New versus Continue choices. It reads
owned scopes and a server revision from `GET /runs/auto-rebalance-spend-readiness`;
that endpoint neither grants spending nor probes providers. Each request includes
`spend_observed_revision`. Under the owner lock, a stale selection cannot create
a second grant. UUID replay is evaluated first and recovers the original scope.
`reservation_created` is true only on the first label creation; false means
reconcile only, never restart that sequence.

The browser persists a pending request UUID in owner/market-scoped localStorage
before calling the label endpoint. Web Locks serialize tabs; the backend revision
check is authoritative across tabs/sessions. Storage or locking failure stops
before authorization. Reload/navigation do not run stages. An uncertain start is
resolved using the original request ID and **never** starts stages, even if the
first request did not reach the server. The user then reviews history and selects
Continue with the original scope and only remaining stages. This conservatively
allows an unused authorization to be recovered without risking duplicate jobs.
No selection defaults to New, and each consumed selection must be chosen again.
Historical operations without scopes receive no retroactive allowance.

Current readiness explicitly says no live adapter has certified billing bounds.
New/Continue selection is disabled and Run explains why it cannot start. Resolving
a pending authorization is still available without starting stages. Saved evidence
and standalone Sync Now remain usable. No client-generated INR amount is trusted.

The ledger uses PostgreSQL row locks and exact Decimal INR amounts. It reserves
the verified all-in request upper bound and commits **before** external I/O.
Provider dispatches fail closed on a missing schema/database, identity, pricing,
FX/fees or request bound. ₹0, characters/4 and expected output lengths are not
bounds. Each nested call gets a job/retry/ordinal identity; redelivery cannot
repeat an admitted ambiguous request. Settlement locks scope then attempt in the
same order as admission. An exception, cancelled stream, missing receipt or
unknown charge retains its reservation and suspends further dispatch. Recorded
actual charges are never clamped; a bound breach freezes the scope.

## Supported provider feasibility

**No live adapter is currently certified for admission.** DeepSeek, OpenAI,
Anthropic, Gemini, Tavily and unrecognized adapters stop before paid I/O for an
automated Rebalance job. For an explicitly authorized scope, the adapter error appears through the existing
stage/job failure UI and is terminal rather than an automatic retry. The native
Run boundary explains adapter unavailability before authorization or sync; legacy
clients without consent fields receive an explicit422. No paid certification probe is
performed. This is intentionally fail-closed, not a promise that today's six-stage
workflow can complete for ₹20.

To enable an adapter in future, its `resolve_bound` policy must establish all
billable input/output/reasoning/tool/request-retry ceilings, verified current
tariffs and an all-in INR FX/fee upper bound for that exact request. Hidden SDK
retries must be disabled or included. Settlement needs confirmed billing evidence;
telemetry tariff estimates cannot free reservations. The resolver is code, not a
frontend amount or unreviewed configuration override. Production has no enabled
policy or route that can supply a forged bound.

Atomic admission guarantees only that admitted, verified **request bounds** fit
the allowance. If an upstream provider violates a bound or external conversion
fees exceed a supposed ceiling, application code cannot undo the invoice. Such
an adapter cannot honestly claim an all-in external invoice guarantee and must
remain blocked. A budget stop can leave earlier stages completed; it must never
be described as complete Final Actionables.

## Scope and integration

The worker derives identity from persisted automated workflow metadata, not usage
telemetry's optional/fail-open lineage. A scope is created only at explicit new-workflow authorization;
continuation sequences bind to that same scope. `ApiAttempt.__enter__` enforces admission for all
instrumented model/search calls in that worker context, including streamed Gemini
calls. Unrelated untagged jobs retain their existing behavior. This is a workflow
cap, not a global cap for every standalone account API operation.

Historical jobs and snapshots are not backfilled or rewritten. A newly dispatched
tagged job, including one from an older workflow, is gated. Existing terminal jobs
are skipped as before. Portfolio formulas, order handlers, recovery HTTP/task
allowlists, exports/mail containment, credentials and application settings are
unchanged. Enforcing the cap adds database tables but no new security exception.
Apply the supplied Alembic migration through the normal authorized deployment
process; no production migration was executed during local implementation.

## Offline verification

`python -m pytest -q tests/rebalance_budget` uses synthetic SQLite tables for
deterministic arithmetic, identity, mocked provider boundaries and settlement.
Real concurrency is tested only with an explicitly acknowledged disposable local
PostgreSQL database:

```
CREDX_CAP_TEST_DATABASE_URL=postgresql://localhost:55439/credx_cap_test_local \
CREDX_CAP_TEST_DATABASE_ACK=disposable-local-only \
python -m pytest -q tests/rebalance_budget
```

The test target is never taken from application `DATABASE_URL`. Every PostgreSQL
test gets a random schema, which it alone creates/drops. Remote hosts, arbitrary
database names, query overrides and missing acknowledgement are rejected. All
provider calls are functions returning synthetic evidence; no model/search/order
or notification requests are made. The real React consent component and actual
client authorization lifecycle run in an isolated Chromium fixture, with only a
local synthetic HTTP API reachable. It covers explicit consent, New, Continue,
double click, navigation/reload, uncertain response before/after dispatch,
concurrent tabs, missing Web Locks and unknown-adapter explanation. Run with:

```
cd frontend
node scripts/rebalance-spend-consent-offline-playwright.mjs
```

`CAP_TEST_NODE_MODULES` and `CAP_TEST_PLAYWRIGHT_PACKAGE` may select already
installed local tooling when repository dependencies are unavailable.

## Exact operational impact

- `/runs/auto-rebalance-label` without explicit authorization fields now fails422.
  Native Run supplies explicit consent; legacy callers see a clear failure before scans queue.
- Jobs submitted through `POST /runs` with automated Rebalance metadata, and
  `POST /zerodha/threats/run` or `/indmoney-us/threats/run` with that metadata,
  are gated in `execute_ai_job`. Missing scope bindings and all currently
  uncertified live adapters stop before provider I/O. Any other task routed through
  that worker with automated metadata is treated the same way, including a tagged
  event analysis. Subcalls inherit the context.
- Ordinary `POST /jobs`, untagged `POST /runs`, and standalone Threats/Event scans
  with all automated metadata absent retain existing behavior. This is **not** an
  account-wide API-spending cap. Deliberately running unrelated standalone jobs is
  outside a whole-workflow allowance.
- Existing saved history/results, terminal job redelivery, portfolio reads/sync,
  orders and independent bot execution paths are not newly disabled by this patch.
  Recovery containment still independently decides what production may execute.

No live adapter is enabled: with the consent UI integrated, the selected
DeepSeek workflow will remain unavailable under strict enforcement until reliable
billing bounds are certified. Do not deploy this as a transparent, usable cap
feature or imply that a planning estimate can bypass this release blocker.


## F08 integration boundary (separate owner)

This branch does not implement per-run email/export policy. At the inspected base,
`buildRunPayload` still derives `auto_export_enabled` from `sheetName`, and the
completion path can call `queueAutoRebalanceCompletionEmail`. Recovery containment
remains independent. Spend consent authorizes an allowance only; it is not consent
to mail, export, orders or settings changes.

The F08 worker must preserve spend fields when extending the existing label body
and response. Freeze side-effect choices on the server-owned workflow when its
label/binding is created; UUID replay must return the original frozen policy and
must not overwrite it. Continuation shares `spend_scope_id`, while its permitted
side-effect policy must follow F08's explicit continuation rules. No inference
from a new sequence, spend amount, or New choice may enable mail/export. Integrate
at `reserveAutoRebalanceRunMetadata`, `buildRunPayload` and completion notification
handoff; keep backend enforcement at export/mail boundaries. This cap branch does
not modify those flags or their existing containment.
