# Jobs admission lane: implementation and acceptance register

Draft PR: https://github.com/tarunxt/investment-engine/pull/1392
Branch: work/jobs-admission-20261101
Fresh base (re-fetched before publication): 8d25f34a33242adcaab092afdb07af7956f327bd.
These are distinct deliverables within canonical findings, not new root causes.
No finding is closed and no runtime acceptance is claimed.

| Deliverable | Source result / synthetic acceptance | Remaining gate |
| --- | --- | --- |
| A9-002-A01 | Auth required for list/detail; explicit get_for_user/list_for_user; final create fetches scoped, including equity events/threats routes. Foreign/missing HTTP 404; worker get remains separate. | Exact secure-auth release integration and approved runtime identities. |
| A9-002-A02 | Durable actor/operation/key hash/payload fingerprint; changed actor independent, changed body 409. Redis hints never read as authorization; every replay rereads owned job. Corrupt foreign admission fixture denies. | PostgreSQL transactional fixture and approved runtime read-back. |
| A9-002-A03 | Direct API allow/deny, anonymous, 1–100 limits, filters, partial evidence, owner cancellation/terminal preservation; BFF actual handler/transport with synthetic auth/upstream; WebSocket foreign/missing never subscribe; actual export task foreign/missing returns identical failure before credentials/service. Existing cancellation/partial/run/export policy regressions pass. | Full Next server/session integration belongs with auth baseline; runtime acceptance pending. |
| A9-002-A04 | No deployment attempted in this lane. | Coordinator owns exact-head CI/review, auth baseline first, serialized release and approved safe read-back. Pending policy gate, not a tool denial. |
| A11-001-R01 | Additive unique actor/operation/key admission committed with job and obligation; uniqueness loser rolls back and reads owned winner; all states replay current job; no Redis lease required, lost cache/HTTP response cannot republish. Fingerprint retains exact prompt/provider/model/source metadata and normalized UTC schedule. History retained without TTL/cleanup. | Exact additive migration approval/application; opt-in PostgreSQL test skipped without explicitly approved disposable target. No production migration. |
| A11-003-R01 | Jobs, run links and one obligation per child commit atomically. Stable outbox UUID task ID; UTC absolute ETA and Gemini 20-second stagger; failure after first publication preserves delivered/uncertain/pending children. Owner detail adds nullable dispatch_status; legacy unknown stays null. | Consumer fence integration/independent review and runtime acceptance; no proof of provider deduplication claimed from producer fixtures. |
| A11-003-R02 | Bounded default-inactive relay seam (max 100/pass, max 5 sends, capped exponential backoff), durable uncertainty before I/O, claim-token acknowledgement, terminal suppression, dead-letter; only analysis.dispatch.v1. Recovery publisher enforces analysis task/queue and isolated broker prefix. Synthetic resumption touches only unresolved children and retains expired ETA/stable ID. | Partial operational implementation: no consumer service/Beat wiring or activation. Coordinator must approve exact recovery-service integration, A11-002 fencing, migration and rollback before enabling reconciliation. No production replay. |

## Review units

* a62be42e: published integration contract before shared code edits.
* eb96a4ff: additive admission/outbox schema and discovery; no Job model edits.
* 0c985362: owner-scoped HTTP/WebSocket queries and additive dispatch projection.
* 84dc6570: atomic producer admission/obligations, bounded relay seam and lifecycle fixtures.
* Follow-up verification commit: cancellation/terminal assertions and this register.

The schema and producer commits must ship together after reviewed migration;
they are review units, not independently deployable release instructions.
Existing Alembic head topology is preserved by appending to audit7_run_policy_001;
coordinator must reconcile other lanes' migration revisions without conflicting
Job model migrations. Downgrade explicitly refuses ledger deletion; application
rollback retains additive durable records. No historical duplicate cleanup/backfill.

## Verification

Python environment: temporary venv with repository requirements, pytest,
pytest-asyncio and aiosqlite. Synthetic database created under pytest temporary
directory; no live DATABASE_URL connection. All broker/provider/export boundaries
are doubles, including acceptance-before-timeout and process-death scenarios.

```
PYTHONPATH=backend python -m pytest \
  backend/tests/test_jobs_admission_dispatch.py \
  backend/tests/test_jobs_admission_postgres.py \
  backend/tests/test_recovery_containment.py \
  backend/tests/test_rebalance_side_effect_policy.py \
  backend/tests/test_google_sheets_tasks.py \
  backend/tests/test_google_sheets_output_contracts.py \
  backend/tests/test_output_runtime_cancellation.py \
  backend/tests/test_historical_partial_provenance.py \
  backend/tests/test_run_summary_projection.py \
  backend/tests/test_auth_websocket_tickets.py -q
```

Result: 144 passed, 1 skipped (explicit disposable local PostgreSQL not configured).
After adding owner cancellation/terminal/bounds assertions, focused component suite:
13 passed. Warnings are existing datetime deprecation and pytest fixture warnings.

