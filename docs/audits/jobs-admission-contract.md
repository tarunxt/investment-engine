# Current release boundary — 2026-11-03

PR #1392 is narrowed to A9-002 ownership/cache scoping and A9-R05 public-copy
minimization, plus the reviewed serialized cancellation/terminal-preservation fix.
The proposal below is HISTORICAL, not the current release contract. The combined
A11 implementation/tests remain at published commit 08bff6b4; its synthetic tests
are retained under backend/tests/fixtures/a11_combined_08bff6b4/*.source.

Current owner queries and cached-result replay use current-main schema only.
There is no JobAdmission model/table, new migration, dispatch-status column,
per-child outbox producer or relay in this release. Legacy outbox and run fanout
match main. No Beat or financial-worker activation is included. Redis entries bind
actor, operation and normalized payload and always recheck DB owner and body;
cache expiry/loss and lease-loss durable uniqueness remain OPEN A11 work.

A11 consumer head 1bd38177818aada3acc99973aba878e511d0725e was source-reviewed.
It has no schema dependency but overlaps SyncJobRepository.update_status and
PostgresJobRepository.update_status. A future integrator must retain its token
fence and claim-preserving merge as well as this lane's terminal preservation for
unclaimed writers. Do not replace that fence with the simpler A9 guard. A9 does
not import, activate or claim acceptance for the separate consumer implementation.

No migration is needed for the narrowed release; baseline migration files/model
registry/outbox model are byte-identical to current main. No destructive rollback
or ledger cleanup is authorized. If an operator discovers the previously proposed
A11 revision already applied, preserve its records and resolve that state before
running a release migration command; do not blindly downgrade it.

---

# A9-002 / A11-001 / A11-003 proposed integration contract

Base: origin/main 8d25f34a33242adcaab092afdb07af7956f327bd.
This lane exclusively owns jobs router, async owner queries, create_job,
create_run and dispatch outbox. It does not modify Job columns or execution
claims. A11-002 retains ownership of consumer fencing and its migration.

* A9-002-A01/A02/A03: user-facing repository queries require actor identity.
  Cache values never authorize access. Foreign and missing jobs return 404.
* A11-001-R01: separate job_admissions table, unique (user_id, operation,
  request_key_hash); SHA256 normalized payload fingerprint; FK to existing job.
  Admission, job and obligation commit together. No TTL or historical cleanup.
  Conflicting payload returns 409; concurrent loser rolls back and reads winner.
  Redis is optional and cannot authorize creation or replay.
* A11-003-R01: additive nullable outbox job_id (unique), state, claim token,
  next attempt timestamp, safe error type. Topic analysis.dispatch.v1 only.
  One obligation per newly created job; no backfill or legacy replay.
  Stable Celery task_id is the outbox UUID; args=[job_id]. Store absolute UTC ETA,
  including Gemini 20-second offsets. Initial publish records acknowledgement;
  ambiguous exception or process loss remains visible as uncertain.
* A11-003-R02: bounded relay only for this topic and task
  app.domains.jobs.tasks.execute_ai_job. Recovery publication must use
  credx_recovery_analysis and credx:recovery:analysis:v1: transport prefix.
  No Beat change or service activation. Retrying ambiguous publication requires
  independently reviewed A11-002 execution fencing, not merely stable task IDs.
  Canceled/terminal jobs suppress unresolved delivery; existing output remains.

Coordinator must approve the exact additive migration and activation separately.
Rollback: disable relay, revert application only after draining in-flight requests;
retain additive tables/columns and records. Never downgrade away durable identities
or obligations containing live records. No migration or production action here.

A9-002-A04 remains gated on secure auth baseline, serialized integration, exact
release CI/review and approved isolated runtime read-back. None of these findings
is closed by source or synthetic tests alone.

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

## Dispatch exception boundary qualification (2026-11-07)

Exact-main compatibility was rechecked from fd1b0e0b to publication base
f11d9613459f8a9dd9c6270451f98adcf973e67b: two commits change only three frontend
files, with no backend, A11, migration or workflow overlap. Those frontend changes
are preserved; this candidate does not modify them.

The existing authenticated /runs endpoint accepts a client-selected
PolymarketEventRunContext. Its literal kind and required shape are validated by
Pydantic, normalized JSON is carried into the create-run command, and user_id is
always taken from current_user rather than the request body. The run/job writer
persists that context and authenticated owner together. This is not server-origin
attestation: a syntactically valid specialized request remains the existing
specialized route, even if its template was authored by the client. A11 does not
claim to police that excluded adapter's semantics or add generic ownership to it.

Nineteen new offline cases execute actual request validation, durable creation,
worker/repository lifecycle and recovery guard with only inference/broker seams
mocked. Ordinary or nonmatching stored kind requires a live durable owner before
the adapter. Valid specialized context invokes the existing mocked specialized
adapter and never the ordinary factory. Malformed persisted specialized contexts
invoke neither adapter. If context changes after specialization selection, the
explicit ownership guard prevents fallthrough to the ordinary factory. Recovery
rejects specialized and unknown contexts before worker writes or task registration;
creation is also rejected before Job/outbox insertion.

A generic wrapper regression was found and fixed: moving registration into the
ordinary claim branch had omitted the pre-existing specialized delivery-ID
registration. Its existing bookkeeping is now preserved in the specialized branch;
it is not authorization for ordinary inference and changes no Bullpen executor.
A synthetic delivery-ID negative test failed before that correction. Separately,
removing the ordinary ownership guard makes the changed-context negative fail.
Both checks use no real inference or broker. The restored source passes all scoped
checks. Existing Bullpen code remains byte-identical to main and unqualified for
new generic fence coverage.


### Private current-main compatibility qualification

This same-scope candidate rebases the frozen 44-file A11 change onto verified
main `fcd3247680ccc29dd469a73d69bcb3929255ff7e`. All 49 source changes since
`fd1b0e0bdcf9d6039edd040800a7bf2abaa5e13c` are preserved, including Audit 12
and Alpaca. Only workflow and model-registry overlaps required additive merges.
The sole unpublished A11 migration now follows `a12_cost_session_merge_001`;
actual Alembic graph inspection confirms one successor and a one-revision delta.
Deployment requires independently verified applied A12 parent and schema readiness.
Publication, main presence and successful CI do not authorize executing missing
A12 migrations. Stop if the parent is unapplied; do not upgrade ancestry implicitly.
No A9 overlay, Bullpen implementation change, relay activation or consumer start.

Private TCP-blocked acceptance: 109 passed plus 10 subtests; one Docker migration
case skipped, not passed. Native PostgreSQL and actual Docker migration execution
remain exact-head CI gates, not locally established facts. The original approved
manifest `11fb40019757788ee55af31821a56bc455abe46f7e8c8676f6c05e9b7c05aff9`
is unchanged. This compatibility revision requires separate publication review.

Additional native-harness/A12 adjacency run: 52 passed plus 4 subtests,
28 native PostgreSQL skips, and 4 A12 multiprocessing fixture failures because
the sandbox denied creation of the local Manager socket (PermissionError).
Those four cases did not execute their assertions; no socket restriction bypass
was attempted and no A12 source was changed. They remain unqualified locally.
