# A11-005 qualified restore acceptance

Status: Open. Synthetic tooling/design implemented; historical equality unknown.
This extends the existing backup/recovery coordinator's acceptance contract. It
creates no backup, restore cluster, snapshot, production connection or resource.
A11-006 owns inventory/retention objectives; this change sets none.

## Retained evidence and limitations

The delegated aggregate record reports successful PG18 replay, 83 tables and
533,713 rows; these counts are not equality proof. The same-snapshot comparison
failed with ProgramLimitExceeded. Its original 14:58:21 UTC snapshot was rolled
back. Later live queries cannot reconstruct it. Owner/ACL replay was excluded.
The temporary cluster was stopped. These are separate historical facts, not a
failed restore and not full disaster-recovery readiness.

Private status.json, restore-status.json, checksum and original operator receipts
are not available in this checkout and were not read or independently verified.
No fabricated receipt is supplied. An authorized evidence custodian must privately
verify archive identity, checksum, timestamps, replay exit/counts, failure history,
no-owner/no-acl flags, access isolation and stopped-cluster receipt. Keep only
opaque evidence references and aggregate statuses in shared records. Preserve the
original encrypted archive bytes/hash, private permissions, failed attempts and
stopped cluster. Do not copy rows, role names, grants or credentials into reports.

## Minimal independent helper contract

`scripts/recovery/acceptance.py` uses only Python's standard library, imports no
application code and has no I/O adapter. There are no changes to shared schemas,
API, runtime, providers or existing backup tasks.

An authorized future adapter supplies canonical fields as type identifier,
byte length (or SQL NULL), and nonempty byte pieces of at most 64 KiB. Type IDs
are bounded at 256 bytes and rows at 4096 columns. The helper hashes each field
incrementally with unambiguous type, NULL, length and column-count framing.
Chunk boundaries do not affect the row hash. The producer must enforce streaming
at the driver boundary; allocating a huge field first does not meet this contract.

Externally sort the fixed 32-byte row hashes by unsigned byte order using a
bounded-memory sorter and authorized private scratch. Preserve duplicates.
Stream the sorted hashes into `table_digest`; decreasing input is rejected.
This gives a table count and a domain-separated digest without whole-table string
aggregation. Empty tables must appear. Sorting by digest avoids key uniqueness,
collation, NULL-ordering and tied-key row-order ambiguity. SHA256 collision
resistance is an explicit probabilistic assumption, not mathematical identity.
A future sorter must bound memory, scratch space and runtime and stop on limits;
no sorter or scratch-file operation is implemented here.

## Canonicalization and complete coverage design

Before any real exercise, implement and review a versioned allowlist adapter with
fixtures for every actual column type. Unsupported types fail closed, never fall
back to Python repr or locale-dependent text. Compare PostgreSQL major version,
server encoding, canonicalizer version and extension versions before rows.

- Text: exact UTF-8 code points, no Unicode normalization; bytea: raw bytes.
- Integers/boolean: canonical decimal ASCII / fixed true-false byte convention.
  Numeric: exact coefficient/exponent normalization including signed zero,
  NaN and infinity rules explicitly versioned. Float: fixed IEEE encoding with
  explicit NaN and signed-zero policy. No unreviewed coercion between types.
- Dates/timestamps: fixed precision/epoch rules, separate timestamp/timestamptz,
  UTC for timestamptz, explicit infinity/BC handling; intervals preserve months,
  days and microseconds separately. UUID uses fixed bytes.
- JSON and JSONB: separate semantics; preserve JSON text if text equality is
  required; JSONB requires deterministic recursive object-key ordering and exact
  numeric semantics. Arrays include dimensions/lower bounds and element NULLs;
  enums, domains, ranges and composites include stable qualified type identity
  and recursive framing. Extension types need explicit reviewed codecs.

These codecs are a design prerequisite, not implemented PostgreSQL equality.
Field tests below validate framing/streaming only.

