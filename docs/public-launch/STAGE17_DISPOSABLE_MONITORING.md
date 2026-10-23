# Stage 17 disposable monitoring composition

Uncommitted candidate based on independently verified application commit
`3bcd3e4e9022cc04b0319b84963457684d60e1a4`. No UAT2 deployment or real
notification integration is claimed.

An explicit `DisposableMonitoringFactory` pins the existing acknowledged
disposable database, synthetic operator policy and exact no-network `LocalSink`.
Without that configuration, monitoring delivery remains unavailable. Installing
application bindings does not register a task, publish a message, start workers
or change Beat. Explicit registration is app-local on `operational_monitoring`,
with late acknowledgement, rejection on worker loss, zero automatic retries and
bounded task time. The financial consumer's reviewed effective read/write broker
and transport-options guard is shared, with its behavior retained.

Authenticated disposable account routes provide observation intake and owned
status. Request data cannot select an owner, report flags, correlation identity
or delivery destination. Observations come from owned SQL state; the existing
server-derived owner/day correlation coalesces identical reports. The consumer
revalidates the report's closed schema, owner and original identity before local
delivery. Current appointed active administrators alone can acknowledge or
escalate an owner's alert. Operator actions are audited and stay subject to the
existing monitor control/owner fences. Status returns a closed projection.

A durable `dispatching` marker is uncertainty, not permission to resend. Process
loss or ambiguous delivery must not produce another local effect; repeated
wakeups leave that record for operator review. Unknown exception arguments are
not copied into task error messages. Normal-runtime monitoring destinations,
on-call appointments and actual response procedures are still unconfigured.

The delivery and crash service cases use signed authenticated ASGI admission, real
disposable PostgreSQL/Redis and owned child workers. They cover delivery plus
duplicate wakeup, and local effect followed by child exit 73, observed expired
Redis reservation, normal Kombu restoration of the same task ID and replacement
worker completion without a second effect. The explicit recovery procedure does
not certify an unattended recovery deadline. Collection is not execution. The
effect count is a process-shared synthetic counter; no email, SMS or remote
monitoring system is contacted.

Intake acquires the existing monitor control/owner fence before snapshot reads,
matching delivery lock ordering. A third prepared PostgreSQL case coordinates
intake and dispatch, observes dispatch blocked on the control-row INSERT in
`pg_stat_activity`, and requires both transactions to finish with one receipt.
That case has not executed locally; the original review identified a source-level
inversion rather than reproducing a PostgreSQL deadlock.

Finite remaining disposition after this candidate:

1. Independent review, actual successor service tests and exact-head artifact
   binding are required for this monitoring code.
2. Residency verification authority/evidence acquisition, signup verification
   provider and proxy policy, real consumer/monitoring destinations, operational
   roster and recovery response policy remain unconfigured real bindings. Safe
   synthetic contracts are not real integrations or approvals.
3. Full account export/erasure, retained/shared content, identity and backups
   remain partial or held pending category-specific policy and safe adapters.
   No arbitrary raw content is released and no real data is deleted.
4. The nine public/live release gates, renewed UAT2 runtime/cost and deployment
   authority, UAT2 verification and owner acceptance remain separate. UAT2 stays
   stopped. Stage 18 admission must use an explicit honest scope decision; this
   candidate does not declare full Stage 17 completion.
