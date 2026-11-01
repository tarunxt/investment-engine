# A11-002 ordinary AI execution ownership (implementation attempt)

Base: 8d25f34a. Synthetic evidence only. Finding remains open pending integrated
PostgreSQL acceptance, deployed artifact identification and independent read-back.

## Minimal coordination contract

No new schema: reserve `jobs.runtime_metadata_json.execution_claim` for worker
ownership. A11-001/003 admission/outbox must preserve this key and job identity;
A11-004 may observe it without authorizing dispatch. Integrate this contract before
relay activation. Diagnostic writes must merge metadata rather than replace it.

Fields: owner_token, attempt_id, delivery_id, started_at, expires_at,
provider_started, state, previous_attempts. Job ID is the existing row ID. Usage
execution ID remains the Celery delivery ID and retry dimension is unchanged.
The ownership attempt ID is an additional durable identity, not a replacement.

Admission and worker writes lock the job row. Only the admitted token may write.
A live duplicate exits before task registration, provider creation or execution.
Cancellation and existing COMPLETED/PARTIAL/FAILED states block ownership and
terminal writes. Successful result statuses, output validation and usage fields
retain their existing paths. Previous claim attempts are retained.

Lease: 120 seconds; renew every 30 seconds with independent transactions, bounded
to two hours. These are conservative implementation constants, not an operational
SLA. Renewal failure blocks subsequent ordinary provider calls and result writes.
A network call already in progress cannot be stopped or proven unaccepted.

Expiry before durable provider intent permits a new ownership attempt. Once
provider intent is committed, expiry or execution failure requires reconciliation;
there is no automatic replay. A crash between intent and sending may therefore
require manual reconciliation despite no charge. Redis/Celery PENDING is unused.
No provider idempotency support was found in the current adapter source. Exactly
once external effects are not asserted. Repair calls are checkpointed individually;
the specialized event executor has a checkpoint at its enclosing boundary, and
its internal calls cannot be interrupted by this wrapper.

Auto-Live's short independent heartbeat transactions and row-lock refresh concepts
were reviewed. No trading retry logic or financial worker path was modified.
A12 cost implications remain attributed to this continuity root.

## Evidence and remaining work

Run without application bootstrap or network services:

```
python -m unittest discover -s backend/tests/isolated -p test_execution_claim.py
python -m compileall -q backend/app/domains/jobs
```

Nine tests cover live duplicate denial, distinct attempt/delivery identities,
pre-boundary expiry replacement and stale-owner rejection, provider-intent crash
reconciliation, cancellation, renewal expiry, failed claim commit, two concurrent
deliveries with a serialized lock double, actual repository terminal-write fencing
and metadata retention, and PostgreSQL FOR UPDATE SQL generation.

SQLite does not prove PostgreSQL row-lock concurrency. Full Celery task fixtures,
long-running heartbeat/thread timing, provider-acceptance crash doubles through
the complete task, post-response database failure, and specialized executor
internal-call fencing still require integrated acceptance. The conservative error
path leaves nonterminal jobs reconciliation-needed after post-admission exceptions;
this intentionally withholds automatic transient retries and may need an explicit
reviewed classification for proven pre-provider failures. No claim of complete
preservation of all historical failure/retry presentation is made.

No real provider calls, broker operations, production connections, sends, exports,
trades, host changes, restarts, credentials or new resources were used. This record
contains synthetic identifiers and source contracts only. Coordinator alone owns
merge/deploy and rebase sequencing with independent signing-key and viewer fixes.
