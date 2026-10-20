# Stage04 implementation and verification handoff

Base: owner-accepted/deployed Stage03 a1643521a08ce221512579297ce3724c6d21b24f. Branch: codex/stage04-durable-idempotency-20261020. Full stages/04.md verified exact against unchanged authoritative Library HTML p04. Owner acceptance of03 is recorded separately from its live server/anonymous and local/CI browser evidence; no fresh signed-in UAT2 walkthrough is claimed.

## Durable contract

`IdempotencyOperation` binds authenticated owner + server operation namespace + SHA256(client key), enforced by one database unique constraint. It stores a canonical complete request digest and owned Job ID. JSON keys are sorted; schedules normalize to UTC; full prompt/provider/model/schedule/workflow fields participate. Same key/payload returns the same owned Job at its current state, not a frozen response snapshot. A changed payload returns409; identical keys across owners or operations remain independent. Keys contain1–200 characters, are case-sensitive, and have **no automatic expiry or reuse**. A terminal failure/cancellation still replays that same Job; a deliberate new operation requires a new key. Missing/corrupt/foreign result binding fails closed409.

PostgreSQL uniqueness arbitrates creation in a savepoint. The losing provisional Job/outbox rolls back; no provider dispatch occurs before commit. A five-second transaction-local uniqueness lock timeout returns409/in-progress; retry the same key. No key means deliberately independent work, with no shared prompt-prefix lock. Provider configuration is checked only for new creation so an existing owned replay survives provider unavailability.

Migration `tenant_idempotency_001`, after `recommendation_audit_001`, adds the binding table and `outbox.available_at`/`execution_attempts`. Existing Jobs/outbox rows are preserved; legacy rows get null/zero delivery fields. No existing revision, ownership registry, identity or provider key is replaced. Downgrade removes these additions and loses new bindings; operational rollback must use the existing verified schema/data/application backup contract, not source reversal alone.

## Dispatch, retry and uncertainty

New CreateJob operations write exactly one `job.created.v2` row in the same transaction. The API never also publishes directly. Existing outbox rows/topics remain quarantined and are not automatically replayed; legacy Redis `idem:*` records are never trusted/imported/deleted. Historical keys with no durable binding cannot be certified across cutover or lost legacy cache state; do not replay historical uncertain work automatically. Review legacy in-flight work separately before any later production cutover. No migration re-enqueues it.

The existing general Celery consumer lifecycle now has a bounded parent relay: batch10, poll5seconds, dispatch retry30seconds, bounded DB/broker timeouts. Due future jobs remain in the database until their schedule. Failed or ambiguous publishes are retried; `published_at` on v2 is the latest dispatch claim, not proof of worker receipt. SQL CAS prevents two relays claiming the same publish interval.

Versioned deliveries require an owner-bound outbox reference and acquire a dedicated PostgreSQL transaction advisory lock across ordinary worker Job commits. Concurrent duplicates stop; terminal redelivery stops. Execution attempts persist separately from broker publication count. Classified retries use only the durable outbox, preserving backoff and attempt number across fresh Celery task IDs/Redis loss; new delivery cannot reset the existing three-retry budget. An interrupted attempt is recoverable after180seconds; four interrupted/admitted attempts exhaust to a failed owned result. A still-running consumer keeps the database lock, so watchdog duplicates do not charge attempts or run it twice.

This provides one durable logical operation and at-least-once delivery, **not exactly-once external provider effects after an ambiguous crash/network partition**. Existing run/operator direct producers retain their existing contract; they are not relabeled as client-key-idempotent APIs. Financial-order deduplication remains Stage14, and public Bullpen execution remains closed.

## Checks actually run

