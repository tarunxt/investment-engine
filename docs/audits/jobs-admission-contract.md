# Current release boundary — 2026-11-03

PR #1392 is narrowed to A9-002 ownership/cache scoping and A9-R05 public-copy
minimization, plus the reviewed serialized cancellation/terminal-preservation fix.
The proposal below is HISTORICAL, not the current release contract. The combined
A11 implementation/tests remain at published commit 08bff6b4; its synthetic tests
are retained under backend/tests/fixtures/a11_combined_08bff6b4/*.source.

Current owner queries and cached-result replay use current-main schema only.
There is no JobAdmission model/table, new migration, dispatch-status column,
per-child outbox producer or relay in this release. Legacy outbox and run fanout
match main. No Beat or financial-worker activation is included. Redis entries bind
actor, operation and normalized payload and always recheck DB owner and body;
cache expiry/loss and lease-loss durable uniqueness remain OPEN A11 work.

A11 consumer head 1bd38177818aada3acc99973aba878e511d0725e was source-reviewed.
It has no schema dependency but overlaps SyncJobRepository.update_status and
PostgresJobRepository.update_status. A future integrator must retain its token
fence and claim-preserving merge as well as this lane's terminal preservation for
unclaimed writers. Do not replace that fence with the simpler A9 guard. A9 does
not import, activate or claim acceptance for the separate consumer implementation.

No migration is needed for the narrowed release; baseline migration files/model
registry/outbox model are byte-identical to current main. No destructive rollback
or ledger cleanup is authorized. If an operator discovers the previously proposed
A11 revision already applied, preserve its records and resolve that state before
running a release migration command; do not blindly downgrade it.

---

# A9-002 / A11-001 / A11-003 proposed integration contract

Base: origin/main 8d25f34a33242adcaab092afdb07af7956f327bd.
This lane exclusively owns jobs router, async owner queries, create_job,
create_run and dispatch outbox. It does not modify Job columns or execution
claims. A11-002 retains ownership of consumer fencing and its migration.

* A9-002-A01/A02/A03: user-facing repository queries require actor identity.
  Cache values never authorize access. Foreign and missing jobs return 404.
* A11-001-R01: separate job_admissions table, unique (user_id, operation,
  request_key_hash); SHA256 normalized payload fingerprint; FK to existing job.
  Admission, job and obligation commit together. No TTL or historical cleanup.
  Conflicting payload returns 409; concurrent loser rolls back and reads winner.
  Redis is optional and cannot authorize creation or replay.
* A11-003-R01: additive nullable outbox job_id (unique), state, claim token,
  next attempt timestamp, safe error type. Topic analysis.dispatch.v1 only.
  One obligation per newly created job; no backfill or legacy replay.
  Stable Celery task_id is the outbox UUID; args=[job_id]. Store absolute UTC ETA,
  including Gemini 20-second offsets. Initial publish records acknowledgement;
  ambiguous exception or process loss remains visible as uncertain.
* A11-003-R02: bounded relay only for this topic and task
  app.domains.jobs.tasks.execute_ai_job. Recovery publication must use
  credx_recovery_analysis and credx:recovery:analysis:v1: transport prefix.
  No Beat change or service activation. Retrying ambiguous publication requires
  independently reviewed A11-002 execution fencing, not merely stable task IDs.
  Canceled/terminal jobs suppress unresolved delivery; existing output remains.

Coordinator must approve the exact additive migration and activation separately.
Rollback: disable relay, revert application only after draining in-flight requests;
retain additive tables/columns and records. Never downgrade away durable identities
or obligations containing live records. No migration or production action here.

A9-002-A04 remains gated on secure auth baseline, serialized integration, exact
release CI/review and approved isolated runtime read-back. None of these findings
is closed by source or synthetic tests alone.
