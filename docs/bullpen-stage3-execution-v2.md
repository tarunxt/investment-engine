# Bullpen Stage 3 Execution V2

## Overview

Stage 3 execution V2 moves live Bullpen order handling from one synchronous Auto-Live worker pass into a durable database-backed intent lifecycle.

Flow:

1. Stage 3 planning still produces decisions and `order_plan` payloads.
2. When `AUTO_LIVE_EXECUTION_V2_ENABLED=true`, the engine stops after planning and marks the run as `confirming`.
3. The backend persists `polymarket_auto_live_order_intents`, `polymarket_auto_live_order_attempts`, and `polymarket_auto_live_capital_reservations`.
4. Celery beat dispatches due executable order intents; one canonical periodic scheduler handles pending/reconcilable intents.
5. One Celery task owns one intent at a time through a token-owned operation lease, submits the external write, stores a sanitized attempt record, and schedules follow-up reconciliation.
6. Reconciliation updates the intent, the Stage 3 decision rows, and the run-level execution funnel until every intent reaches a terminal state.

The database is the source of truth for durable execution state. Celery only advances work that the database already describes.

## Queue Topology and Ownership

`execute_polymarket_auto_live_run` is routed to the dedicated `auto_live`
queue, consumed by `investor-celery-auto-live-worker`. Stage 3 intent execution,
retry, reconciliation, and coalesced audit refresh work remain on `ai`, while
beat schedules and dispatches run on `beat`. The production systemd topology is:

```text
auto_live -> investor-celery-auto-live-worker (planning; default concurrency 1)
ai        -> investor-celery-worker           (Stage 3 and general AI work; concurrency 1)
email     -> investor-celery-email-worker     (low-priority email; concurrency 1)
beat      -> investor-celery-beat-worker      (periodic dispatch/recovery)
```

Keep worker prefetch at one (`CELERY_WORKER_PREFETCH_MULTIPLIER=1`) so a
prefork child cannot reserve a hidden backlog of long reconciliation tasks.
Isolation is intentional: adding Auto-Live planning back to the `ai` consumer
would reintroduce queue starvation.

`ai` is mandatory and exclusive for `investor-celery-worker`. The no-Docker
launcher remains compatible with a legacy `CELERY_WORKER_QUEUES=ai,email`
environment value but intentionally filters it to `ai`; the dedicated email
unit consumes `email`. Both default to one child, so this separation reallocates
the former concurrency of two rather than adding same-host CPU load. The
dedicated `auto_live` worker remains planning only and must not be used as a
Stage 3 fallback.

When durable pending Stage 3 intents exist, `/health/ready` queries Celery
active queues. It returns HTTP `503` unless at least one worker reports
consuming `ai`; this intentionally makes the deployment `curl --fail` smoke
check fail instead of accepting an unavailable order-intent consumer. The
inspector uses the project's explicitly configured Redis-backed Celery app
rather than Celery's process-global default app. The async readiness deadline
is also longer than the inspector's reply window, so API-process import order,
normal thread scheduling, and result serialization cannot turn a healthy
consumer into a false timeout after a service restart.

After an `ai`-consumer outage, run the **Verify Bullpen Stage 3 Queue Recovery**
workflow with the affected run ID. It reports the primary worker status and
journal, executes `celery inspect active_queues`, checks readiness, and reads
the durable intent/attempt records without issuing another order. The verifier
rejects a still-unstarted intent and more than one persisted remote reference
for one intent.

At publish time a planning run records `QUEUED` and its Celery task ID. Broker
receipt records `RESERVED`; task execution records `STARTED` with a renewable
heartbeat and run-level execution lease. `QUEUED` and `RESERVED` are healthy
waiting states, not stale workflow failures. A redelivery is fenced by the
run-level lease and a PostgreSQL session advisory fence. Each Stage 3 intent
uses the same advisory-fence backstop while it submits or reconciles a remote
order. Redis must run with `maxmemory-policy noeviction`; the database fence
prevents split-brain work if a Redis lease is nevertheless lost. A worker-loss
decision requires expired heartbeat plus grace, complete negative worker and
advisory-fence evidence, no redelivery, and no terminal Celery result.
The two-hour workflow timeout remains a separate circuit breaker.

## State Machine

Intent states:

