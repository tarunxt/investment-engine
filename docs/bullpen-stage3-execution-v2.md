# Bullpen Stage 3 Execution V2

## Overview

Stage 3 execution V2 moves live Bullpen order handling from one synchronous Auto-Live worker pass into a durable database-backed intent lifecycle.

Flow:

1. Stage 3 planning still produces decisions and `order_plan` payloads.
2. When `AUTO_LIVE_EXECUTION_V2_ENABLED=true`, the engine stops after planning and marks the run as `confirming`.
3. The backend persists `polymarket_auto_live_order_intents`, `polymarket_auto_live_order_attempts`, and `polymarket_auto_live_capital_reservations`.
4. Celery beat dispatches due order intents.
5. One Celery task owns one intent at a time, submits the external write, stores a sanitized attempt record, and schedules follow-up reconciliation.
6. Reconciliation updates the intent, the Stage 3 decision rows, and the run-level execution funnel until every intent reaches a terminal state.

The database is the source of truth for durable execution state. Celery only advances work that the database already describes.

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
- Duplicate Celery dispatch is safe because only one worker can move an intent from an executable state into `SUBMITTING`.

## Reservations

Buy intents reserve cash in `polymarket_auto_live_capital_reservations`.

- Reservation created when a buy is about to submit
- Reservation status `active` while waiting for terminal confirmation
- Reservation status `consumed` after terminal buy confirmation/fill
- Reservation status `released` after cancel, deferral, or permanent failure

Sizing guard:

- Fresh balance
- Minus active durable reservations
- Minus `AUTO_LIVE_BUY_BALANCE_BUFFER_USD` safety buffer

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
- `POLYGON_RPC_URLS`
- `POLYMARKET_POLYGON_RPC_URLS`

## Rollout

Recommended production rollout:

1. Deploy code and Alembic migration.
2. Leave `AUTO_LIVE_EXECUTION_V2_ENABLED=false`.
3. Optionally set `AUTO_LIVE_EXECUTION_V2_SHADOW_ONLY=true` and inspect queued intent payloads without live writes.
4. Enable `AUTO_LIVE_EXECUTION_V2_ENABLED=true`.
5. Disable `AUTO_LIVE_EXECUTION_V2_SHADOW_ONLY`.
6. Watch Stage 3 run funnels and intent retry/reconciliation behavior in the console.

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
sudo systemctl status investor-backend investor-celery-worker investor-celery-beat investor-frontend
sudo journalctl -u investor-celery-worker -n 200 --no-pager
sudo journalctl -u investor-celery-beat -n 200 --no-pager
```

If you change backend env flags:

```bash
sudo systemctl restart investor-backend
sudo systemctl restart investor-celery-worker
sudo systemctl restart investor-celery-beat
```

If you change frontend env or deploy frontend code:

```bash
sudo systemctl restart investor-frontend
```

## Known Limits

- Reconciliation currently uses Bullpen wallet positions and Bullpen history; it does not yet depend on a dedicated open-order API.
- RPC provider failover is applied per durable attempt, but Bullpen CLI capability still constrains how much of the underlying RPC state is externally observable.
- Cancel is intentionally limited to intents that have not yet been remotely submitted.
