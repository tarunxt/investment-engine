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

For auto-live console-profile runs, Stage 1 background Bullpen CLI reads are
expected to stay non-interactive: discover, positions, and balance refreshes
must use short worker-safe timeouts and must not block on manual Bullpen login
polling. The current worker contract is a 5 second discover timeout, a 20 second
default positions timeout with `BULLPEN_CONSOLE_POSITIONS_TIMEOUT_SECONDS`
available for bounded overrides, and the existing bounded balance timeout path.
As of Sunday, July 19, 2026, authenticated Bullpen reads must flow through one
centralized backend runtime broker backed by Redis locking and a canonical Redis
positions snapshot. Stage 1 is the only stage allowed to request a forced fresh
wallet snapshot for a run, and that immutable snapshot payload must be handed to
later stages instead of letting Stage 2, Stage 3, UI polling, health routes, or
background monitors spawn their own Bullpen wallet refresh. Cached UI and health
reads may reuse the shared Redis snapshot for roughly 15-30 seconds, but they
must not become a second credential owner or a parallel auth refresh path.
That Redis positions path now runs as a distributed single-flight keyed by the
shared `bullpen:runtime:positions-refresh` lock. Every caller records its own
refresh-request timestamp, and a waiting caller may accept a shared wallet
snapshot only when the published snapshot is both runtime-valid and newer than
that request timestamp. For `force_fresh` Stage 1 inputs, a post-request shared
snapshot from another in-flight refresh still counts as the fresh Stage 1
wallet snapshot; it must not be treated as a stale downgrade simply because a
different caller produced it. Passive UI mount or interval polling is
cache-only: it may wait for an already-running refresh to publish, but it must
not acquire the refresh lock or start a new Bullpen CLI positions command on
its own.
When that forced fresh wallet snapshot fails, Stage 1 must record a failed
workflow stage with the sanitized wallet-refresh error, and the persisted Stage 2
and Stage 3 workflow results must remain explicitly blocked with
`blocked_by_stage1_wallet_refresh=true` instead of continuing with fallback
wallet rereads.
If a user cancels the run while those reads are in flight, the audit
must preserve the cancelled lifecycle instead of letting a late worker progress
write revert the run back to an in-progress state.

Stage 1 wallet outputs are partitioned explicitly and the audit snapshot must
preserve those partitions without re-deriving them on read:

* `active_positions_found`: only rows classified as `active`
* `available_for_claim`: only `positive_payout_claimable`
* `settlement_pending_positions`: closed rows with redeemability signals but
  no verified payout amount yet
* `excluded_position_diagnostics`: stale, resolved-zero, or otherwise excluded
  rows that must never flow into Stage 2, Stage 3, or top-10 sizing math

`settlement_pending`, `stale_or_unknown`, `resolved_zero_payout`, and `closed`
rows are diagnostic-only for new runs after Sunday, July 19, 2026. Historical
completed runs may still display their persisted legacy payloads unchanged.

The Stage 1 frozen wallet snapshot now also carries cache-safety provenance:

* Bullpen credential artifact inode, `mtime_ns`, and file size from
  `credentials.json.enc`
* non-secret Bullpen account identity or wallet address when available
* `position_classifier_version`

Audit consumers must treat a classifier-version bump, credential artifact
change, or account-identity mismatch as a different runtime snapshot lineage.
Only read-only UI fallback may surface stale Redis snapshots after a lock
timeout; a Stage 1 `force_fresh` run snapshot must not silently downgrade to a
stale wallet snapshot. Runtime diagnostics for that shared snapshot should also
preserve the caller source, the producing caller source when another refresh
won the single-flight, whether the result was produced by another refresh, and
the observed shared refresh lock wait/TTL/age metadata needed to explain
contention without exposing secrets.

### Stage 2

Persisted candidate reviews, per-model outputs, Stage 2 LLM runtime payloads, and
qualified handoff inputs. Stage 2 returns/day is rendered from the maximum current
Yes/No market odds divided by days left when usable current odds are available,
falling back to the persisted worker value only for legacy rows without
recomputable odds.

The Stage 2 bundle now also captures the persisted `Stage 2 Top 10 -> Stage 3`
handoff candidate market IDs so audits can verify that every queued Top 10 row
either appeared in Stage 3 decisions or recorded a concrete blocker.

When Stage 2 hands off saved rows for a Stage 3 reuse run, the persisted
candidate row payload must keep the exact market-resolution rules plus supporting
market context. Summaries such as parsed YES definitions, deadline labels, or
prior blocker strings are not a substitute for the original rules text because
Stage 3 re-parses those rows before planning new buy orders.

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
plan. Post-exit buy planning must now derive from the Stage 1 wallet snapshot
handoff and its deterministic simulation state rather than triggering an
independent mid-run Bullpen wallet reread. When the centralized fresh snapshot
fails, Stage 2 and Stage 3 are expected to stay blocked instead of continuing
with ad hoc wallet refreshes.

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
* `llm_returns_per_day`
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
* preserve the single Bullpen runtime broker, single auth-refresh owner, and
  single Stage 1 wallet snapshot contract unless the audit schema, tests, and
  docs are updated together
* preserve the non-interactive Stage 1 runtime contract for background Bullpen
  scan, positions, and balance reads unless the audit docs and tests are updated
  in the same task
* confirm Stage 2 Top 10 handoff rows still persist enough detail to explain why a queued row was planned, deferred, missing, or failed in Stage 3
* confirm any saved Stage 2 -> Stage 3 reuse payload still preserves exact resolution rules instead of only derived summaries
* add or update tests
* review `AGENTS.md` synchronization contract

## Verification Expectations

Recommended verification for audit changes:

* backend unit tests for sanitizer, validators, prompt builder, and router behavior
* frontend typecheck plus route and source smoke tests
* Alembic migration review
* containerized migration apply when Docker is available locally