- `PLANNED`
- `READY`
- `RETRY_WAIT`
- `SUBMITTING`
- `SUBMITTED`
- `CONFIRMING`
- `PARTIALLY_FILLED`
- `SETTLEMENT_PENDING`
- `WAITING_FOR_COLLATERAL`
- `WAITING_FOR_EXIT`
- `CONFIRMED`
- `FILLED`
- `DEFERRED`
- `CANCELLED`
- `FAILED_PERMANENT`

Common transitions:

- `READY -> SUBMITTING -> SUBMITTED -> CONFIRMING -> CONFIRMED/FILLED`
- `READY -> SUBMITTING -> RETRY_WAIT`
- `READY -> WAITING_FOR_COLLATERAL -> READY`
- `SUBMITTING -> CONFIRMING` for ambiguous write outcomes
- `CONFIRMING -> PARTIALLY_FILLED -> FILLED`
- `READY/RETRY_WAIT/WAITING_FOR_COLLATERAL -> CANCELLED`
- `SUBMITTING/CONFIRMING -> DEFERRED` for safe non-terminal deferrals
- `SUBMITTING/CONFIRMING -> FAILED_PERMANENT` for hard validation or market failures

Run states:

- `running`: planning still in progress
- `confirming`: planning finished but at least one durable intent is still pending
- `completed`: all intents terminal-success
- `partial_success`: at least one terminal success and at least one terminal failure/defer
- `failed`: no terminal success and at least one hard terminal failure
- `skipped`: no execution due to a run-level skip condition

## Retry Matrix

Default classification:

- `RPC_RATE_LIMITED`: retryable, up to 6 attempts, honor `Retry-After` when present
- `HTTP_502` / `HTTP_503` / `HTTP_504`: retryable
- `NETWORK_TIMEOUT` / `CONNECTION_RESET`: retryable, ambiguous when the timeout/reset happens during write submission
- `AUTH_EXPIRED` / `SESSION_INVALID`: retryable
- `INSUFFICIENT_COLLATERAL`: retryable, transitions to `WAITING_FOR_COLLATERAL`
- `QUOTE_UNAVAILABLE` / `QUOTE_STALE`: retryable
- `MARKET_CLOSED`, `MARKET_RESOLVED`, `UNSUPPORTED_SIDE`, `INVALID_*`, `BELOW_MINIMUM_ORDER`, `NO_SHARES_AVAILABLE`: permanent
- `CONDITION_ID_UNAVAILABLE`: deferred without a write
- `AMBIGUOUS_SUBMISSION`: reconcile first, never blindly resubmit

Backoff:

- Base delay: `AUTO_LIVE_RETRY_BASE_DELAY_SECONDS` default `5`
- Max delay: `AUTO_LIVE_RETRY_MAX_DELAY_SECONDS` default `300`
- Jitter: stable hash-based full-jitter style delay

## Idempotency

- Every Stage 3 order uses the existing deterministic `order_plan.id` as the durable intent ID.
- Every durable intent stores a stable `idempotency_key`.
- The intent is persisted before any Bullpen write is attempted.
- Submission tasks lock the intent row with `FOR UPDATE SKIP LOCKED`.
- A token-owned Redis operation lease is acquired before enqueue and before task work,
  refreshed for long reconciliation, and released only by its owner. A dedicated
  PostgreSQL session advisory fence is held through the remote operation, covering
  an unexpected Redis eviction or failover. Together they cover periodic,
  immediate, operator, watchdog, restart, and redelivery paths.
- Duplicate Celery dispatch is safe because only one lease holder can reach the
  durable transition into `SUBMITTING`; the row lock and deterministic idempotency
  key remain a second, durable guard.

## Reservations

Buy intents reserve cash in `polymarket_auto_live_capital_reservations`.

- Reservation created when a buy is about to submit
- Reservation status `active` while waiting for terminal confirmation
- Reservation status `consumed` after terminal buy confirmation/fill
- Reservation status `released` after cancel, deferral, or permanent failure

Sizing guard:

- Fresh balance
- Minus active durable reservations
- Minus consumed BUY reservations whose fill is newer than that balance read
- Minus `AUTO_LIVE_BUY_BALANCE_BUFFER_USD` safety buffer

Reservation accounting is serialized for the host-global Bullpen credential
account with a PostgreSQL lock on one stable user row around the active
reservation sum and upsert. Reservations from every app user therefore share
the same collateral scope as the singleton CLI runtime. This prevents two
workers from each observing the same unreserved cash. Amount comparisons use
integer cents at the execution boundary. For example, with `$3.44` fresh cash
and the default `$1.00` buffer, two concurrent `$1.22` buys may reserve exactly
`$2.44`; the buffer remains unavailable to both workers.