BFF: `NODE_PATH=/tmp/jobs-node/node_modules node --test backend/tests/test_jobs_bff_boundary.cjs`
with temporary TypeScript 5.9.3 (or use frontend-installed compatible TypeScript).
Result: 1 passed. Executes transpiled current route and bounded transport, with
session resolver and upstream fetch doubles; not a real auth/session release test.

No Alembic execution, provider/search/sync, send/export, financial worker action,
production setting, host access, queue replay or deployment. No private reports,
account data, receipts or credentials in published files. No actual tool denial.

Additional touched-boundary verification: 75 passed, 12 subtests passed across
INDmoney/Zerodha threats, portfolio events/read projection, output source context
and saved snapshot source preconditions. Updated the source-precondition fixture
to accept only the expected (job_id, actor) via get_for_user.

GitHub exact-head PR checks and disposable-container migration workflow were
observed running at 08c4720b; subsequent fixture-only publication creates a new
head and requires fresh CI. No green exact-head CI or independent approval is
claimed. The prohibition above on Alembic execution refers to manual/local and
production operations; ordinary PR CI runs its existing isolated migration job.

## Independent cancellation-race review follow-up

The prior HTTP read/modify/commit could replace a completion committed between
its initial read and cancellation write. A stale worker could likewise replace a
committed cancellation. cancel_for_user now refreshes the actor-scoped Job under
SELECT FOR UPDATE, transitions only an active row, and holds the lock through the
route commit. The synchronous worker writer refreshes under the same row lock
and preserves terminal rows. no_autoflush prevents stale ORM dirtiness from being
written before the locking refresh. Only a successful cancellation revokes the
task and publishes the update; a completed/partial/failed winner remains intact.

Genuine PostgreSQL 16.2 evidence: both tests in
backend/tests/test_jobs_cancellation_postgres.py passed (2 passed, zero skips).
Two contender sessions plus a read-only lock observer require pg_blocking_pids
to report real contention before releasing the winner's barrier. Completion-first
preserves response, tokens, cost, source context and metadata, without revocation.
Cancellation-first preserves FAILED/cancellation and export suppression; the stale
worker cannot add output, usage or metadata after the cancellation commit.
The actual route and actual synchronous repository are exercised, not FakeDB.
Related synthetic/retained-behavior tests: 139 passed.

Local test dependencies were temporary only (including pgserver 0.1.4's packaged
PostgreSQL binaries). A new disposable cluster in /tmp/jobs-cancel-pgdata listened
only on /tmp/jobs-cancel-pg-socket, port 55439, with listen_addresses empty and
0700 socket access. The explicit acknowledgement is
CREDX_JOBS_CANCEL_PG_TEST=synthetic-socket-only plus the JOBS_SYNTHETIC_ONLY marker.
No application DATABASE_URL is read. Each test creates/drops its random synthetic
schema. No Alembic, provider, broker, send or production operation is involved.
Tests also support the existing guarded disposable LOCAL CI database and are
added to its existing PR concurrency job; no service/resource/environment is
added and the disabled deployment workflow is untouched.

A11-002 integration note: reviewed consumer head
72ca85e614e612b9fd50a1e4d066d08e64620b5d. Admission/outbox does not mutate the
reserved execution_claim metadata. Job IDs and stable outbox delivery IDs match.
The cancellation fix now overlaps the entry of SyncJobRepository.update_status:
the integrator must retain the consumer's stronger token/ownership checks,
locked fresh read and metadata merging, with terminal preservation for unclaimed
writes; do not replace consumer fencing with this lane's simpler guard. Preserve
this lane's new actor-scoped cancel_for_user and HTTP route transition. This is a
source integration overlap requiring joint tests, not a schema incompatibility.
Hidden SDK retries and exactly-once external effects remain unproven. Relay stays
disabled; no claim of activation or production acceptance follows from these tests.

CI correction preceding this follow-up: f43b0434 passed both API Attempt Migration
41342110955 and Pull Request Checks 41342110866. The failing assertion on e7e41e2d
was the verifier's unregistered additive outbox schema, not failed DDL. The exact
registered addition contract now checks preservation of a seeded legacy outbox
row and rejects altered old facts. This new cancellation head needs fresh CI.

Terminal-preservation follow-up: the advisory-capture failure fixture formerly
called update_status on an already COMPLETED synthetic source solely to trigger
capture. It now establishes PROCESSING before the completion call, retaining all
capture-failure assertions against the real transition. A separate real repository
regression now asserts that even a stale COMPLETED-to-COMPLETED write cannot
replace historical response, usage or metadata. This aligns the fixture with the
new terminal-preservation contract instead of reopening terminal writes.

## A9-R05 private projection/export minimization

Local review-only change on top of cab3b8dc; no publication or release action.
The supplied synthetic patch was decoded once, verified as 5287 bytes with SHA256
18376fc601448c69d38814ed2868e616367ff80c7dd9bf74646b1836576389ea, then applied.
The four parametrized JobResponse serializer failures now pass and their strict
xfail decorator was removed only after executing them with --runxfail. Original
acceptance assertions remain unchanged.

