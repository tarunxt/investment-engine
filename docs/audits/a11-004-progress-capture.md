# A11-004 passive progress capture follow-up

Integration candidate base: draft PR1407 head
8d0093a197ea515d2e814a7ee310e5a70c1de349, fetched 2026-11-02 13:58:07 UTC.
Fresh report reviewed: Audit11 Fresh Redo, assessment/preservation/acceptance pages
16-18. Canonical identity A11-004 is retained; no new finding or closure asserted.

## Actual producer capture

The existing fenced claim transactions now record a versioned `progress` object
under `runtime_metadata_json.execution_claim`. Admission records admitted_at;
the existing owner renewal records lease_checkpoint_at; existing before/after
provider boundary transactions record provider_call_started_at (intent) and
provider_call_returned_at (response returned to the current owner). No new I/O,
commit, thread, task, timer or schedule is introduced. Capture does not authorize
ownership, retries or calls. Stale/foreign owners and terminal jobs still cannot
update the record. Claim/token/attempt/delivery identities are unchanged. Previous
attempts and unrelated metadata remain retained; unrecognized progress versions
are preserved unchanged, not overwritten. No historical backfill is performed.

Task admission classifies receipt_scope as recovery_analysis only for an actual
non-eager request with an ID, expected analysis routing key and configured isolated
transport prefix. The record contains the safe scope enum only, never addresses,
worker names, payloads or newly copied identifiers. Missing/mismatched context is
unknown. This is evidence of a fenced job receipt, not proof that every queue has
a consumer or that an idle consumer is alive. Duplicate/rejected deliveries do not
refresh progress and therefore cannot manufacture a healthy heartbeat.

Existing producer outbox published_at and state are reused as publication evidence;
no dispatch/relay code is modified. Publication remains distinct from receipt.

## Read path

Existing public `/health/execution`, `/health/live` and `/health/ready` stay intact.
New `/health/execution/progress` uses the existing authenticated current-user
dependency and takes no actor query/header override. It passes the current actor
into the existing safe SQLAlchemy scope (actor + analysis topic + recovery equity
policy) and a dedicated read-only session. No auth/session/security behavior is
changed; authentication itself continues to use the established dependency.

The query adds safe scalar claim progress timestamps, scope/version, published_at,
next_attempt_at and the scalar absolute ETA from the outbox JSON. Whole payloads,
whole metadata, tokens, IDs, provider prompts/responses and errors are not selected
or returned. ETA is used internally only to honor scheduled/Gemini offsets.
Results expose observed/source timestamps, last receipt/owner-checkpoint/call-intent/
provider-return/publication ages and explicitly named sample counts. Intent is not
a provider acknowledgement. Source timestamp means latest observed timestamp in
the sampled rows, not latest across all workers.

LIMIT/fetch cap 101, process cap 100. Native statement timeout 150ms, lock timeout
50ms, outer acquisition/read/cleanup budget 450ms are inherited diagnostic resource
budgets, not SLAs. Transaction is READ ONLY and rolled back. Diagnostic reads never
write work or call broker/provider APIs. Empty observed samples have zero sample
counts; failed reads have null counters. Legacy/missing progress has unknown receipt
evidence. Clock-future evidence is not accepted as a recent source timestamp.

Sample oldest eligible dispatch age uses max(created_at, absolute ETA,
next_attempt_at), excludes future/not-due obligations and terminal rows, and applies
only to pending/uncertain sample rows. Malformed eligibility timestamps make the
sample age unknown rather than immediate. This is not broker queue age: the global
oldest_eligible_queue_age_seconds stays null and queue_state stays unknown.
Expired *active* claims are counted from existing ownership expiry; terminal
history is never labeled a failed active execution. Financial services retain the
intentional_containment label in recovery.

All responses remain advisory, deployment_gate false, consumer/freshness/status
unknown and thresholds/escalation owner unset. Even observed receipts or lease
renewals never become verified global health. This makes useful actual progress
observable without inventing an idle heartbeat producer or freshness threshold.

## Integrator coordination and acceptance

Sole integrator 01a1988f-4029-7346-8302-7014cf0c203f must review the isolated shared
file hunks: jobs/execution_claim.py, jobs/tasks.py and health/router.py. No shared
model/table/migration or dispatch file is changed. Additive JSON contract lives
inside the already-preserved execution_claim key. Integrate these hunks against
the latest fencing lane; do not replace other concurrent task/claim changes. This
candidate is private/local and does not update PR1407 or any other draft.

Tests: 7 synthetic reader/ASGI-body tests; 5 actual persisted claim-capture tests;
2 native PostgreSQL18.6 tests; 9 existing claim tests; 9 existing passive-health
tests; 4 existing bounded-reader tests. 36 tests total, including synthetic auth
substitution rather than full canonical auth/ORM bootstrap. ASGI checks actual new
endpoint body, rejects unauthenticated fixture requests, ignores actor query spoof,
and keeps observed progress unknown-health. Native tests use official pinned image
postgres@sha256:3a4264520e121176619f54ff867d12774bc81e95e7b84db58d63bccdb6144b81,
network none, tmpfs data and a fixed disposable Unix socket, with random schemas.
They verify actual JSON projection/actor exclusion, query timeout/cancellation
cleanup, read-only rejection and no job mutations. Actual capture hooks are tested
with persisted synthetic SQLite ownership rows; no paid provider is called.
The full integrated pytest compatibility/application suite was not run in the
minimal isolated environment; prior integrated schema/HTTP evidence is not claimed
as a new result. No Bullpen files or specialized provider tests are changed.

Source-ready scope: new executions capture bounded passive per-job evidence and
an authenticated reader consumes it. Runtime acceptance remains open: exact API /
worker artifacts loaded, migrated existing outbox contract, existing consumer
actual route/prefix, real receipt/checkpoint data, current service containment,
query plan at deployed scale and independent safe read-back. Fixtures prove none
of these live facts. Consumer-wide idle heartbeat, global broker queue age and
freshness classification remain unknown. No new generic permission is required
for this source implementation; any future gate/alert objectives need an owner
policy decision. No threshold, activation, restart, relay, schedule, migration,
external integration/provider operation, merge or deployment was performed.
