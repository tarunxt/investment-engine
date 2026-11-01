# A11-004: passive execution diagnostics

`/health/live` remains process liveness. `/health/ready` retains existing bounded
PostgreSQL/Redis and Stage 3 checks. `/health/execution` is additive, passive,
advisory and never a deployment gate. Saved-data routes are unchanged.

The execution adapter deliberately returns unavailable metrics until A11-002
owner heartbeat and A11-003 dispatch contracts are integrated. This is partial
implementation, not operational closure. Missing data is null/unknown, not zero
or healthy. Consumer freshness must come from durable owner heartbeat evidence,
not process activity, result PENDING, or remote-control inspect. No freshness SLA
has been invented. Only complete verified aggregate evidence can yield idle-empty
or queued-with-worker; these describe evidence, not successful job completion.

Minimal proposed adapter contract: cancellation-safe async read of an aggregate
ExecutionSnapshot with allowed-consumer freshness classification, pending count,
oldest pending age, durable claim verification, dispatch verification, exhausted
retry count. The upstream adapter must scope the recovery prefix and allowed queue,
limit query work and connections, and derive freshness using approved objectives.
Do not introduce schema fields on concurrent branches here. No raw queue scans,
payload retrieval or broker publications are permitted. No consumer/task imports
are needed. The outer read deadline is 0.5 seconds; this is a diagnostic resource
budget, not a service objective. Adapters also need native query/socket deadlines.

States: idle_empty, queued_with_worker, stale_heartbeat, consumer_unavailable,
partial_inspect, unavailable_metrics, exhausted_retry. Recovery separately labels
financial_services intentional_containment. Normal mode leaves them not_assessed.
No worker names, internal addresses, job/attempt IDs, error strings or caller
correlation strings are returned. Existing request correlation middleware remains
responsible for support correlation. Beat stays empty, remote control stays off,
and four financial workers stay stopped. No UI changes.

Pending owner decisions: backend health/recovery deployment owner and A11-006
coordinator must approve escalation owner, freshness and pending-age objectives,
and any change from advisory to deployment gate. Fields remain null meanwhile.
No alerts or operational SLA are asserted. Live acceptance may only read existing
telemetry and needs exact deployed artifact identity and independent read-back.
No live checks, paid calls, service interruption or production deployment were
performed by this task.

Offline verification: `python -m unittest discover -s backend/tests -p
 'test_execution_health_passive.py' -v` (run command on one line).

## Contract review and local projection adapter

Reviewed admission/dispatch cab3b8dc4783c76a9f063946831b090525d53005 and fencing
72ca85e614e612b9fd50a1e4d066d08e64620b5d using Git object reads only. The combined
private 24c3c9ee revision was not available locally and was not fetched remotely.
No admission/fencing-owned file is changed.

`summarize_durable` accepts safe projected values only and consumes at most 101
rows, retaining 100. Its explicitly named sample counts distinguish pending,
uncertain, delivered, suppressed, dead_letter, owned, expired claims and
reconciliation_needed. Incomplete/truncated scope does not claim aggregate totals.
Delivered does not prove receipt; owned is per-job lease evidence, not consumer
heartbeat; dead_letter includes RecoveryPolicyBlocked and does not prove retry
exhaustion. Receipt, consumer and service state therefore remain unknown.

Coordinator integration requirements: a scoped SQLAlchemy projection must select
only analysis.dispatch.v1 rows joined to the allowed recovery job population;
project outbox state/created_at plus execution_claim state/expires_at from
runtime_metadata_json, and terminal job status. Do not load payloads, tokens,
request metadata or whole ORM rows. Normalize timestamps to UTC epochs. Use a
100+1 limit and native statement/pool deadlines within the existing outer budget.
A sample cannot verify backlog totals or global oldest age. Full aggregate counts
need a separately bounded, reviewed query plan; no unbounded scan is authorized.
Consumer heartbeat, broker receipt and actual stopped-service evidence require
independent existing telemetry and cannot be reconstructed from these contracts.
The projection adapter is fixture-ready but intentionally not wired into HTTP
until the scoped reader and its query plan are available on the integration lane.

Substep status: .01 advisory policy documented; .02 durable projection implemented,
heartbeat/HTTP reader integration pending; .03 bounded adapter/redaction complete,
native DB query plan pending; .04 synthetic states modeled; .05 existing paths and
recovery configuration unchanged; .06 no publication/provider/service operations;
.07 seven offline tests pass, existing full application suite unavailable without
pytest; .08 owner/threshold remain unset pending approval. Live artifact identity,
read-only telemetry and independent acceptance remain external for all claims.