JobResponse field serializers minimize error_message, export_error,
request_context_json and runtime_metadata_json copies. Job list items use that
same DTO; WebSocket initial/update payloads use the same narrow diagnostic-copy
projection. Exact credential keys and labeled credential assignments are redacted
recursively; token counts, financial token IDs, quantities, currencies, source
IDs/hashes, unknown/null values and safe diagnostics remain. Prompt and response
provenance are retained. Stored ORM evidence and execution_claim metadata are not
rewritten; no repository, admission, cancellation, outbox or migration changes.
This is not a guarantee to identify arbitrary unlabeled secret strings.

export_tables minimizes credential-labeled cells in projected canonical/ancillary
tables, preserving row count, headers, provenance and normalized source originals.
Sheets prose/findings and returned error copies minimize labeled credentials.
_error_text remains bounded original stored diagnostic text; public returns are
sanitized separately, preserving storage semantics. Tests exercise the actual
export task with credential, append and notification boundaries mocked.

Corrected fifth-fixture scope: output_contracts/document.py::_separator requires
more than one column. The supplied one-column token table produces
unparsed_table_line errors, an unsafe normalization result and a failed export
before append. Therefore its original success premise is unsupported; the old
strict xfail and assertions remain intact as historical evidence, not relabeled
as passed. Per coordinator instruction, parser denial is preserved: no parser
expansion or policy decision. Separate actual-task acceptance asserts failed
status and zero append for that exact input. A valid two-column ancillary token
table exports a minimized copy to mocked append while financial cells, source
bytes and provenance remain intact.

Validation command: PYTHONPATH=backend python -m pytest -q
backend/tests/test_audit9_export_minimization_evidence.py
backend/tests/test_jobs_public_projection.py
backend/tests/test_google_sheets_output_contracts.py
backend/tests/test_google_sheets_tasks.py
backend/tests/test_output_contracts.py
backend/tests/test_jobs_admission_dispatch.py
backend/tests/test_historical_partial_provenance.py
backend/tests/test_recovery_containment.py

No real provider/credential/append/notification call, stored-original rewrite,
financial mutation, new resource, security setting, parser change, publication,
merge, migration, relay activation or deployment. Exact private commit/patch is
returned to the coordinator for independent review before any publication.

Final private validation: 227 passed, 1 historical xfail, zero unexpected failures.
The retained xfail is only the original one-column success assertion; the new
explicit denial acceptance and valid two-column ancillary redaction acceptance
both passed. The original fixture's assertions and retained xfail were not
weakened or relabeled. No policy question remains: existing denial is required.
The supplied acceptance source differs only by removal of the first strict xfail
marker after its four parametrized serializer cases genuinely passed.

## A9-R05 independent redaction re-review correction

Review of fa455bb6 reproduced three blocking diagnostic-copy gaps using only
synthetic values: SECRET_KEY=..., AWS_SECRET_ACCESS_KEY=... and Authorization:
Basic <synthetic-base64>. Three DTO cases failed before remediation. The text
matcher maintained a separate credential-label allowlist that omitted labels
already handled by the reviewed structured credential_label policy. Its generic
value matcher could also consume only the Basic scheme, leaving its payload.

Text assignment projection now reuses credential_label directly, the same policy
already used for structured mappings and export headers. There is no independent
text-label allowlist. An iterative label/value scan handles safe quoted wrappers
without hiding inner labeled secrets or introducing recursive string-depth growth.
Basic/Bearer scheme plus credential is consumed as one value; quoted strings,
[REDACTED] idempotence and safe diagnostic suffixes are preserved. The accepted
standalone Bearer, URL-userinfo and [REDACTED] contracts are retained. Existing
Polymarket logger and Bullpen audit sanitizer contracts were inspected; their
broad token-key scrubbers are not applied to financial token IDs/counts, and those
modules are not changed. This correction consolidates the jobs lane on its
reviewed structured policy instead of adding a conflicting ad hoc label list.

New test_jobs_public_projection_regressions.py: 19 passing synthetic cases cover
all three labels/schemes through JobResponse, actual initial WebSocket handler,
actual update publication with fake Redis, and actual export tasks with mocked
credentials/append/notifications. Also covers quoted labels, safe nested
wrappers, idempotence, 1500 flat wrapper assignments without recursion, stored
original immutability, quantities/currency/unknown values, source IDs, financial
token IDs, token counts and ordinary Basic analysis text.

Validation: the previous 227-test source/behavior set plus 19 new regressions:
246 passed, 1 unchanged historical xfail. All provider, credential, Redis, append
and notification boundaries remain mocked. No parser or old acceptance assertion
changes; the unsupported one-column success assertion remains historical xfail,
with explicit zero-append denial and valid ancillary redaction acceptance retained.
No changes to cancellation, execution ownership contract, admission/outbox,
migrations, financial provenance, stored originals or workflow settings. This is
an unpublished private delta against fa455bb6 for independent re-review; no claim
of deployment, real-data exposure proof, arbitrary secret detection or closure.
