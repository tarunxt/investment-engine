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
