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