- Real PostgreSQL/Redis Docker gate:11 passed. It exercises20 concurrent equal requests, concurrent conflicts, owner/operation independence, owned replay, UTC digest equivalence, failed transaction rollback, held uniqueness timeout/retry, old binding age/no expiry, terminal error replay, same-prefix unkeyed requests, lost postcommit response, competing relays, actual Redis process stop/restart and accepted queue loss, two real Celery deliveries through the production guard, scheduling/legacy/foreign rejection, crash lock release and durable backoff/attempt exhaustion. Redis and provider execution are isolated synthetic fixtures; the provider body is fake. Crash windows are controlled fault injection at database/consumer boundaries, not a live paid-provider crash test.
- The historical API-attempt forward-head gate initially rejected the two intentional outbox columns. Its verifier now permits only those exact definitions and null/zero legacy state; nine safety tests reject other additions, changed prior values/types/indexes or unsafe defaults. Its actual guarded Docker named-migration roundtrip, full forward chain to tenant_idempotency_001 and repeat-head upgrade passed. Environment/URL/container guards are unchanged; no existing test was removed.
- Final migration upgrade/downgrade/re-upgrade passed inside the backend Docker container, preserving prior schemas/data except its explicit additive outbox columns and preserving legacy outbox values. The actual PostgreSQL unique constraint was exercised. No host Alembic or live migration occurred.
- Ownership/stream/recovery/lock/usage/Google/UAT2 regression receipts and native/shared configuration results are recorded in evidence/stage04-local-checks.json. A nonexistent web-search test filename caused an initial zero-test invocation; it was corrected using repository file discovery. The logger-capture failure reproduced on unchanged Stage03 and was isolated in its test without weakening the privacy assertion. No unrun invocation is counted as passed.
- Actual Next Webpack build and localhost direct/BFF/stream checks passed. Stage04 eight-request HTTP race, same-key replay, conflict409, A/B known foreign404, and fake outbox completion passed. PostgreSQL distributed guarantees are from Docker/CI, not SQLite preview.

Frontend source is unchanged. The broader Stage03 frontend suite had12 reproduced inherited Bullpen/operator failures; no whole-suite green claim is made or release gate waived here. Selected CI frontend/runtime checks still apply.

Exact-head CI and retained native artifact must pass independently after publication. A new mandatory PR-only Docker gate runs the full migration and real-service contracts with no skips. Existing gates/budgets remain unchanged. Production deployment triggers were inspected before publishing: main-only; fixed inspection push branches differ; operational workflows otherwise require manual dispatch. No manual operational workflow is requested.

## Actual local preview

URL http://localhost:58519/console/jobs ; API http://127.0.0.1:58520 . Frontend PID95012, backend PID95011, started20 October2026 08:54:37IST (03:24:37UTC) (PID stamps in state.json are authoritative). Real Next/FastAPI/auth/Job/idempotency/outbox code runs against the isolated synthetic SQLite backup. Fake Redis streams and an offline fake consumer are explicit preview adapters; socket egress is denied. It creates no real email/provider/order/paid-AI action. No new frontend or imitation application was added.

From `/Users/tarunsingh/Documents/Codex/2026-10-19/task-5/stage04-durable-idempotency`:

```sh
.runtime/python/bin/python scripts/public_launch/preview.py stop
.runtime/python/bin/python scripts/public_launch/preview.py start
.runtime/python/bin/python scripts/public_launch/check_stage04_preview.py
```

Build selects unused loopback ports; start reuses its compiled URLs and refuses busy ports. Existing fake accounts are usera/userb@stage01.example.com with the pre-existing synthetic password SyntheticPreview123!. B sees Stage04 job5, A job4, and each owner's earlier completed fixture. B's known A job4 shows Job not found; B job5 shows the labelled offline result. Refresh must retain one Stage04 job despite repeated requests. Re-running the protocol check deliberately uses a fresh synthetic key and adds a separate pair of jobs. These are local review routes, not deployed UAT2 routes.

## Independent acceptance and UAT2

Code/local checks, exact CI/artifact, deployment, staging verification, independent acceptance, owner acceptance and external approvals are distinct. The existing separate UAT2 task independently reviews the exact diff/CI/artifact and deployed behavior. Implementation checks here do not establish independent acceptance. Supply precise final SHA, manifest/ZIP hashes and receipt paths; parent/existing executor rechecks current READY and unchanged limits before transfer/migration/deployment.

UAT2 still mounts read-only real Job/Run handlers and denies mutations/WebSockets; do not open live multi-user paths to manufacture acceptance. No fresh signed-in UAT2 browser walkthrough is claimed. Stage05 waits for independent checks and a new owner review. Production, owner-only access, simulations, credentials/security permissions, infrastructure, US$10 total and stop21 October2026 21:04:13IST remain unchanged.
