# Automated Rebalance spending admission

Policy: ₹20 for the Zerodha workflow and ₹20 for the INDmoney workflow (₹40
combined). All tagged paid stages, repairs, tools and retries use their market's
same durable allowance. A new workflow sequence is a continuation, not a fresh
grant. No browser state, request header, estimate or model multiplier can reset
the account. This change contains no grant/reset/billing-configuration endpoint.
After exhaustion a separately authorized allowance lifecycle would be needed;
the current application does not silently renew it, even after completion.

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
automated Rebalance job. The error appears through the existing stage/job failure
UI and is terminal rather than an automatic retry. No paid certification probe is
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
telemetry's optional/fail-open lineage. A scope is created once per owner/market;
each sequence binds to it. `ApiAttempt.__enter__` enforces admission for all
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
or notification requests are made. No new UI controls need browser fixtures: the
existing error renderer receives the explicit cap denial without a new flow.
