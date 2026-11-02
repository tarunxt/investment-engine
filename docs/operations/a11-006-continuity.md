# A11-006 operational continuity evidence contract

Status: **Open**. This repository-only reconciliation is a proposed contract,
not owner approval or proof of deployed execution. Baseline: main
`8d25f34a33242adcaab092afdb07af7956f327bd` (2026-11-01).
The companion [inventory](a11-006-inventory.json) enumerates all 16 normal-mode
Beat entries without importing application modules or executing tasks.

## Evidence and interpretation

- `backend/app/infrastructure/messaging/celery_app.py` defines UTC schedules.
  An interval describes dispatch cadence, not completion deadlines or an SLA.
- `backend/app/infrastructure/messaging/recovery_celery.py` empties Beat and
  disables remote control in recovery. `docs/credx-analysis-recovery.md` defines
  queue isolation and manual activation prerequisites. The four financial workers
  must remain intentionally stopped. Disabled scheduled work is not missed work.
- `backend/app/domains/zerodha/tasks.py` skips weekends using the snapshot date;
  weekday checks do not establish exchange-holiday support. Dispatch returning
  `queued` does not prove child snapshot tasks completed.
- `docs/production-deploy.md` describes topology and queue/heartbeat diagnostics.
  Its normal-mode restart/inspect instructions are not authorization to execute
  them in containment. Partial worker evidence or Celery PENDING is unknown.
- `docs/bullpen-healthcheck.md` describes a passive timer (five minutes after boot,
  then every five minutes), bounded local report and optional webhook. Installation,
  current timer state, last successful observation and delivery are unknown here.
  Do not run it to fill gaps: configured webhook execution can send an alert.

The published inventory contains no task execution history. Count=0 is the number
of task records sampled, not a workload count or a claim that no operational
metadata exists. Supplied service observations belong in a separate private
evidence ledger. No last expected/actual start, terminal outcome, lag or evidence
window is independently known. No raw receipts, financial rows or identities are
included. Source declarations cannot establish loaded worker module identity.

## Required ledger and read-back

For each explicitly approved obligation, retain only workflow key, mode, market,
IANA zone, calendar version/policy, expected UTC start, actual UTC start, terminal
state and timestamp, lag seconds, dependencies, manual prerequisites, responsible
owner, evidence window and sanitized receipt reference. Record skipped with a
reason (weekend, approved holiday, manual prerequisite, intentional containment),
unknown with a reason, or an evidenced terminal state. A dispatch success is not
workflow success. Lag is actual minus expected only when both instants and the
obligation are known; otherwise null. Negative lag needs investigation.

An authorized operator must supply bounded metadata, with query/window limits,
page count, sample size, total if known, cursor/remaining-page indication and
clock/source identity. Incomplete pagination must remain explicit. Keep heartbeat
age, queue depth and alert delivery as separate observations with observation
time, mode, scope and completeness; absence of a receipt is not healthy/zero.
A11-004 owns execution-health semantics; reference its final contract before
interpreting any task state as failed or successful.

## Additional operational inventory and decisions

| Workflow/evidence | Source or reported scope | Remaining gap / responsible approver |
| --- | --- | --- |
| Daily audit automation | Delegated audit record: 06:00 Asia/Kolkata = 00:30 UTC; separate application scheduler | Existing audit owner must confirm retained schedule/read-back; preserve separate 2 Nov occurrence and Audit7 manual prerequisites |
| Passive health observer | Healthcheck documentation; optional webhook, bounded private local report | Existing monitoring owner must confirm timer, bounded last receipt and delivery status; no test send |
| Deployment identity | Source baseline above only | Sole operator must attest exact backend/recovery artifact and loaded service identity without restart |
| Backup archive | Delegated record reports existing retained private archive and 1 Dec review | Backup owner must attest retention policy, copy locations, encryption/access boundary metadata and independent failure domains; do not create another backup |
| Restore coverage | Delegated record reports prior PG18 restore exit 0; roles/ACL excluded; same-snapshot aggregate comparison unavailable | A11-005 qualified matrix required; no snapshot equality, permissions or DR guarantee inferred |
| Capacity | Delegated record mentions single host spare RAM/disk sample | Window/trend and owner-approved capacity thresholds unknown; no extrapolation |
| Queue/heartbeat | Runbook describes separate queues and lifecycle heartbeats | Sole operator supplies existing bounded metadata only; no remote control enablement |
| Escalation | Optional webhook documented | Existing task/monitoring owners must name responsible responder, private contact mapping, acknowledgement route and approved escalation timing |

