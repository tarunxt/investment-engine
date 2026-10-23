# Local privacy and restart review successor

Status: LOCAL ONLY, not published, installed or owner accepted. Work began on a
new successor branch at 2026-10-23 22:36:02 UTC (Git checkout reflog). Existing
checkpoints `ad6790fa691d77378a7b75c4a518f7369f55e143` and
`4b6ede01a616d1d7ee919341f3595c5ee1205e0b` remain unchanged.

## Independent review and repairs

An independent internal reviewer inspected the actual application bindings,
exact confirmation, fake execution, typed export and quarantine code at 4b6ede0,
and reproduced two defects using disposable fixtures:

1. Dispatch could commit its one-use run claim and die before its first attempt.
   The relay inner join omitted that run and explicit reconciliation left it
   submitting forever. The relay now includes runs with no attempts. Under the
   existing account/intent locks, reconciliation invalidates a submitting run
   only when every leg is draft and no attempt exists. It never resumes or
   resubmits the consumed approval. A fresh human-reviewed intent is required.
2. The generic data-only recovery allowlist included API keys, restoring active
   credential authority unchanged. Keys are removed from that allowlist. The
   existing exact quarantined adapter must revoke restored keys; unsupported
   schemas remain held before deletion.

The reviewer inspected the first repair's lock ordering and found no introduced
resubmission path. This is code review and SQLite reproduction, not an actual
PostgreSQL concurrent-race result. Review did not certify hosted behavior.

## New bounded adapters and recovery coverage

`CanonicalAccountExport` composes the complete source-model SQL inventory and
relationship preflight, canonical SQL reader, owned execution-control projection
and audit-blob reference projection in the caller's transaction. PostgreSQL
requires a repeatable-read or serializable snapshot. No HTTP route or runtime
activation is added. Combined output is bounded to 8 MiB. Credentials remain
withheld according to the canonical reader's explicit rules; arbitrary unlabeled
secret prose is not claimed detectable.

Audit blobs are resolved only through physical source foreign keys and proven
principal paths. Raw blob payloads remain withheld even for exclusive references:
`sanitized` flags or content hashes do not prove tenant ownership of opaque
contents. Shared references disclose neither content type nor byte size. The
adapter performs no blob deletion.

The task-registry adapter reads only `celery:job-task:<id>` keys derived from
persisted owned jobs, at most 1000. Values must be canonical UUID task IDs.
It opens no Redis connection, scans no wildcard namespace, revokes no task and
performs no deletion. Redis observations are explicitly not atomic with SQL;
other namespaces remain uncovered.

Exact disposable quarantine now covers runs, run/job links, workflows and stages
in addition to jobs, module controls, sessions and keys. It preserves row links,
fails active restored work, sets cancellation flags, disables automatic exports,
advances workflow control versions and raises the disabled module-version floor
above restored work. Other owners remain unchanged. Financial execution,
reservations, connections and operator state remain held, not restored under a
generic adapter. Retained prompt anchors remain retained; no cycle is bypassed.

## Remaining work and decisions

| Priority | Remaining item | Classification / next requirement |
| --- | --- | --- |
| H2 | Other outbox contracts | Implementable per-topic typed principal/resource validators; generic JSON owner claims are insufficient. Eight native topics already have a separate scoped adapter. The canonical composition still reports other topics held. |
| H2 | Opaque blob content | Needs an explicit safe payload contract with embedded principal/provenance validation; reference ownership alone is insufficient. Reference metadata adapter is implemented. |
| H2 | Persistent files and temporary exports | Need actual deployment inventory and authoritative run-to-file ownership manifest before opening or deleting paths. Source includes scan source/page stores and temporary XLSX exports; no personal file path is accepted here. |
| H2 | Other cache namespaces | Need source-specific ownership and persistence mapping. Market/dashboard caches and task/lock transport are not automatically account-owned. Exact owned job task registry is covered read-only. |
| H2 | Financial/operator recovery | Implementable only with exact store-specific quarantine and reservation/order reconciliation contracts; current generic restore continues to hold these stores. No actual erasure allowed. |
| H2 | Identity and legal retention | Decision required: for each dataset, what legal hold, retention deadline, identity revocation/anonymization action and audit anchor must apply? Source classification is not approval. No periods invented. |
| H2 | Backups | Access/policy required: actual backup destinations, expiry, key lifecycle and suppression of erased identities on restore. No complete erasure claim until verified. |
| H1/H4/M2 | Native PG/Redis and browser acceptance | Prepared disposable Docker/native probe and exact-source CI must run after applicable publication approval; Docker/PostgreSQL/Redis unavailable on this executor. SQLite results do not substitute. New native browser walkthrough remains unqualified. |
| M3 | Release and owner walkthrough | Assemble exact-source go/no-go after new CI and safe deployment gate. Existing owner acceptance covers only historical restricted flows. Stage 20 remains preparation. |

No production/server access, credential/security change, real provider call,
external send, actual account deletion, remote publication or deployment occurred.

## Verification receipts

At 2026-10-23 22:40:45 UTC the combined focused/retained regression run completed
81 tests, zero skips (`credx-privacy-successor-final.xml`). The separate exact
native-privacy CI command completed 17 tests, zero skips
(`credx-native-privacy-17.xml`); these overlap and are not additive. Independent
review of the extensions ran eight focused tests with zero skips. Existing
SQLAlchemy UTC deprecation warnings remain.

The canonical PostgreSQL composition test is prepared in the existing six-case
canonical PostgreSQL gate; it was not run locally. Its job's total source gate is
updated from 417 to 418. No remote CI was triggered. Source inventory regeneration
and check passed with 317 HTTP entries, 53 workers, 19 schedulers, 68 pages,
52 export entries and zero unresolved entries. Counts are inventory, not proof of
complete requirements. No frontend changed in this successor, so prior builds
were not rerun or transferred to this source as browser acceptance.
