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