The intent and latest attempt retain the identical
`buy_cash_reservation_preflight` v2 calculation. A missing balance timestamp,
an unseen concurrent consumed reservation, or insufficient unreserved cents
blocks locally before Bullpen receives an order.

The reservation preflight re-reads emergency-stop state, fresh balance,
existing active reservations, market identity, quote, minimum order, capacity,
duplicate exposure, intent generation, and remote-reference evidence. The
attempt row owns the sanitized preflight result before a Bullpen write. A
missing preflight proof is an audit finding only after an intent reaches a
remote-write boundary; a local attempt that failed before that boundary keeps
its explicit failed-preflight evidence.

The same locked transaction performs the authoritative cross-run market fence.
It matches all other durable BUYs by exact market ID, condition ID, or slug,
regardless of side. Pending writes and terminal intents with a remote order,
transaction, submission timestamp, uncertain-write marker, or active
reservation block the new BUY until reconciliation persists explicit,
quantity-known definitive zero fill. `TIMED_OUT` never implies zero fill. The
bounded `buy_market_exposure_preflight` result is mirrored on the owning attempt
before reservation; nonzero conflicts transition the candidate to a local,
non-retrying deferred block without issuing an external write.

## Stage 1 Portfolio Boundary

Stage 3 consumes only a Stage 1 wallet snapshot that explicitly records both
`wallet_snapshot_status=fresh` and
`wallet_snapshot_freshness_state=fresh`. Missing lineage is not interpreted as
fresh for legacy projections. Every positive-exposure wallet row with a stable
market identity receives exact current-market enrichment. Fresh authoritative
open-market evidence overrides stale raw resolved/redeemable hints. If exact
identity or open/closed state cannot be verified, the row remains
conservatively occupied, Stage 1 is degraded, and Stage 3 is blocked rather
than sizing a replacement buy from a possibly false free slot.

The small persisted console portfolio snapshot keeps active, claimable,
settlement-pending, and excluded rows in separate bounded collections. Only
`active` rows occupy Stage 3 slots. Claimable and diagnostic rows remain
visible without inflating the active-position count.

## Sell Preflight

Sell intents now run the same immediate live preflight boundary as buys:
current account identity, emergency stop, generation ownership, authoritative
market state, available shares, and existing remote evidence are checked
immediately before the write. A current authoritative `active`
classification wins over stale raw resolved/closed flags; a sell cannot be
silently suppressed by yesterday's wallet metadata. The finite primary,
maximum, and FAK fallback chain remains fail-closed after any accepted,
partially filled, ambiguous, or remotely referenced response.

## Reconciliation Rules

Buy reconciliation checks:

- Bullpen wallet positions
- Bullpen trade history
- Durable fill counters

Sell reconciliation checks:

- Share reduction or disappearance in wallet positions
- Bullpen sell history

Redeem reconciliation checks:

- Bullpen redeemed history
- Condition disappearance from wallet positions

If evidence is still inconclusive, the intent remains in `CONFIRMING` or `SETTLEMENT_PENDING` and schedules another reconciliation pass.

## RPC Provider Failover

Provider sources:

- `POLYGON_RPC_URLS`
- fallback to `POLYMARKET_POLYGON_RPC_URLS`

Execution attempts:

- provider aliases are stable synthetic names like `rpc-1`, `rpc-2`
- provider URLs are never surfaced through UI payloads
- each intent attempts providers in configured order
- `RPC_RATE_LIMITED` continues to the next provider before giving up the attempt

## API Additions

- `GET /polymarket/auto-live/runs/{run_id}/orders`
- `POST /polymarket/auto-live/runs/{run_id}/reconcile`
- `POST /polymarket/auto-live/orders/{intent_id}/retry`
- `POST /polymarket/auto-live/orders/{intent_id}/cancel`

## Environment Flags

