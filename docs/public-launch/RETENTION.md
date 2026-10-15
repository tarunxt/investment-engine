# Storage retention design and synthetic policy prototype

Status: PREPARATION ONLY. No production writer hooks, migration, deletion,
compaction, schedule or service change. Stage 00 and Stage 01 remain blocked.
The volume stays at 100 GiB. Reclamation of existing archive copies is a separate
review and approval decision; no existing immutable capture is declared disposable.

## Classification at creation

Register ownership and a writer lease before allocating an artifact. Fail closed
if registration or classification is unavailable. Unknown types are Unclassified
and protected; never infer Low priority from age, a failed run or a stopped worker.

| Class | Examples | Proposed retention default |
|---|---|---|
| Critical | Operational state, pending execution, active/retrying/resumable inputs, required recovery copies | No automatic expiry |
| High | Durable user results, decisions, canonical audits, immutable Universal captures, source packs needed for replay | No automatic deletion; raw capture review after 90 days is not expiry |
| Medium | Unreferenced terminal intermediates, reproducible filtered derivatives | 14 days after finalization or last access, whichever is later |
| Medium | Failed-run diagnostics without historical/recovery obligations | 30 days to investigate failures |
| Low | Run page caches | 72 idle hours; refetch is only approximate recovery |
| Low | Build/package caches | 7 idle days, retaining active/rollback artifacts separately |
| Low | Proven abandoned temporary output | 24 hours after writer termination is established |

These durations are proposed operational defaults, not legal retention advice.
Holds, references, leases, recovery obligations and latest-success pins override
all TTLs. Retain the latest successful capture per owner/workflow and all bytes
needed for its promised replay, even if it is older than the review horizon.
Keep durable user-facing results when intermediate detail expires; show an honest
availability marker, never a broken download or a newly fetched historical result.

## Registry and provenance

Persistent implementation requires an Alembic migration and SQLAlchemy models;
none are added by this preparation. Record artifact ID, environment, owner,
workflow/run, producer/version, source provenance, kind, priority and policy
version/reason; creation/finalization/access times; logical/allocated sizes;
format/hash; retention deadline; holds; leases; dependency edges and reconciled
reference counts; recovery category and evidence; logical state; approval and
purge receipts. Identity and finalized digest are immutable. Audit changes must
preserve frozen historical snapshots and the Bullpen audit synchronization contract.

Reference edges must cover run payloads, decisions, canonical audit blobs,
snapshots, exports/downloads, queued and retry tasks, checkpoints, latest-success
pins and source-pack slices. Count every consumer of a shared pack. Cached counts
are insufficient without fresh authoritative reconciliation. An inaccessible
queue, interrupted census or unknown reader is blocking evidence, not zero refs.

Recovery categories distinguish verified byte-identical copies, tested deterministic
rebuilds with retained versioned inputs, approximate external refetch, no recovery,
and unknown recovery. Hash equality alone is insufficient if the retained copy is
unreadable, has missing metadata or is about to expire. External market data can
change; refetch must never be represented as exact historical recovery.

## Lifecycle and approval

Writing -> Finalized -> Expired candidate -> Approved/quarantined -> Purged.
Logical expiry is reversible metadata state and never unlinks data. A future
physical executor must require a separately approved exact manifest and a grace
period (proposed 48 hours). A manifest includes exact paths and IDs, stat identity,
hashes, sizes/allocated bytes, readers affected, retained copies and metadata,
policy reasons, holds/leases/refcounts, timestamp and an approval-bound digest.

Immediately before physical action, atomically reacquire the object lease and
revalidate references, holds, stat/hash, retained recovery and approval scope.
Reject changed evidence, symlinks, path escapes and unexpected link counts.
Release writer/read leases transactionally. Use idempotent batch receipts with
before/after free bytes and explicit failures. Audit logs contain metadata, not
source payloads or secrets. Do not delete source bytes merely because a summary
row survives. No automatic irreversible deletion is authorized by this document.

## Capacity and bounded maintenance

Provisional available-space thresholds: warn below 15 GiB; deny nonessential
generation below 10 GiB; deny additional optional writes below 5 GiB and alert.
Resume optional admission only above 15 GiB. Reserve each job's worst-case output
and scratch space before admission, including archive duplication. Essential
operations also require a bounded reservation; priority does not create capacity.
Inode, memory, CPU/I/O pressure and production latency/error gates apply too.
Validate thresholds against representative production peaks before activation.

Planning caps: Low 1 GiB, Medium 5 GiB, UAT-generated artifacts 2 GiB. High and
Critical growth triggers review/backpressure, never silent reclassification.
These quotas are design values, not filesystem enforcement. Account for existing
usage before enabling admission; reject unavailable metrics. The pure prototype
implements peak-space decisions only, not the resume hysteresis state machine.

Future maintenance should emit bounded hourly dry-run manifests, with at most
100 candidates or 1 GiB per proposal. No timer is installed. Proposed compaction:
one artifact at a time, at most 1 GiB scratch with a reserved free-space floor,
low CPU/I/O priority and a strict time budget; defer artifacts that do not fit.
Keep originals until replacement verification and separate reclaim approval.

Current source-v1 references encode pack identity, byte offset, length and hash.
Whole-file compression breaks those offsets. A new indexed format must preserve
legacy reads and verify every referenced slice. Universal JSONL archives provide
fallback if the primary fails integrity checks; ordinary reads do not regenerate
them. Future capture finalization creates a new archive copy. Removing a verified
duplicate preserves primary history but sacrifices independent fallback recovery.
Hard links preserve paths but also share corruption and are not independent copies.

## Implemented preparation and remaining tests

`scripts/uat/retention_policy.py` is a pure in-memory synthetic registry: it
classifies on creation, rejects production environments, records dependency edges,
and returns dry-run eligibility with `physical_purge_authorized=false` always.
It has no filesystem deletion, network, database, credential or scheduler API.
Its mutable fixture objects are not a production security/transaction boundary.

Run `python3 -m unittest discover -s scripts/uat/tests -v` on the isolated snapshot.
Synthetic tests cover shared dependencies, retries, holds, missing/stale/future
evidence, unknown classifications, TTL/access boundaries, digest mismatches,
approximate refetch versus exact recovery, late reader leases and peak reservations.

Before live integration, additionally test transactional writer/purge races,
crash recovery and interrupted approvals, queue reconciliation, symlinks and path
isolation, corrupt/missing retained copies and metadata, old-reader compatibility,
round-trip slice restoration, enforced quotas/hysteresis, real production health
observations, owner admission and denied cross-environment access. Integrate actual
writers only after the full dependency census and retention contract are reviewed.
