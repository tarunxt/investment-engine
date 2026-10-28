# H1 hosted workflow: source integration map

Local continuation began 23 October 2026 at 20:29:02 UTC on
`codex/credx-hosted-composition-local-20261024`, branched from the exact separately
approved publication candidate `f38a9f348b13274aaa48c83507e5cbd162e88677`.
Later local work is not included in that publication approval or PR #1262.

Prior implementation timings, supported by local file creation and Git commit
timestamps: durable venue implementation started 20:18:22 UTC; recoverable
privacy implementation started 20:21:17 UTC; code/test commits completed at
20:26:43 and 20:27:03 UTC; the publication-gate record completed at 20:27:44 UTC.
These times describe local work, not deployment or owner acceptance.

The prior candidate changed exactly these nine files:

- `.github/workflows/pr-checks.yml`
- `backend/app/domains/order_intents/execution.py`
- `backend/app/domains/order_intents/journal_fake.py`
- `backend/app/domains/public_service/recoverable_privacy.py`
- `backend/tests/test_priority_adapters_postgres.py`
- `backend/tests/test_recoverable_privacy.py`
- `backend/tests/test_synthetic_venue_journal.py`
- `docs/public-launch/PRIORITY_COMPLETION.md`
- `docs/public-launch/STATUS.md`

## Existing components and precise hosted gaps

| Requirement | Reuse | Hosted integration still required |
| --- | --- | --- |
| Exact verified owner and environment | `core/uat2.py`, auth dependencies, PublicIngress, existing native confinement | Validate unchanged outer barrier, Google flow, no-egress controls and current authorization at deployment. No new identity or permission. |
| Optional module availability | Canonical registry, `ModulePolicy`, lifecycle fences and preferences CAS | Current `platform_available(..., uat2=True)` denies every optional module. Add a server-owned, session-scoped simulation binding for only Zerodha/INDmoney; preserve default deny everywhere else. No global flag or blanket `uat2=False` shortcut. |
| Simulation entitlement labels | Existing module facts/response contracts | Keep synthetic jurisdiction/plan facts distinguishable from trusted residency or customer entitlement. Module selection cannot grant execution approval. |
| Both connection modes | Canonical `IntegrationConnection`, Stage10 attempt/session/version guards | Compose credential-free synthetic setup, review, mode switch and disconnect. Real provider/credential routes remain unmounted. Current normal store requires encrypted material; do not activate it or introduce a persistent encryption key to make fake setup work. Preserve old binding identity for reconciliation. |
| Synthetic acquisition | Existing acquisition schema/hash validation | Shared application service now extracted locally from preview; explicit scope and canonical authorization mandatory. Positive hosted PostgreSQL acceptance remains unrun. No source is generated at read time. |
| US preview and exact acceptance | `ManualImportService`, immutable accepted snapshot predicates | Mount only template/preview/accept/read contracts under the simulation policy. Price-fetch/provider endpoints stay excluded. Add exact-source US browser acceptance. |
| Six-stage governed analysis | `Workflows`, `QueuedAI`, budget reservations, source/job/output validation | Reviewed synthetic plan/provider, governed dispatch and completed-output validation are now extracted locally into `SyntheticAnalysis`. Bind its explicit scope/canonical policy to the actual hosted app and worker; positive hosted PostgreSQL acceptance remains pending. |
| Durable dispatch | Existing SQL outbox, workflow stage dispatch, dedicated UAT2 Celery/Redis | Register explicit fake-only task handlers with current SQL fences. Existing UAT2 worker only has the bounded fake-AI task. No production tasks or broad scheduler imports. Redis is delivery, not approval authority. |
| Scheduled analysis | Workflow calendar/tick deduplication and schedule-pause state | Bind a controlled fake-only scheduler to the existing UAT2 app with bounded batches and explicit resume. Never schedule approval or submission. Do not enable existing schedules through startup side effects. |
| Basket preparation and exact approval | `Orders`, frozen review, authenticated confirmation authority, Stage16 UI | Extract the existing verified synthetic-trim conversion without automatically approving. Scope dependencies to the caller-owned hosted app. Bind every displayed leg/sequencing/digest/account/mode/version and expiry. |
| Durable fake execution | `ExecutionWorker`, `JournalBrokerFake`, fresh fake market/risk checks | Compose an independent bounded PostgreSQL journal transaction on the existing dedicated UAT2 database. Fixed synthetic catalogue; no SDK/token/credential fallback. Exact approval plus SQL policy must still arbitrate dispatch. |
| Partial/unknown/restart recovery | Persisted execution runs/attempts/fences and read-only reconciliation | Register bounded polling/reconciliation without resuming unsubmitted basket legs or replaying a persisted claim. Unknown must stay unresolved when evidence is absent. |
| Safety, cancel and disable | Canonical lifecycle cancellation, owner safety reads, stored receipts | Preserve always-available owned safety visibility after disable. Prove cancellation/disable races through actual hosted bindings; do not broaden legacy endpoint exemptions. |
| HTTP/BFF/WS/export matrix | Existing ownership/module/stream/export suites and source inventory | Selectively rerun changed seams, include both modes and US import; retain SQLite versus PostgreSQL/Redis versus browser versus hosted distinctions. WebSocket enablement requires actual origin/owner/revocation composition. |

