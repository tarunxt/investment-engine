# Bullpen Run Audit

## Purpose

Bullpen Run Audit captures an immutable, reviewable record of each Bullpen AI auto-live
run. It combines:

* Native or reconstructed run snapshots
* Deterministic validation findings
* Append-only remarks and manual audit checks
* Versioned LLM feedback reports and Codex remediation prompts

The audit system is read-oriented. It must never alter live-trading behavior or
recompute business decisions on page load.

## Architecture and Lifecycle

1. A Bullpen auto-live run is created through the existing auto-live pipeline.
2. Native audit metadata is attached at run creation time.
3. A working or reconstructed audit snapshot is materialized from the persisted run,
   decisions, and order-intent state.
4. Terminal runs are frozen into a canonical bundle, hashed deterministically, and
   exposed through `/bullpen-ai/run-audits`.
5. Deterministic findings and default manual checks are persisted once per snapshot.
6. Optional LLM feedback is queued to Celery and stored as immutable feedback versions.

Current implementation notes:

* New runs persist `audit_metadata` on the run payload for provenance and settings hash.
* Existing runs are backfilled lazily when listed or opened.
* Large sections are loaded lazily through section endpoints instead of bloating the
  list response.

## Domain Layout

`backend/app/domains/bullpen_run_audit/`

* `constants.py`: section keys, prompt version, registry, manual checks
* `models.py`: SQLAlchemy tables for snapshots, stages, findings, feedback, and blobs
* `schemas.py`: API response and request models
* `repository.py`: DB access, blob deduplication, snapshot lookup
* `sanitizer.py`: recursive secret redaction for stored payloads
* `prompt_builder.py`: chunk planning, prompt generation, strict JSON parsing
* `validators.py`: deterministic findings
* `service.py`: materialization, exports, manual checks, remarks, feedback enqueue
* `tasks.py`: Celery feedback execution
* `router.py`: authenticated API endpoints

## API Surface

Authenticated routes live under `/bullpen-ai/run-audits`.

* `GET /bullpen-ai/run-audits`: paginated summary tiles with filters
* `POST /bullpen-ai/run-audits/{run_id}/materialize`: force refresh a snapshot
* `GET /bullpen-ai/run-audits/{run_id}`: metadata, findings, checks, remarks, feedback history
* `GET /bullpen-ai/run-audits/{run_id}/sections/{section}`: lazy section payloads
* `GET /bullpen-ai/run-audits/{run_id}/findings`: findings-only list
* `POST /bullpen-ai/run-audits/{run_id}/remarks`: append remark
* `POST /bullpen-ai/run-audits/{run_id}/manual-checks`: append manual check version
* `POST /bullpen-ai/run-audits/{run_id}/feedback`: enqueue Celery feedback generation
* `GET /bullpen-ai/run-audits/{run_id}/feedback`: feedback version history
* `GET /bullpen-ai/run-audits/{run_id}/feedback/{feedback_id}`: persisted report detail
* `GET /bullpen-ai/run-audits/{run_id}/export`: canonical bundle JSON

## Persisted Entities

### Snapshot

`bullpen_run_audit_snapshots`

Stores the current or historical snapshot version for a run, including:

* run and user identity
* source kind: `native` or `reconstructed`
* lifecycle: `working`, `frozen`, or `incomplete`
* provenance: commit SHA, build, Alembic revision, settings hash
* completeness metrics and high-level counts
* canonical bundle blob and hash

### Blob

`bullpen_run_audit_blobs`

Content-addressed storage for sanitized raw JSON or text payloads such as prompts,
responses, stage payloads, and canonical bundles.

### Stage, Event, Formula

* `bullpen_run_audit_stages`
* `bullpen_run_audit_events`
* `bullpen_run_audit_formulas`

These preserve logical stage grouping, event timelines, and formula ledgers without
recomputing values on page load.

### Finding, Remark, Manual Check

* `bullpen_run_audit_findings`
* `bullpen_run_audit_remarks`
* `bullpen_run_audit_manual_checks`

Findings are deterministic and versioned by rule version. Remarks and manual checks are
append-only and support superseding history.

### Feedback

* `bullpen_run_audit_feedback`
* `bullpen_run_audit_feedback_subcalls`

Each feedback version stores:

* provider and model
* prompt version and prompt hash
* snapshot hash
* chunk coverage
* token, cost, latency, error, and report state
* final report JSON and Codex prompt

## Section Mapping

