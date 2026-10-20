# Stage10 local successor — review corrections and CI plan

Original reviewed candidate `0f026ee54a5e7ee70c03249830d7e67cfc5d25ac` remains immutable in Git, with its original evidence JSON/handoff retained. This local successor addresses the four review findings; independent re-review and actual CI are still pending. No push, trigger, deployment, live database, AWS, credentials or permission change occurred.

## Controller and schema recovery

The existing controller now accepts provenance-checked backups at the exact supported Stage08/09/10 revisions. Backup checks retain private regular-file ownership/mode, dump hash, source manifest hash, timestamp, deployment receipt and matching recovery-marker reference. Stage10 normally restores a fresh Stage09 backup: inspect exact revision; preserve all current connection, encrypted credential, attempt and append-only binding-history rows privately; record marker; downgrade exactly `connection_attempts_001` to `integration_connections_001`; transactional restore; exact full-state fingerprint verification; configure/promote; bounded readiness; clear marker. A Stage10-to-Stage08 jump is rejected.

A same-schema Stage10 redeploy restores its own Stage10 backup without downgrade, preserving current private material first. Same-schema Stage09 recovery also preserves current private material. Unknown or partial schema, wrong baseline, missing/corrupt preservation, restore/verification/promotion/readiness failure stays stopped with marker retained. `recover-rollback` verifies the already-restored state and never repeats a possibly committed restore. Existing Stage09-to-Stage08 behavior and pointer collision protections remain covered.

Stage10's unpublished migration now adds both `connection_attempts` and `connection_binding_history`. No deployed migration was rewritten: Stage10 has never been published/applied. Before cleanup both tables and the Stage09 connection/credential rows are exported with ciphertext intact into private preservation artifacts. Recovery does not blindly re-import post-backup tokens. Reconciliation or key retirement must account for retained private history and key versions; no key retirement or credential action is performed here.

## Account history correction

Before replacing a verified binding, including FAKEA→FAKEOTHER under the same connection ID, the service appends owner/connection/version/app-mode/account plus the original encrypted envelope/key-version. Existing snapshots are never updated/deleted by the service and have no public write/read credential endpoint. Explicit account review, version CAS and module/work invalidation remain required. Two-mode tests verify original identity/ciphertext survive later authorizations. A failed commit rolls back both candidate changes and new snapshot. Disconnect and explicit revocation retain a prior binding snapshot; unadopted legacy local disable remains supported.

This is append-only application behavior, not a claim that a database administrator cannot alter the database.

## Browser correction

Non-simulation reconnect uses the validated returned `login_url`; only the documented HTTPS Kite origin/path is accepted. The returned query is parsed once, duplicate/missing fields rejected, request-token query removed before callback POST, and explicit masked account/mode review required. No request token is put into persistent browser storage.

For local acceptance, the preview explicitly selects the same navigation/return path using a same-origin `/preview-kite` page. That page returns404 unless `STAGE01_PREVIEW=synthetic-only`; synthetic navigation cannot fall back to real Kite. Actual Chrome passed user-owned and managed navigation→fake authorization→returned-query callback→review→confirmation, with query removal. Real transport wiring/credentials, registered callbacks, provider approval and real login/revocation remain disabled/pending. Provider approval alone does not activate any runtime factory.

Current local URL: http://localhost:53571/console/profile/connections, API53572. Same build/start/foreground Ctrl-C instructions in STAGE10_PREVIEW.md apply; future rebuild allocates new free ports. Ctrl-C in this task's foreground launcher stops only its directly owned children; the current handle is recorded in the local successor handoff. Earlier53082 preview is stopped, historical Stage09 previews/live services are untouched.

## Frozen Stage09 strategy — no weakened guard

The historical restore-rehearsal and19-case controller matrix check out exact accepted `ccb0b3c4682d6bc65c4b38ccf95e71a446dee117`. Their source files, frozen runtime allowlists and assertions are unchanged. Workflow names/artifacts explicitly say historical/ccb0b3c4; requested Stage10 SHA in artifact suffix labels invocation, not tested runtime. Historical verification receipt must identify ccb, while its unchanged frozen runtime source remains3395476c09e4f0257b99b788f594d4c542769711; both identities and all19 zero-skip cases are explicitly checked. These checks remain required; they are not skipped, widened or relabeled as Stage10 runtime evidence.

The Stage09 named additive migration regression now targets its named `integration_connections_001`, not mutable head; original snapshot/ciphertext/rollback assertions stay intact. Its previously rejected Stage09 backup revision is now valid for the intentional extension; local provenance tests instead reject an unsupported future revision, while the historical job still executes original ccb tests unchanged.

## New current-head acceptance matrix — PREPARED, NOT EXECUTED

- Exact-head backend Docker/PostgreSQL16 job:26 authorization cases plus3 actual PostgreSQL tests; at least29 total, zero skips. Both modes execute full parallel callbacks using separate async sessions; exactly one exchange wins. Actual Alembic upgrade/downgrade twice preserves Stage09 data and encrypted material. Migrations execute only inside the disposable backend container.
- Exact-head Linux/systemd/PostgreSQL16 matrix:20 cases, grouped core5/interruption4/finalization4/provenance7. Reuses the proven Stage09 fixture approach as a separate Stage10 harness; original historical harness is untouched. Real candidate ctl/helper/migration/unit source is byte-verified against requested SHA; Stage09 baseline is pinned to ccb. Fresh native PG dumps, preservation, confined migration, transactional restore, interrupted/failed rollback, verify-only recovery, promotion/readiness failures, result provenance and same-schema redeploy are covered.
- All20 controller cases use real controller/helper and migration service. Backend/frontend/worker/proxy/cert/Redis service processes are declared synthetic fixtures; no live application/browser acceptance is inferred. The VM guard requires root Linux/systemd, exact CI acknowledgements, clean exact-head runner checkout, Stage09 ancestry and absent production paths; its child environment does not inherit cloud/provider credentials.
- Workflow checks receipt runtime/verification SHA, exact Stage09 baseline/revisions, exact group counts, failure0/skip0 and declared fixture limits. Failure diagnostics are retained separately.

Local results:93 focused backend tests,19 frontend/component/navigation tests,56 actual controller/helper boundary regressions,4 Stage10 harness guard tests and8 preserved Stage09 rehearsal safety tests pass. Real Next production build, source inventory, syntax and duplicate-key-rejecting YAML/pin checks pass. Actual PostgreSQL/Linux matrix/CI/native artifact, independent review, any external publication, UAT2 deployment/verification and owner acceptance remain PENDING. Stage11 excluded.

Publication plan: parent first reviews this successor and frozen/current CI separation. Only with explicit publication scope, recheck remote/base/triggers, push the exact successor to a separate draft Stage10 PR based on verified Stage09; never update PR1251 as Stage10, push main, dispatch production or relabel old artifacts. Actual CI and native package audits must then pass before any separately approved deployment. No deployment readiness claim here.
