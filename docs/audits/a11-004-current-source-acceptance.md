# A11-004 current source acceptance

This candidate composes the existing passive diagnostics and actual progress
reader onto the November 7 current-main backend snapshot. It does not establish
deployment, restore readiness, an approved monitoring SLA or a healthy consumer.

## Included behavior

- Existing process liveness and database/Redis readiness retain their contracts.
- A separate execution endpoint reports advisory, explicit unknown telemetry.
- The progress endpoint uses the canonical authenticated user dependency. Query
  parameters cannot select another actor.
- The read projects only bounded scalar claim and dispatch fields. It has a
  dedicated read-only transaction, native statement/lock deadlines and an outer
  timeout. Missing or pre-migration schema is unavailable, never empty or healthy.
- Per-job receipt, ownership checkpoint and provider-boundary times are distinct
  from a consumer-wide heartbeat. A bounded actor sample is not a queue total.
- Recovery containment remains intact. Reads publish no work, call no provider,
  start no worker and cannot change financial-service state.

The generic A11 execution owner must capture the versioned progress fields in
its existing owned transactions. The durable dispatch integration must supply
the existing analysis.dispatch.v1 projection contract. Those shared files are
maintained by the generic admission/dispatch work, not replaced by this patch.

## Verification on this candidate

The reviewed offline suite passes 35 tests and 10 subtests. It covers summary
states, actual FastAPI router with real containment middleware in both modes,
auth/actor scoping, source-preserving readiness regressions, bounded projections,
timeout/error behavior, missing schema and disposable PostgreSQL target guards.
External network connections are prohibited by the local harness.

Negative control against the unchanged main health router fails both actual
route cases because the new endpoints return 404. The incompatible-schema
unknown-state case still passes. The reviewed router was restored afterward.

Ten native PostgreSQL cases are prepared for the existing explicitly
acknowledged disposable local CI service. They are not counted as passed here.
They check native query plans, bounded selection, actor scope, timeout, pool and
lock behavior, transaction cleanup, and read-only rejection of mutation. The
prior PG18 receipts remain historical; no new PostgreSQL claim is inferred.

Independent review reproduced a recovery-filter omission for JSON null source
contexts. The corrected predicate accepts both SQL NULL and JSON null, while
rejecting a JSON string containing "null", malformed objects and wrong markets.
The new regression fails on the prior reader and passes on the correction.
Both native reader suites now include the corresponding PostgreSQL regression.

## Remaining closure gates

Integrate the generic progress capture and durable dispatch contract, rerun this
suite against the final shared code, run the native PostgreSQL cases, complete
final union review and exact-code deployment evidence, and perform bounded
authenticated read-back of existing telemetry. No paid probe, synthetic live
job, intrusive fault, alert send or new background cadence is required.

Consumer-wide heartbeat, global queue age, escalation owner and an approved
freshness threshold stay explicitly unknown unless independently supported.
Do not convert these qualifications into a blanket operational-health pass.

## Current standalone A11 qualification (2026-11-07)

This section supersedes earlier combined-lane and release-boundary wording for
this candidate only; earlier receipts remain historical. Base is exact main
`fd1b0e0bdcf9d6039edd040800a7bf2abaa5e13c`. A11 and A9 are separate releases:
A11 establishes durable generic execution ownership/admission/dispatch plus passive
health/progress. A9 resource/monetary/provider controls are not imported or included.
No Bullpen executor change or specialized Bullpen acceptance is claimed.

A11's actor/key uniqueness is enforced by its database constraint and loser replay,
not a Redis lease or the unpublished A9 capacity lock. Existing main ingress
validation remains. Cache entries remain optional actor/payload-bound hints; neither
foreign/stale cache contents nor cache loss authorize replay or block durable identity.
The A9 overlay later consumes `admit`, `require_owner`, ExecutionOwnership's sticky
lost-event callback, repository execution_token/owner_lost and centralized
_update_job_status. A9 adds its own resource contexts, pre-terminal resource release
and typed no-paid-dispatch branches. A11 does not introduce a substitute resource
claim or permissive budget bypass.

No analysis relay is registered or activated by this candidate. Backend-only
startup/restart in recovery and normal mode preserves pending/uncertain obligations
and jobs; real auth readiness and prompt seeding remain. Relay recovery stays default
inactive and requires explicit coordinated activation after its acceptance gates.
No live backlog dispatch, provider call, export/send, worker activation or deployment
is part of these source/synthetic receipts.

Canonical Alembic ScriptDirectory confirms one main head auth_session_merge_001;
A11 adds only jobs_admission_dispatch_001 as its single successor. No historical
revision is rewritten and no A9 or unrelated-head merge is included. The Docker CI
gate upgrades an isolated synthetic database to the existing parent, inserts a legacy
outbox row, then runs the actual targeted A11 upgrade twice and verifies retention
and constraints. Production preflight must verify the existing parent/applied-state;
never use blanket upgrade-head to resolve unknown state or drop durable ledgers.
Repository Docker-only Alembic requirements remain despite no-Docker production.

Local isolated results (separate, overlapping selections, not summed):
- Core/provider/admission/output/recovery/startup: 169 passed, 1 Docker migration skip.
- Generic claim/progress/native harness: 31 passed, 18 native PostgreSQL skips,
  4 guard subtests passed.
- Owner/cache/public projection compatibility: 63 passed.
- Independent passive health selection: 33 passed, 10 native PostgreSQL skips,
  10 subtests passed.
- Corrected canonical migration graph test: 1 passed, 1 Docker migration skip.

Native skips are not passes. PostgreSQL installation/download remains unperformed.
Existing CI PostgreSQL16 on the exact proposed head must execute all selected native
admission/execution/health/progress cases with zero skips. The existing Docker CI
release gate must execute the actual targeted migration test, also with zero skips.
Source verification, synthetic evidence and preserved historical PG receipts do not
claim current-head native execution, production identity or operational closure.
