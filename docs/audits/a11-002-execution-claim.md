# A11-002 ordinary AI execution ownership

Base: 8d25f34a. Implementation and isolated synthetic evidence only. Finding remains
open pending coordinated integration, deployed artifact identity and independent
safe operational read-back. No production acceptance is claimed.

## Proposed integration contract (002-R01)

No migration or new shared model: reserve
`jobs.runtime_metadata_json.execution_claim` for worker ownership. A11-001/003
admission/outbox and A11-004 diagnostic writers must preserve this key and job
identity. This is the proposed contract for the shared integration lane; joint
lane acknowledgement is still required before activation.

Fields: owner_token, attempt_id, delivery_id, started_at, expires_at,
provider_started, pending_calls, state, previous_attempts. Job ID remains the row
ID. Existing usage execution ID remains the Celery delivery ID and retry dimension
is unchanged; the ownership attempt ID is additional durable evidence.

Admission, checkpoints and worker result writes lock the job row. Lease time is
read after lock acquisition. Only the admitted token may write; tokenless sync
writes cannot overwrite claimed jobs. A duplicate exits before task registration
or provider execution. Existing COMPLETED/PARTIAL/FAILED states, including API
cancellation represented as FAILED with cancellation text, prevent admission and
result resurrection. Output/input identifiers are unchanged. Metadata writes merge
existing evidence, and asynchronous repository updates lock before merging so a
stale diagnostic update cannot erase a renewed claim.

Lease: 120 seconds; independent-session renewal every 30 seconds, bounded to two
hours. These constants are conservative implementation bounds, not an operational
SLA. Renewal failure is sticky for the current task. The lifecycle starts after
admission and stops in finally. Ordinary generate/repair calls and specialized
batch provider threads check ownership immediately before entering the adapter.
Each provider pool callback opens a separate session; no worker session is shared
across threads. Opt-in context copying preserves usage identity across both
specialized executor pool boundaries. Existing unclaimed specialized callers retain
their existing retry path.

Auto-Live's short independent heartbeat transactions and row-lock refresh concepts
were reviewed; no trade retry policy was imported. A12 cost effects remain a
cross-reference to this continuity root.

## Acceptance ambiguity contract (002-R02)

Commit provider intent/pending-call evidence before invocation. Record successful
return only after the adapter returns. Expiry before provider intent permits a
replacement attempt and retains prior attempt evidence. Once a provider may have
accepted a request, expiry/timeout/failure requires reconciliation and never
creates an automatic replay. Redis/Celery PENDING is unused.

The specialized executor propagates uncertain errors when ownership is supplied,
without its normal internal request retry or defensive conversion to a successful
batch loop. A timed-out future may still finish externally; no cancellation success
is assumed and the sticky lost-owner flag blocks further calls/result publication.
Known validation failures following a recorded successful return remain FAILED;
successful/partial outputs retain existing status paths. Available normalized
returned output and usage are retained on reconciliation without replacing an
existing output or canceled/terminal state.

No provider idempotency contract is established. The fence controls adapter entry;
hidden SDK transport retries and adapter-internal tool/repair requests remain
inside that boundary. Exactly-once external effects are not asserted. Further
per-transport fencing would require separately reviewed adapter/SDK changes.

## Synthetic evidence

```
python -m unittest discover -s backend/tests/isolated -p 'test_*.py'
python -m compileall -q backend/app/domains/jobs backend/app/domains/polymarket/bullpen_llm_execution.py
```

30 tests passed: 9 SQLite/protocol tests; 16 disposable PostgreSQL/Celery tests;
5 specialized executor tests. PostgreSQL 17.11 ran locally with TCP listeners
disabled, on `/tmp/a11-pg-socket`, port 55432. Tests require the explicit
`/tmp/a11-pg-run/A11_SYNTHETIC_ONLY` fixture marker and never read an application
DB URL. Each PostgreSQL test creates and cleans its own random synthetic schema.
Absent that fixture, PostgreSQL tests explicitly skip; skips are not passes.
Local test dependencies: SQLAlchemy, psycopg2-binary, Celery, pydantic-settings.

002-R01 evidence: real PostgreSQL simultaneous admission admits one provider
boundary; two Celery eager deliveries while generation is live cause one mocked
provider invocation; expired owner A cannot overwrite owner B's committed result;
uncommitted claim failure permits safe admission; heartbeat extends lease; renewal
failure blocks calls and terminal writes; lifetime bound holds; cancellation wins;
threads stop; completed/partial outputs and usage persist.

