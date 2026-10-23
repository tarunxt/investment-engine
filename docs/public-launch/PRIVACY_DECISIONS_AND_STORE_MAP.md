# Privacy decisions and source-backed store map

Local successor to 6537ae4; no runtime activation or actual deletion. The saved
Stage 17 specification line 38 requires owner-only export/deletion with retention
controls, safe synthetic sinks and encrypted backup/restore/key-rotation drills.
It explicitly makes unresolved legal retention choices launch gates. Lines 12–18
preserve production separation and existing runtime/budget/retention limits.
Stage 20 is preparation, not permission to cut over.

## Only decisions actually needed

No decision is needed to continue safe local adapters, deny real effects, preserve
unknown orders, retain credentials from generic restoration or keep incomplete
erasure blocked. Those requirements already follow the saved specification and
the user's explicit boundaries. No legal deadline or new erasure authorization
can be inferred from them.

| Decision | Options and consequences | Required evidence |
| --- | --- | --- |
| Dataset retention/holds | Supply a reviewed per-dataset schedule (durations, trigger, legal-hold precedence and audit purpose), enabling a concrete future policy; or keep deletion held, leaving public deletion completion unavailable. No period is selected here. | Actual applicable policy and authorized approval; the source schema alone is insufficient. |
| Identity disposition after eligible erasure | Retain the minimum documented identity/audit anchor with credentials revoked, which remains partial erasure; or specify reviewed anonymization/unlinking semantics and required schema changes, which need further implementation and validation. Neither option authorizes executing real erasure now. | Which identifiers must remain for financial reconciliation/audit, which must be removed, and why. |
| Backups after erasure | Specify actual finite expiry plus restore-time suppression, which delays final completion until expiry; or propose independently scoped cryptographic erasure, which first requires proof of per-account key isolation. Existing shared keys must not be destroyed to erase one account. Keeping backup policy unresolved keeps full erasure blocked. | Inventory of backup copies/destinations, current expiry and restore/key lifecycle. |

These are future policy decisions, not a request to change security or erase user
data. Provider approval, residency evidence and owner acceptance are separate
external gates and cannot be satisfied by selecting a retention option.

## Source-backed store ownership

| Store | Actual source construction | Implemented disposition / exact gap |
| --- | --- | --- |
| Canonical SQL | 95-table source inventory and principal/FK paths | Bounded canonical SQL export with relationship preflight; shared controls/blobs handled separately. No complete account claim. |
| Eight native outbox topics | NativeOutboxExport closed resource/provenance validators | Typed owned projections; no raw payload dump. |
| Consent/privacy/local monitor | support.py, privacy.py, monitor_dispatch.py | New PublicOutboxExport validates immutable seals/request receipt and existing typed monitor identity; withholds tickets, request keys, results and sinks. |
| Job/module history | job.created.v2 and modules.selection.changed.v1 / modules.schedules.resumed.v1 | Exact owned Job and persisted selection-header checks. Source prompts and task arguments are not exported. |
| Operational queue | dispatch.SyntheticWorkBindings resource binding | Export recomputes the binding from owned Job or confirmed intent/approval event; no current-policy bypass, execution or queue mutation. Historical records whose authoritative resource changed remain held. |
| Encrypted privacy plans/effects/recovery archives | sql_privacy_plan.py, sql_privacy_workflow.py, recoverable_privacy.py | New keyring-injected authenticated metadata reader checks owner, request receipt, deterministic packet ID and existing hashes. Plain archive contents and credentials remain withheld. Oversized packets fail closed. No key is fetched or created. |
| Module task locators | modules/dispatch.py stores request digest and module identity, not original args/resource locator | Held for resource-complete export; original arguments cannot be reconstructed from their hash. Future producer contract can add a typed authoritative locator; old rows cannot be backfilled by guessing. |
| Residency/review consent | reviewed_residency.py / residency.py encrypted evidence; consent has no SQL principal column | New authenticated historical metadata validates decrypted owner, deterministic evidence ID and linked consumed consent with matching policy/type. Unlinked consent cannot be located safely by SQL principal and remains held; expired history never grants eligibility. |
| Signup/global control | signup_perimeter.py / store.py | Shared quota/identity/control material remains retained. Signup hashes are not automatically an account-owned record. |
| Synthetic account fixture | account_data.py | Existing declared-fixture adapter exports only its synthetic inventory. This never proves coverage of actual account stores. |
| Generated XLSX | export_jobs.job_key(owner, run, scope), export_tasks exact hash.xlsx target | New caller-directory-FD adapter enumerates only SQL-owned run keys and scopes all-scanned/filtered, rejects symlinks/hardlinks/nonregular files, caps total reads at 8 MiB, returns hashes/sizes only. Cached path strings are ignored. Actual deployed directory descriptor/inventory has not been supplied. |
| Scan source packs | scan_source_store.py random pack identity and offset/hash reference nested in market source data | Not a direct principal column. Complete reference graph and actual deployment root are needed; do not scan/delete or infer ownership from a pack filename. |
| Scan page cache | scan_page_cache.py hashes run_key and query into sibling scan-pages-v1 | Need exact owned run_key provenance and deployed root. No recursive filesystem traversal performed. |
| Temporary XLSX | stage_one_excel.py NamedTemporaryFile; router download BackgroundTask removes it | Download cleanup is source behavior, not proof no orphan exists. Need actual temporary-store inventory/ownership manifest; no arbitrary path accepted. |
| Job task registry | messaging/task_registry.py celery:job-task:integer | Existing exact SQL-owned-key reader with UUID values; no wildcard scan/revoke/delete. Redis observation is not atomic with SQL. |
| Market/dashboard cache | cost_drivers/cache.py cost-drivers:v2, service.py month:mock/live | Shared month/environment keys have no owner component; never erase as one account's data. Other Redis namespaces need individual mapping. |
| Deployment backups | native controller backup manifests and disposable smoke pg_dump/pg_restore | Source drills exist; actual live copies, expiry and suppression evidence remain unavailable. No server route was used. |