- `BULLPEN_AUTO_LIVE_ALLOW_EXECUTION`
- `AUTO_LIVE_EXECUTION_V2_ENABLED`
- `AUTO_LIVE_EXECUTION_V2_SHADOW_ONLY`
- `AUTO_LIVE_RETRY_BASE_DELAY_SECONDS`
- `AUTO_LIVE_RETRY_MAX_DELAY_SECONDS`
- `AUTO_LIVE_BUY_BALANCE_BUFFER_USD`
- `CELERY_WORKER_PREFETCH_MULTIPLIER`
- `CELERY_AUTO_LIVE_WORKER_QUEUE`
- `CELERY_AUTO_LIVE_WORKER_CONCURRENCY`
- `CELERY_AUTO_LIVE_WORKER_PREFETCH_MULTIPLIER`
- `AUTO_LIVE_RUN_EXECUTION_LEASE_TTL_SECONDS`
- `AUTO_LIVE_RUN_HEARTBEAT_INTERVAL_SECONDS`
- `AUTO_LIVE_RUN_WORKER_LOSS_GRACE_SECONDS`
- `AUTO_LIVE_RUN_STARTUP_RECOVERY_GRACE_SECONDS`
- `AUTO_LIVE_ORDER_INTENT_OPERATION_LEASE_SECONDS`
- `AUTO_LIVE_ORDER_INTENT_OPERATION_ACTIVE_LEASE_SECONDS`
- `BULLPEN_RUN_AUDIT_REFRESH_DEBOUNCE_SECONDS`
- `BULLPEN_RUN_AUDIT_REFRESH_LEASE_SECONDS`
- `POLYGON_RPC_URLS`
- `POLYMARKET_POLYGON_RPC_URLS`

## Rollout

Recommended production rollout:

1. Deploy code and verify the existing order-intent Alembic revision is applied.
2. Keep `AUTO_LIVE_EXECUTION_V2_ENABLED` unset or set it to `true`; durable
   intents are now the default for live Stage 3 execution.
3. Optionally set `AUTO_LIVE_EXECUTION_V2_SHADOW_ONLY=true` and inspect queued intent payloads without live writes.
4. Disable `AUTO_LIVE_EXECUTION_V2_SHADOW_ONLY`.
5. Watch Stage 3 run funnels and intent retry/reconciliation behavior in the console.

Setting `AUTO_LIVE_EXECUTION_V2_ENABLED=false` is an explicit rollback lever;
the legacy path retains bounded in-process retries but cannot provide worker-safe
intent persistence before submission.

Stage 3 RPC writes use the saved settings `stage3_rpc_retry_attempts`,
`stage3_rpc_retry_initial_delay_seconds`, `stage3_rpc_retry_max_delay_seconds`,
and `stage3_rpc_retry_max_total_wait_seconds`. A Bullpen `Retry-After` response
is honored; otherwise the worker uses bounded exponential backoff with jitter.
Sell, redeem, buy, cancel, and retry writes pass through the shared authenticated
Bullpen runtime lock. The “Retry failed exits and continue buys” action resumes
the existing run and never recreates an intent with a remote order reference.

## Migration

Alembic revision:

- `t1u2v3w4x5y6_add_polymarket_auto_live_order_intents.py`

Tables added:

- `polymarket_auto_live_order_intents`
- `polymarket_auto_live_order_attempts`
- `polymarket_auto_live_capital_reservations`

Apply on the host deployment process before enabling V2:

```bash
cd /srv/investor/backend
alembic upgrade head
```

For local Docker development:

```bash
docker exec -it investor-backend-1 alembic upgrade head
```

## Recovery

Useful commands on the production host:

```bash
sudo systemctl status \
  investor-backend \
  investor-celery-worker \
  investor-celery-email-worker \
  investor-celery-auto-live-worker \
  investor-celery-beat \
  investor-celery-beat-worker \
  investor-frontend
sudo journalctl -u investor-celery-worker -n 200 --no-pager
sudo journalctl -u investor-celery-email-worker -n 100 --no-pager
sudo journalctl -u investor-celery-auto-live-worker -n 200 --no-pager
sudo journalctl -u investor-celery-beat -n 200 --no-pager
sudo journalctl -u investor-celery-beat-worker -n 200 --no-pager
```

If you change backend env flags:

```bash
sudo systemctl restart investor-backend
sudo systemctl restart investor-celery-worker
sudo systemctl restart investor-celery-email-worker
sudo systemctl restart investor-celery-auto-live-worker
sudo systemctl restart investor-celery-beat
sudo systemctl restart investor-celery-beat-worker
```

If you change frontend env or deploy frontend code:

```bash
sudo systemctl restart investor-frontend
```

## Known Limits

- Reconciliation currently uses Bullpen wallet positions and Bullpen history; it does not yet depend on a dedicated open-order API.
- RPC provider failover is applied per durable attempt, but Bullpen CLI capability still constrains how much of the underlying RPC state is externally observable.
- Cancel is intentionally limited to intents that have not yet been remotely submitted.
