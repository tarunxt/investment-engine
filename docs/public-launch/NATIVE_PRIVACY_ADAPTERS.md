# Native evidence export and quarantined recovery: bounded privacy milestone

Actual implementation starts: native_outbox_export.py at 2026-10-23 22:15:50 UTC; quarantined_privacy.py at 22:21:49 UTC. This follows local runtime/operations candidate 391872ace445bda6b9a1a7495354a5f80912bc9b. These changes are local and outside the pending publication batch ending ad6790f.

## Typed native evidence export

NativeOutboxExport reads eight existing native evidence topics using explicit closed projections and persisted resource ownership: fake connections/acquisitions, durable workflow dispatches, exact approval, basket provenance, fake venue observations, private analysis artifacts and local monitoring. Connection/workflow/intent/leg relationships and immutable hashes are checked before projecting data. It does not adopt a purported owner field from an unknown topic. Venue receipts require one unambiguous owned leg/reference and the existing quantitative receipt/trade validator. Historical records can be exported with the optional module disabled; no read grants work authority.

SQL rejects oversized payloads before JSON driver decoding; row/value/output limits and credential redaction apply. No raw outbox dump, credential decryption, provider call, filesystem traversal or write occurs. PostgreSQL requires a stable repeatable-read/serializable transaction. Unknown topics and shared/opaque stores are not read or assigned to the caller. The result always states complete_account_export=false and complete_account_erasure=false and lists the uncovered store families. This adapter is not installed as a full account export route.

## Replay-safe fixture recovery

QuarantinedFixturePrivacy extends the existing encrypted recoverable SQL workflow through protected restore hooks. Default RecoverableFixturePrivacy keeps its original data-only guard. Only exact known job/module/session/key table shapes and the separately named disposable recovery scope are admitted by the extension. Inherited fences still reject hosted UAT2 and production databases. Existing operator/financial/reconciliation stores without explicit adapters remain held; no generic row restore is enabled.

Restoring the selected executable fixtures cancels pending work, marks old jobs failed/cancel-requested, disables optional modules and pauses schedules, advances the module selection version beyond old work bindings, deactivates prior sessions/keys, and records the existing logout cutoff. Historical data is recovered without restoring authority. These controls, restored rows and their audit marker share the original restore savepoint. Audit failure rolls everything back even if an outer caller subsequently commits. A repeated restore returns its prior control receipt without applying controls again. Other owners and user roles are unchanged. No actual user erasure, permission change or hosted privacy binding was performed.

## Verification and limits

- 82 focused/retained tests passed, zero skips, across the new adapters, original recoverable workflow, SQL planning/deletion/relationship guards and native order composition. A subsequent 12-case focused run passed after adding explicit disabled-module history export coverage. Counts overlap.
- The seven native evidence tests verify resource ownership, tamper/extra-field/oversize rejection, wrong scope, cross-owner separation, historical access and read-only behavior. SQLite execution uses a separate disposable venue file: its exact immutable packet is copied into the read-projection fixture to test the unified outbox layout. That is not unified SQLite execution or PostgreSQL evidence.
- Five new recovery cases verify stopped jobs/sessions, module-version invalidation, idempotency, default-adapter refusal, audit rollback, scope and production denial. Test data and deletion are entirely disposable synthetic fixtures.
- A 12-case zero-skip CI gate is prepared. The existing actual Docker/PostgreSQL/Redis probe now includes typed native evidence export through a repeatable-read transaction; it remains unrun here because Docker is unavailable. Probe compilation passed. No unrun check is marked passed.

Still incomplete: the complete canonical 95-table account-reader/runtime binding, other outbox contracts, opaque/shared blobs, filesystem/cache ownership, operator/execution-store restoration, identity and backup dispositions, and complete reviewed retention. Some require further software adapters; trusted actual-store/retention evidence and external approvals cannot be fabricated. Neither these projections nor successful synthetic erasure/recovery drills constitute complete account privacy or hosted acceptance.