Schema evidence must cover the full object inventory and normalized definitions:
columns/order/types/defaults/generated/identity, constraints, indexes, partitions,
views, routines, triggers and relevant settings; remove only pre-agreed volatile
metadata. Include schema migration version and canonicalizer/schema version.
Do not compare cross-major/extension changes without an approved semantic plan.
Sequences require exact last_value/is_called, bounds/increment/cache/cycle and
ownership dependencies tied to the snapshot exercise; ordinary MVCC snapshots do
not freeze sequence mutation, so a separately approved quiescence/capture plan is
required. Extensions require name/version/schema and dependency compatibility.
Large objects require complete inventory, lengths and streamed content digests,
including unreferenced objects and empty objects; ACLs remain a separate dimension.
Absence must be positively evidenced as empty, never assumed from missing data.

## Same-snapshot and result gates

A custodian must privately attest that the source manifest was captured from the
exact snapshot underlying the archive and the restored manifest from that same
archive checksum. Include complete opaque table inventory and all metadata
digests. Matching strings alone cannot establish provenance. The helper rejects
lost snapshots, absent pair attestations, different snapshot IDs or archive hashes
as `unknown`. Missing coverage is `partial`; incompatible canonicalizer or actual
mismatch is `error`; only complete matching data/schema evidence is `pass`.
Persist chunk progress privately if needed, but exclude transport chunk boundaries
from equality. Retries must restart or verify immutable stream position; never
silently stitch different snapshots. No new snapshot may close the historical gap.

## Separate privilege and application contract

Before execution the owner must approve full recovery or explicitly narrow the
contract in a retained decision, specifying excluded dimensions and consequences.
The helper has no narrow-scope bypass. Privilege recovery requires a separate
private minimum mapping of service identities, ownership, schema/table/sequence
access, routine execution, membership and default privileges, plus required
extension capabilities. Use least privileges already approved for the application;
do not invent roles, grant broad access or export names/grants. Test necessary
allowed operations and denied operations with isolated identities, never live
grants. Credentials must be injected by the existing approved secret mechanism.

Application acceptance separately requires an approved isolated startup/config
check, migration-version compatibility, authenticated read/write/transaction
rollback checks for required workflows, and inspection of startup errors. Keep
mail/export/provider/trading paths disabled, Beat empty, remote control disabled
and the four financial workers stopped. Define success/time bounds with the owner
before the drill; do not infer operational RTO/RPO. Replay, data/schema equality,
privileges and application each retain independent pass/partial/error/unknown
and private evidence references. `recovery_status` cannot pass on replay alone.

New consistent snapshot, archive reuse, restore/start, scratch storage, grants,
application drill or paid resources require separately specified authority. This
implementation does none of them. Closure also needs authorized acceptance and
independent read-back of the exact integrated artifact. No live closure claimed.

## Synthetic verification / stable finding substeps

Run `python -m unittest discover -s scripts/recovery -p 'test_*.py' -v`.

| Substep/test | Evidence / remaining gate |
| --- | --- |
| .01 private receipts | unavailable locally; aggregate history qualified above |
| .02 bounded comparison | streaming field/row/table helpers; no DB adapter |
| .03 / T01 canonicalization | type/NULL/boundary/duplicate tests; 32 MiB value at 1 KiB/64 KiB pieces gives same hash; 200,000 streamed row hashes; traced peak under 512 KiB each; PG codecs remain gated |
| .04 / T02 provenance | mismatched/lost/unattested snapshot and wrong archive tests return unknown |
| .05 / T04 privileges/app | independent contract above; synthetic status tests only; drill unexecuted |
| .06 sensitive scope | no I/O, production or restore execution |
| .07 preservation | no archive/cluster/receipt changes; custodian read-back pending |
| .08 / T03 qualification | complete matrix passes; missing evidence stays partial/unknown, mismatch/error separate; live closure pending |

Tracemalloc measures Python allocations in the helper, not an unimplemented DB
driver, sorter or PostgreSQL server. Tests use only generated bytes and opaque
synthetic provenance. No real payloads or private evidence are fixtures.