## Local continuation outcomes

`analysis_workflows.synthetic_sources` now owns the existing fixed synthetic
acquisition algorithm. The preview delegates to this application service, rather
than becoming a hosted dependency. It retains the same receipt bytes and
same-day uniqueness; current connection/version mismatches or legacy snapshots
cannot be relabelled. Scope checks precede source writes. The hosted scope checks
the actual PostgreSQL database/user/schema, dedicated host/port, existing UAT2
startup validation, exact verified active owner, and credential-free fake
connection. The preview scope is limited to existing disposable SQLite paths
and synthetic fixture identities. A valid canonical module identity is required
before acquisition. Hosted module availability is still closed, so this source
extraction does not enable hosted work.

`synthetic_composition.SyntheticAnalysis` now owns the existing governed fake
plan/provider composition, persisted job dispatch, completed-analysis validation
and bounded stage advancement. The preview delegates to this object. Its
constructor requires an explicit source scope and canonical policy, and every
authorization checks the scope and exact returned owner/module identity. Frozen
plan, budget and provenance versions are preserved. It registers no routes,
workers, schedules or default runtime. This extraction is a reusable application
component, not a proposal to mount the disposable preview on UAT2.

The expanded local regression run initially found the preview seed test relied
on non-preview fixture emails and acquisition for a disabled module. The test
now uses explicit preview identities and requires only the selected owner to
receive a source; it still asserts no approval or module-selection mutation.
The stricter scope/disable rules were retained. Final focused results are
recorded with the local continuation commit and do not apply to published f38.
Final local check at 20:39:23 UTC: **78 passed, zero skips**, covering the shared
source scope, existing six-stage linked workflow, actual confirmation/fake
execution integration and Stage16 views. Inventory generation and `--check`
also pass. Positive hosted-scope PostgreSQL and fresh browser acceptance are
not established by this SQLite/ASGI result.

The source inventory correction updates only source hashes for the published
adapter files. The failed exact-f38 baseline check is preserved as a failure;
no source change or later passing test is transferred back onto f38.
The minimal repair is isolated as `ed98b8ebfced2c614f8da5f713d73ae5c47023f7`,
changing only `entrypoints.json` (three source-hash entries). In a detached
worktree at that exact commit, inventory `--check` and all five baseline pytest
cases pass. It has not been pushed and contains no later composition code.

## Publication and actual CI

After explicit approval of exactly f38, remote absence was checked; the push
succeeded once. Draft PR #1262 targets the verified integration branch and has
head exactly f38. No later local commit was pushed. The exact-f38 adapter job
`120640803008` in PR Checks run `40019717710` completed successfully with **42
passed**, including all five actual PostgreSQL cases, and passed its zero-skip
gate. This is finite PostgreSQL fixture evidence, not hosted UAT2 acceptance.
Baseline run `40019717634` failed because `entrypoints.json` lacks the new source
hashes. Its local correction remains separate. Other workflow results must be
checked to terminal state before any candidate is considered reviewable.

## H2/H3 boundaries remain open

The reversible privacy drill is not complete account privacy. Canonical content
projections, shared blobs/outbox ownership, identity/sessions, external stores,
backup retention, legal holds and any recoverable executable-work quarantine
adapter remain individually held. Existing disposable application bindings
remain test-only. Support/monitoring/retention provenance must be composed for
the actual hosted runtime; external sinks remain disabled. No new hosted
privacy-erasure route is authorized or installed by this continuation.

Deployment remains excluded until complete source review, exact green CI and
artifact identity, renewed/current UAT2 READY evidence and parent coordination
with the existing deployment executor. Prior restricted owner acceptance is
preserved; only the complete newly exposed flows need a new owner walkthrough.
Stage20 is preparation only. No production cutover, provider approval, live
credential entry, order, external send, security/network change or resource
creation is inferred from these implementation milestones.