Reported backup/host statements are supplied context, not independently read
receipts. Copy count, off-host/off-account independence, retention duration,
restore freshness and recoverable scope remain unknown. A copy sharing host,
account, credentials or storage failure domains cannot establish independence.
RPO and RTO remain **unapproved/unknown**, including each workflow's expected
execution and terminal/deadline objective. No numerical thresholds are proposed
by this patch. Owners may supply proposed values with status `proposed`; they
become obligations only with explicit approver, scope, decision reference and
approval time. The agent cannot approve objectives or scope exceptions.

## Acceptance record

| Test | Local evidence | Remaining acceptance |
| --- | --- | --- |
| T01 calendar/timezone | Offline ZoneInfo fixtures: IST conversion and US DST transition instants | Owners approve market holiday/calendar and contained-mode obligations |
| T02 expected/actual | Synthetic ledger examples distinguish disabled, skipped, unknown and terminal | Bounded independently supported history, pagination and all sampled obligations accounted for |
| T03 backup | Explicit metadata gaps and qualified A11-005 dependency above | Backup owner read-back of retention, copy/failure domains and qualified restore scope |
| T04 escalation | Required owner and receipt fields specified; no send | Known responsible owner and existing delivery evidence or owner-approved exception |

Each remaining gap requires responsible owner approval of a specific exception
(scope, rationale, evidence limitation, expiry/review time and decision reference)
or independent evidence. Approval is currently absent for every gap. Keep this
one finding open until all substeps .01-.09 and T01-T04 are supported, integration
with A11-004/A11-005 is reviewed, and independent read-back is recorded.
No scheduler, schedule, service, alert, infrastructure, retention, history or
manual prerequisite is changed by this contract.

## Private observation reconciliation boundary

Keep actual operational receipts outside the repository and PR. A private ledger
must map canonical `.service` unit names to expected containment and observed
state, receipt provenance, observation instant and successful/failed query count.
Preserve active/inactive enter/exit and main-process start timestamps as distinct
fields; empty timestamps remain null. A stopped worker that matches intentional
containment is not a missed obligation. A running service alone proves no task
completion or availability objective.

For bounded journal projections record window, PID filter, unit scope, requested
fields, cap, returned count, cap-hit flag, normalization corrections and retained
history limitations. Account for every returned record across normalized units.
PID 1 manager-record counts are not classified restart counts. `NRestarts` is a
current systemd counter, not a lifetime total. Neither supplies uptime or RPO/RTO.
Zero manager records does not establish zero executions, failures or incidents.
Do not mix this ledger with the synthetic classifier tests or task-history sample;
task terminal outcomes, lag, queue health and heartbeat evidence remain unknown
until their own qualified records are supplied.

## Retained workflow projection tooling

`scripts/a11_006_retained_evidence.py` processes an explicitly supplied, bounded
JSON/gzip projection offline, verifying input and decompressed hashes. It writes
aggregate evidence only to an exclusive private output outside this repository
(mode 0600). It performs no collection and prints no records or identifiers.
Actual input, hashes, coverage declarations and output belong in the private
handoff, separate from this source inventory. Tests use synthetic rows only.

The tool separates primary market/run keys from older overlapping observations,
counts historical display labels and usable timestamp fields, and preserves
pagination/population uncertainty. It does not compute execution duration or cost.
Display-derived start/finish text cannot establish task receipt, an approved
expected start, an investment decision or outcome. Without an authenticated task/
dispatch-to-obligation mapping, schedule linkage, start lag and missed obligations
remain unknown even when a saved summary says COMPLETED. The source inventory's
zero task-receipt sample is not a claim that no retained workflow summaries exist.