User-facing sections remain `Stage 1`, `Stage 2`, and `Stage 3`, even when the
underlying run stores additional substages.

### Overview

Run metadata, timestamps, trigger source, diagnostics, settings snapshot, provenance,
and timeline summaries.

### Stage 1

Source scan inputs, filter context, candidate inputs, active-position carry-over, and
pre-LLM review rows.

### Stage 2

Persisted candidate reviews, per-model outputs, Stage 2 LLM runtime payloads, and
qualified handoff inputs. Stage 2 returns/day is rendered from the strongest LLM
Yes/No odds divided by days left when usable LLM odds are available, falling back
to the persisted worker value only for legacy rows without recomputable odds.

The Stage 2 bundle now also captures the persisted `Stage 2 Top 10 -> Stage 3`
handoff candidate market IDs so audits can verify that every queued Top 10 row
either appeared in Stage 3 decisions or recorded a concrete blocker.

Stage 2 snapshots also persist the eligible-universe coverage record:
reviewed rows, skipped rows, completeness, and any stored blocker summary/fix
used to explain why the full universe could not be reviewed and what should be
done next.

Stage 2 LLM invocation counts now come only from persisted child provider/model
executions. Wrapper task completion does not count as an LLM response, blank
provider/model rows are treated as data-integrity failures, Stage 2 may end in
`partial`, and Stage 3 may only consume persisted usable Stage 2 outputs.

### Stage 3

Decision rows, guardrail outcomes, ranking and selection results, order intents,
execution steps, order funnel metrics, and the mirrored Stage 2 handoff queue
used to explain why a Top 10 row did or did not become a concrete Step 2 buy
plan.

### Guardrails

Run-level guardrails plus decision-specific guardrail payloads.

### Formulas

Immutable ledger rows for Stage 2 consensus statistics, returns-per-day metrics, Stage
3 ranking data, and order funnel aggregates.

### Raw

Sanitized run payloads, stage results, decisions, orders response, and event summaries.

## Formula and Algorithm Registry

Defined in `AUDITED_ALGORITHM_REGISTRY`.

Current required keys:

* `stage2_consensus_statistics`
* `candidate_returns_per_day`
* `position_returns_per_day`
* `stage3_rank_and_selection`
* `order_funnel_aggregation`

If Bullpen logic adds or replaces critical formulas, the registry and tests must be
updated in the same change.

## Finding Rule Registry

Defined in `validators.py` with `BULLPEN_RUN_AUDIT_RULE_VERSION`.

Current deterministic checks include:

* missing run start or invalid duration
* missing code provenance
* explicit audit capture gaps
* Stage 2 candidate without LLM outputs
* invalid YES/NO sum
* rationale-versus-odds mismatch
* provider failure markers
* incomplete Stage 2 universe missing a stored cause or remediation
* qualified Stage 2 candidate missing Stage 3 result
* Stage 2 Top 10 handoff row missing from Stage 3 decisions
* Stage 2 Top 10 handoff row missing a recorded planning blocker
* blocked Stage 3 decision without reason
* rank duplicates or gaps
* selection count exceeding max positions
* orphaned order intents and submitted orders without attempts

## Code Provenance Fields

Persisted provenance is sourced from native run `audit_metadata` where available.

Current fields:

* backend commit SHA
* frontend build SHA
* deployment ID
* build time
* Alembic revision
* audit schema version
* settings hash

## Schema Upgrade and Backfill Procedure

1. Add or update audit models and schemas.
2. Create an Alembic migration.
3. Update `backend/alembic/env.py` imports if new models are introduced.
4. Bump snapshot schema version when historical snapshots cannot represent new data.
5. Keep historical snapshots immutable.
6. Reconstruct legacy snapshots lazily or through a maintenance job.
7. Expose unavailable historical fields through `missing_fields` instead of fabricating data.

## Developer Checklist

When changing Bullpen logic:

* update audit capture inputs and outputs
* update snapshot schema version if needed
* update `AUDITED_ALGORITHM_REGISTRY`
* update validators and finding messages
* update frontend run audit rendering if labels or sections changed
* confirm Stage 2 Top 10 handoff rows still persist enough detail to explain why a queued row was planned, deferred, missing, or failed in Stage 3
* add or update tests
* review `AGENTS.md` synchronization contract

## Verification Expectations

Recommended verification for audit changes:

* backend unit tests for sanitizer, validators, prompt builder, and router behavior
* frontend typecheck plus route and source smoke tests
* Alembic migration review
* containerized migration apply when Docker is available locally
