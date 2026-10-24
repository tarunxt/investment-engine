# Disabled native profile-restore source contract

Local successor to342fea0628c53f85d9f454e865c814f69d3de48b. No native controller,
startup unit, security/retention setting, key or deployed source was modified.
Real deletion and native activation remain disabled. This work is not published.

## Implemented narrow scope

native_profile_restore_contract.py is pure: no filesystem/database/network I/O,
executor, native command, configurable activation flag or service-start grant.
It produces bounded synthetic plans for the actual UserProfile source schema and
only avatar_url, bio and google_sheets_master_url. Unknown stores, including
outbox, credentials, financial records, Redis and file stores, block the plan.
A full native database therefore remains outside supported scope.

A synthetic independent ledger head is provided separately from the raw snapshot.
It binds lineage, sequence, complete profile coverage, tombstone digest and exact
principal bindings. A subject UUID is supplied by the trusted fixture; it is not
guessed from an email or numeric ID. The fixture binds the complete user-anchor
row by hash and proves foreign rows are not updated. Stale/rolled-back/missing/
incomplete ledgers, duplicate identities/events and unsupported fields are held.
An empty ledger requires an explicit matching independent head and coverage.

The raw snapshot fingerprint must verify before projection; native full-database
schema/catalog verification is not replaced by this narrow fixture fingerprint.
The plan binds both raw and expected post-projection hashes. Checkpoint inspection
is verification-only: a matching committed post-state may be verified after a
simulated interruption; raw/unstarted state remains blocked, and indeterminate or
partially changed state requires review. Inspection never reapplies a projection
or restores a snapshot. Receipts always deny native activation and complete
account erasure.

## Tests and honest evidence limits

39 new tests use actual User/UserProfile models in fresh two-table pytest SQLite
files. Test-only SQL writes live only in the test module. Tests cover preserved
foreign/settings/timestamps, SQL-observed owner-only updates, raw integrity,
identity reuse, foreign tombstones, role/credential-anchor changes, unknown stores,
empty-ledger proof, simulated crashes before apply/inside transaction/after commit,
verification-only replay and rejection of partial or foreign post-state.

The combined new and affected policy/planning/recoverable/quarantine run passed
111 cases, zero skips (credx-native-profile-contract-regression.xml). Six source
baseline tests also passed, zero skips (credx-native-profile-contract-baseline.xml). These overlap prior privacy evidence and must not be added
to earlier totals. Independent review ran the initial35 cases and found no
concrete authority/replay defect; final independent review reran all39 and
verified the additional identity-anchor and owner-write assertions without a new
concrete issue. No actual pg_dump/pg_restore, Linux/systemd restart,
process-durable journal, live database or host test ran for this successor.

The synthetic head is an explicit test trust input, not an implemented authority
service. Digests bind content; they do not authenticate an independently supplied
head. The fixture keeps its head/checkpoint outside the simulated restored SQL
snapshot, but does not prove fsync, cross-process durability, anti-rollback storage
or protection if the head itself is rolled back. No live storage path, key,
permission scheme, tombstone issuer or completeness authority was chosen.

## Remaining native gates

A future separately reviewed integration must supply authoritative non-rollback
ledger persistence, stable principal/lineage mappings and complete relevant-copy
inventory. Principal refs/hashes remain linkable metadata; no anonymity or legal retention
approval is inferred. It must retain the existing raw-backup verification and separately
verify post-suppression state, with crash-safe receipts and no blind destructive
retry. Rollback/recover/start and direct unit startup need an enforceable barrier;
old target releases must not remove it. Unsupported targets and executable,
financial or credential authority remain blocked. No deployed availability or
security behavior is changed by this local contract.

Native preserved-material JSON, database dumps, Redis queues/caches, email sinks,
opaque blobs, proxy state, frontend caches and journals still require their own
ownership, retention and restore dispositions. The reported host sizes/copy count
are point-in-time observations, not proof of complete inventory or legal duties.
The selected30-day design does not establish those facts or authorize cleanup.
Full native restore suppression, full export/erasure, legal applicability and new
owner acceptance remain unresolved.