002-R02 evidence: provider-intent crash/expiry denies replay; accepted-response DB
checkpoint failure retains reconciliation evidence; ambiguous Celery timeout does
not retry on redelivery; known empty-output validation becomes FAILED; terminal
DB failure retains normalized response/usage without another invocation; specialized
calls execute before/after checkpoints; lost owner prevents adapter entry;
specialized request exceptions/timeouts issue one mocked invocation and propagate;
usage identity context survives the provider thread.

Celery eager dispatch runs the actual task function and helpers loaded from source
with the actual repository/lifecycle and synthetic SQLAlchemy Job projection.
External adapters, run notifications, and output validators are stubbed to avoid
application bootstrap and external access. This does not prove current production
module identity, real broker redelivery/worker process behavior, full model mapper
integration, hidden SDK retries, or deployment acceptance. All external calls are
mocked; there were zero real provider requests.

## Publication and safe boundaries

Only source code, synthetic fixtures and this contract are published. No private
report text, receipts, account rows, work mail or credentials are included. No real
provider/broker/production DB operation, send/export/trade, host service change,
security change or infrastructure resource was used. The local disposable fixture
is unrelated to production or backup archives.

The branch was published; draft PR creation returned GitHub GraphQL `Forbidden`
and CLI auth validation reported an invalid token. These messages establish an
access failure, not an automatic-approval policy rejection. No credentials were
retrieved or changed; the denied endpoint was not repeated or bypassed. Parent
owns access handoff, shared-lane acknowledgement, merge/deploy and rebasing around
independent signing-key/viewer changes.

## Fixture compatibility follow-up (2026-11-02)

Draft PR1398 at 72ca85e6 failed CI run 41373676127 (jobs 125049257058
and 125049257177): legacy output fixtures supplied FakeDB without execute(),
which cannot implement durable row-locked claims. Migration run 41373676133 passed.
These failed runs remain part of the evidence history.

Adapted only test_job_table_validation.py and test_output_runtime.py using the
fixture pattern reviewed at integration reference 6eb000a. They now persist actual
Job rows in isolated SQLite and use the actual SyncJobRepository for admission,
provider-boundary checkpoints and terminal fencing. External adapters remain
mocked. Cancellation mutations are committed in the synthetic fixture to represent
the API transaction. Added explicit stale-token and expired-owner output/usage
assertions. No claim/fence bypass, fake successful admission, quarantine/skip or
runtime behavior change is included.

Socket connect, DNS lookup and datagram network operations were blocked by a
local pytest plugin during verification. Three affected suites: 85 passed, 1 failed.
Eight adjacent output suites: 236 passed, 1 failed. Compilation and diff checks
passed. These results do not replace the earlier 30-test isolated acceptance run.

Remaining failure: test_failed_cancellation_read_preserves_original_failure.
When a provider exception is followed by get_fresh() failing, current runtime code
logs the error but does not take the locked reconciliation fallback; the durable
claim remains owned instead of reconciliation_needed. The integration reference
contains an 11-line fallback for this path at tasks.py, independently of its other
unrelated changes. This correction is intentionally not imported under the
fixture-only instruction. The assertion remains active and failing; no green CI
or complete correction is claimed. Coordinator must resolve the runtime scope
before this can be considered ready for integration.

## Narrow reconciliation correction (2026-11-02)

After the coordinator clarified that the narrow runtime fix is within the existing
implementation authority, composed only the exact 11-line reconciliation fallback
from integration reference 6eb000a251ae0f5e1f884de81e96238b5e3e7929. The reference
commit's other tasks.py projection change and all unrelated integration changes
were excluded. The existing failing assertion remains active.

If the diagnostic get_fresh() read fails, the fallback uses reconcile()'s separate
rollback/locked-row read and retains failure_metadata from the original provider
exception, with retry_safe=False. Its token comparison and nonterminal predicate
remain unchanged. It cannot certify success, overwrite a replacement owner, or
resurrect cancellation. Added two focused regression cases for those terminal and
owner fences during the same failed-read/provider-error path.

Guarded verification: 253 passed (239 adjacent output/fixture cases and 14 isolated
ownership/specialized-call cases). The prior failed-read case now passes, including
its original-provider-error and uncertainty assertions. Compilation and diff checks
passed. Socket/DNS/datagram operations remained blocked during the test run;
PostgreSQL fixtures stayed stopped and were not rerun in this correction. Earlier
PostgreSQL evidence and full deployment/broker/SDK limitations remain unchanged.
The earlier failing CI and local runs above are retained, not replaced with a
claim that they passed.
