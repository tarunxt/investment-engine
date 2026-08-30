# Bullpen 008 Phase 2

Bullpen 008 is a separate six-stage workflow under the `bullpen008` profile and
`/polymarket/bullpen008` API namespace. Bullpen 007 remains on its existing
three-stage routes, models, Redis keys, scheduler task and order-intent tables.

## Authority and handoff

1. Stage 4 produces the only authoritative target portfolio and a certificate
   containing `target_portfolio_hash`, `inputs_hash`, cluster-map version,
   optimizer version and `certificate_hash`.
2. Stage 5 reads that frozen target, a fresh same-account wallet and all active
   007/008 durable orders. It may only translate target gaps into claims,
   cancellations, full exits, trims, buys, holds and blocked rows. Its canonical
   `plan_hash` and plan certificate are persisted before Stage 6.
3. Stage 6 re-reads the exact plan and both hashes before every action. It
   refreshes wallet/quotes, verifies account identity, emergency stop,
   dependencies, market/odds/slippage/spread/liquidity/cash/shares and exposure
   caps, and checks for an existing durable intent or remote reference.
4. A durable 008 intent and attempt are committed before any irreversible
   provider call. Ambiguous submission is `Recoverable`; it is reconciled by
   remote ID and is never blindly resubmitted.

Deadline-passed wallet rows that are not yet claimable remain explicit locked
resolution holds in the Stage 4 target. They are never treated as cash or free
capacity. A Stage 5 no-buy plan may still certify when a pre-existing
untradeable hold is over a cap, but its certificate exposes
`final_wallet_within_caps=false` and `existing_untradeable_over_cap=true`; any
new buy continues to require the complete simulated wallet to pass every cap.

Production defaults to `execution_mode=shadow`. Live submission additionally
requires the environment gate `BULLPEN008_LIVE_EXECUTION_ENABLED=true` and the
exact authenticated confirmation `ARM BULLPEN 008 LIVE`. Phase 2 deployment and
verification do not set either control.

## Persistence schema

The Phase 1 Stage 4 target is an array of rows with market/condition/slug,
chosen side, strict/common-catalyst IDs, current exposure, proposed buy and
sell, target exposure, quote inputs, score inputs and explanation codes. Its
certificate includes bankroll/cash, largest contract/cluster exposure, all cap
and stress results, `inputs_hash`, `target_portfolio_hash`, version identifiers,
`portfolio_certified` and `certificate_hash`.

Phase 2 migration `0a1b2c3d4e5f` adds only 008 tables:

- `bullpen008_action_plans`: one immutable canonical plan per run/profile.
- `bullpen008_execution_intents`: stable action/idempotency identity and current
  lifecycle projection.
- `bullpen008_execution_attempts`: append-only attempt request/response and
  reconciliation evidence.
- `bullpen008_execution_events`: append-only status transitions.
- `bullpen008_alerts`: per-position warning episodes and hysteresis recovery.

The stage-output records remain immutable handoffs. Page loads project stored
facts and never recompute historical trading decisions.

## Component-reuse inventory

| Bullpen 007 component or pattern | Bullpen 008 Phase 2 usage | Treatment | Reason |
| --- | --- | --- | --- |
| Worker-stage card geometry and progress/status language | Stage 5 and Stage 6 cards in the existing two-row monitor | Extended in the 008 composition | Supports Phase 2 metrics without changing 007's three cards |
| `BullpenAutoRunStageOutputDialog` | Stage 5 plan and Stage 6 lifecycle/audit popups | Reused directly | Existing focus trap, Escape close, body scroll lock, z-index and responsive tables |
| Bullpen event/position table density | Target, current-to-target, alert and history rows | Reused pattern | Preserves headings, spacing, dollar/odds formatting and horizontal overflow behavior |
| Existing Bullpen status colors | Finished, partial, failed, blocked and cancelled stages | Additively extended | Keeps the established emerald/sky/rose/amber/slate meanings |
| Existing retry and run-history controls | `Retry as new run` on 008 detail | Extended through explicit 008 callback | A retry creates a new run/version and cannot touch a 007 order |
| Existing wallet/filter/formula/schedule widgets | Unchanged 008 shell around six-stage monitor | Reused/generalized from Phase 1 | Keeps the familiar Bullpen 007 layout and profile-explicit callbacks |

New 008-only UI is limited to Stage 5/6 metrics, isolated safety controls and
008 alert history; no new design system was introduced.

## Recovery and status semantics

Statuses are `Planned`, `RiskCertified`, `Ready`, `Submitting`, `Submitted`,
`Confirming`, `Filled`, `PartiallyFilled`, `Reconciled`, `Failed`, `Recoverable`,
`Cancelled` or `Blocked`. A live run with planned actions but zero durable
intents is explicitly `Failed before intent creation`, never Finished. A shadow
run can complete only when every planned action passes pre-submit validation;
it records zero durable intents and zero submissions by design.

Retries create a new six-stage run with `retry_of_run_id` and `retry_version`.
Original plans, stages, attempts and events are not rewritten. The shared
Bullpen runtime serializes authenticated CLI commands account-wide; Stage 6
also holds an additive account-scoped PostgreSQL advisory fence around each
remote operation.

## Alerts

The 008 beat refresh evaluates held-side LLM and actual Bullpen odds separately.
It records `llm`, `actual` or `both`, includes the run/refresh source, sends at
most one message per active warning episode and requires a two-point recovery
hysteresis before a later episode can notify again. Alerts never create intents
or orders. Bullpen 007 mail code is unchanged.