## Financial recovery boundary

StoppedFinancialFixturePrivacy covers confirmed intents, legs, execution runs and
attempts only in the exact disposable scope. It retains connection/credential and
shared stop stores, proves intent-to-connection owner and attempt-to-leg intent
relationships before deletion and inside restore, then persists only the owned
owner/connection/account stop keys. Unused approvals become invalidated; in-flight
state, original approval, quantitative fills, poll counts and receipts remain for
read-only reconciliation. No platform/other-owner stop changes or authority reset.
All rows, stop controls and final audit share the inherited restore savepoint.
A final audit failure rolls back both rows and stops even after outer commit.

Other financial systems (spend reservations, legacy live positions/orders and
operator state) remain retained/held. They must not be restored through a generic
row adapter. Safe system-wide retirement needs exact reservation settlement and
external-order reconciliation semantics, not fabricated rejected fills or reset
spend balances. This is locally incomplete implementation, separate from legal
retention and runtime approval gates.

## Verification and completeness at this successor

Work started at 2026-10-23 22:43:08 UTC (Git successor checkout). Independent
review reproduced and prompted fixes for (a) a foreign connection stop through a
corrupt owned intent reference and (b) arbitrary unsealed outer state escaping an
encrypted packet projection. Both have focused regressions and reviewed repairs.
The combined retained/new suite passed 95 cases, zero skips; 31 cases form the
updated exact privacy CI gate. Receipt: `credx-financial-reviewed-final.xml`.
These are overlapping counts, not additive. Inventory has 55 export entries and
zero unresolved source entries. Counts do not establish full implementation.

Locally implemented/tested: selected confirmed-order stopped recovery, owned
relationship preflight/restore checks, final-audit rollback, closed projections
for seven public-service/worker topics, authenticated metadata for five encrypted
topic classes plus linked consumed consent, exact generated-file metadata and
canonical composition with optional explicit scope/keyring/cache/directory
bindings. No public route, real-key acquisition or erasure activation was added.

Locally incomplete: resource-complete historical module task locator export,
unlinked consent discovery, raw opaque blobs/files, scan-source/page ownership
resolution, legacy financial/operator/reservation recovery, and the complete
native browser walkthrough on this candidate. These are not secretly counted as
complete because a typed metadata projection or a test passed. Unknown stores
continue to hold account completion. Preserved immutable old task digests cannot
reconstruct lost arguments; new contracts cannot fabricate their history.

Evidence/approval/runtime gates: actual deployed file/cache/backup inventory,
reviewed legal/identity/backup decisions above, publication approval and exact
candidate CI, actual disposable PostgreSQL/Redis results, safe UAT2 deployment
and new owner acceptance. SQLite full-model canonical export correctly rejects
its physical-schema mismatch; the prepared PostgreSQL composition check remains
unrun on this executor. No production/UAT2 server operation or remote write took
place. Existing checkpoints ad6790f, 4b6ede0 and 6537ae4 remain unchanged.

## Selected spend-ledger successor (started 2026-10-23 22:56:03 UTC)

HeldSpendFixturePrivacy now adds exact disposable recovery for recommendation
spend accounts, attempts and verifications. It preserves spent/reserved/cap and
quantitative receipt values; no refund or settlement is invented. Queued attempts
become cancelled; started/reserved/uncertain attempts become cancelled_uncertain.
Verification dispatch is disabled, leases cleared and claim fences advanced;
queued/processing verifications are cancelled. Module versions rise above old
attempt versions and stay disabled. Platform sentinel and other-owner balances
remain unchanged. Foreign account references and invalid amounts are held before
deletion; the existing source application-reference validator remains mandatory.

Four focused new tests pass (actual source models, SQLite only), including final
audit rollback after outer commit. The affected budget/governed-job/recovery and
ownership regression run passed 142 cases, zero skips
(`credx-held-spend-regression.xml`). Independent review found no verified authority
revival or financial inconsistency and ran 25 overlapping focused tests. These
counts must not be added together or treated as PostgreSQL concurrency evidence.
The native privacy CI gate now contains 35 tests; no remote run was triggered.

This closes selected internal spend recovery implementation, superseding the
older blanket statement that all spend reservations have no adapter. Actual
uncertain costs still require authoritative settlement evidence. Legacy live
broker positions/orders and operator state remain unsupported by generic
restoration. Full account export/erasure, runtime binding, deployment, and owner
acceptance remain incomplete. Three exact policy decisions above remain gates.
