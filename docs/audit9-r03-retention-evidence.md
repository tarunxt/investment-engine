# A9-R03 — retention evidence register

Status: evidence gathered; policy approval and operational evidence remain open.
Source baseline: `8d25f34a33242adcaab092afdb07af7956f327bd`, reviewed 2026-11-01.
This register describes source behavior, not an approved retention policy or a legal conclusion.

| Sensitive class | Source and operational purpose | Minimum retention | Deletion authority / dependencies |
| --- | --- | --- | --- |
| Portfolio snapshots and immutable financial evidence | `docs/auto-rebalance-audit.md`, `docs/bullpen-run-audit.md`: reproducibility and reconciliation | Owner decision required; no lawful minimum established | Owner must approve, including provenance and referencing runs; source deletion mechanics do not confer authority |
| Jobs/runs prompts, responses, context and errors | `backend/app/domains/jobs/models.py`, `backend/app/domains/runs/models.py`: execution, retries and saved results | Not established | Owner decision required; user foreign keys cascade, run-job relationships delete orphans; inspect dependencies before any approved deletion |
| Export URLs and provider copies | Same models plus `backend/app/domains/google_sheets/service.py`: locate exported results | Not established; local URL deletion is not remote deletion | File owner/provider controls, sharing inheritance and external copies need separate evidence |
| API telemetry | `backend/app/domains/api_usage/{models,metering}.py`: usage, retry attribution and cost diagnostics | Not established | Owner decision required; request digest is not anonymization; identifiers and usage remain potentially linkable |
| Application/worker logs | `backend/app/core/logging.py`: troubleshooting | Byte rotation: 10 MiB, five backups per file; no time minimum established | File rotation does not establish system journal or aggregation retention; operator evidence needed |
| Retained reports, audit blobs, backups | `docs/bullpen-run-audit.md`: preserve frozen facts and recoverability | Referenced blob lifetime follows references; backup expiry not established | Existing unreferenced-blob GC documents a default 24-hour grace and six-hour cadence; these are not permission to delete referenced evidence or backup policy |

T01 remains incomplete: operational purposes are identified but minimum durations and their approved lawful basis are missing for every class. T02 remains incomplete: authority, backup expiration, provider contract applicability, restore/redelete behavior and all logging sink guarantees need existing coordinator evidence. Provider public terms are inventoried in A9-R04. T03 source-review portion is complete: this lane preserves original evidence and provenance, does not mutate retention or records, and does not equate absent policy with unlawful retention or leakage.

Next decision gate: the owner supplies approved class-by-class minimum/maximum durations, purpose, deletion approver, legal-hold handling, provider-copy handling and backup expiration/restore rules. The existing coordinator must then verify bounded non-sensitive operational metadata. No deletion, retention change, settings access or legal compliance claim is authorized by this document.

Tracking: no matching ID found in repository documentation. Remote canonical issue lookup was denied (`Forbidden`); deduplication remains unresolved. Do not create a duplicate issue without resolving that lookup through the coordinator.
