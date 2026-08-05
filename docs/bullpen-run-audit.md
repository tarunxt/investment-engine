# Bullpen Run Audit

Stage 1 console projections retain both accepted and rejected candidate
summaries so the run monitor can display the complete scanned-event list
without changing frozen audit snapshots. Older snapshots that do not contain
rejected candidate rows remain readable and show the rows that were
historically retained.

## Purpose

Bullpen Run Audit captures an immutable, reviewable record of each Bullpen AI auto-live
run. It combines:

* Native or reconstructed run snapshots
* Deterministic validation findings
* Append-only remarks and manual audit checks
* Versioned LLM feedback reports and Codex remediation prompts

The audit system is read-oriented. It must never alter live-trading behavior or
recompute business decisions on page load.

### Operator Stage 3 retries

The Stage 3 worker card exposes an explicit retry control while Stage 3 is working.
That action cancels the current run, preserves the scheduler's enabled state, and
queues a new Stage 3 pass using the saved, complete Stage 2 handoff. Both Stage 3
steps (Event Exits followed by Invest planned orders) execute again. The replacement
run remains a separate immutable audit subject: its request context records
`candidate_rows_prefiltered`, `reuse_saved_llm_outputs`, the Stage 2 candidate rows,
and the source snapshot/run identifier. The cancelled run and its already persisted
decisions or order intents are not rewritten, so historical snapshots and remote
order reconciliation remain backward compatible.

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
* Canonical Stage 1/2/3 extraction mirrors the console selector: exact stage
  numbers `1`, `2`, and `3` win over any internal/mislabeled row carrying
  `workflow_stage_key=scan|llm|invest` regardless of row order. If an exact row
  is absent, the first persisted explicit legacy row is the deterministic
  compatibility fallback.

### Concurrent materialization and Stage 3 refreshes

The current working snapshot for a run is rebuilt in one transaction under a PostgreSQL
`FOR UPDATE` lock on its persisted Auto-Live run row. The parent run is used as
the lock target even before a snapshot exists, so concurrent first-time and
`force=True` materializations cannot create competing current snapshots. While
that lock is held, mutable working-snapshot child stages, deterministic events,
formulas, and findings
are deleted, flushed, and rebuilt before the snapshot metadata is committed.
In particular, a deterministic event key such as `run-started` remains unique
within `(snapshot_id, event_key)` instead of relying on an ignored integrity
error. A frozen schema-v2 snapshot is immutable even under `force=True`: an
unchanged source run returns the frozen row as-is, while a genuinely newer run
amendment creates a higher linked snapshot version under the same parent lock.
The old frozen canonical blob/hash, children, findings, and captured
rule/registry provenance are neither cleared nor rewritten. Only its
`is_current` version-selection pointer is demoted atomically so all consumers
continue to observe exactly one current snapshot; the historical version
remains directly addressable by snapshot id.
Content-addressed audit blobs use PostgreSQL `ON CONFLICT DO NOTHING` on their
stable hash, so independent serialized run rebuilds can safely share identical
sanitized payloads.

Stage 3 reconciliation does not rebuild an audit synchronously for every
intent poll. It calls `request_bullpen_run_audit_refresh_sync`, which uses a
per-run Redis pending marker and short debounce (default 5 seconds) to enqueue
at most one `refresh_bullpen_run_audit_snapshot` Celery task. That task takes a
token-owned per-run refresh lease (default 300 seconds), renews both that lease
and its pending marker while a serialized rebuild is still running. The same
heartbeat extends any present dirty-generation and monotonic-freeze markers so
their shorter original TTL cannot expire during the task's allowed ten-minute
execution window. Every
coalesced request also publishes an opaque dirty generation. After each
serialized rebuild the worker atomically compares the generation and releases
the pending marker only if no later request arrived; otherwise it performs a
trailing rebuild from the newly durable state. A request racing after the
materializer's read therefore cannot be discarded by marker cleanup.
If the generation watermark nevertheless disappears, missing is treated as
unknown rather than current: the worker installs a new watermark without
overwriting a racing request and performs one fail-safe trailing rebuild.
Duplicate or redelivered refresh tasks exit without rebuilding. The task uses
late acknowledgement so a worker loss during this generation-drain loop is
redeliverable. If that redelivery reaches Redis before the dead worker's
same-token lease expires, one token-scoped recovery message is scheduled from
the lease's remaining TTL plus a two-second boundary margin. Before returning,
the redelivery renews pending ownership through that bounded recovery window
and extends existing generation/freeze markers. A Redis marker bounds this to
one delayed message and prevents duplicate fan-out. A successful stale-lease
takeover clears that marker for the new ownership epoch, so a second worker
loss remains recoverable without allowing concurrent recovery messages. Redis
failure is logged and does not fall back to direct materialization: order
reconciliation and submission safety are intentionally independent of audit
rendering.

Durable Stage 3 intent state remains the audit source of truth across worker
restarts: queue-dispatch metadata, attempt counters, and any remote order or
transaction references are captured before a refreshed snapshot is built. A
pending intent without an `ai` consumer is an operational readiness failure
(HTTP `503` from `/health/ready`), not an external order rejection. This keeps
the historical audit distinction between an unstarted `READY` intent and an
ambiguous or submitted remote order intact. Readiness queries the explicit
Redis-backed project Celery app instead of Celery's process-global default app,
then gives the inspector its complete reply window plus separate async
scheduling headroom. That prevents API startup order or broker latency from
recording a healthy consumer as unavailable.

The relevant operational environment variables are:

* `BULLPEN_RUN_AUDIT_REFRESH_DEBOUNCE_SECONDS` (default `5`)
* `BULLPEN_RUN_AUDIT_REFRESH_LEASE_SECONDS` (default `300`)
* `BULLPEN_RUN_AUDIT_BLOB_GC_GRACE_HOURS` (default `24`)
* `BULLPEN_RUN_AUDIT_BLOB_GC_BATCH_SIZE` (default `100`)
* `BULLPEN_RUN_AUDIT_BLOB_GC_MAX_BATCHES` (default `10`)

### Content-addressed blob retention

Working snapshot rebuilds replace their stage and event child rows. The
content-addressed payload rows behind those children are immutable, so a
rebuild can leave old payloads unreferenced even though the current and frozen
snapshot facts remain valid. Celery beat runs
`prune_unreferenced_bullpen_run_audit_blobs` every six hours to prevent that
storage from growing without bound.

The task deletes only blobs older than the configured grace period that have no
reference from a snapshot, stage input/output/raw payload, event, feedback
report/output, or feedback subcall input/output. It rechecks those references in
each small SQLAlchemy delete transaction, commits batches independently, logs
failures, and is safe to retry. Referenced blobs, including all blobs used by
existing frozen snapshots, are never eligible. This preserves the facts and
backward compatibility of every historical snapshot while reclaiming only
unreachable storage.

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
* `tasks.py`: Celery feedback execution and coalesced run-audit refreshes
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

### Trade-analysis read isolation

`GET /bullpen-ai/trade-analysis` reads the authenticated user's persisted
PostgreSQL trade-analysis snapshot first and never waits for Bullpen CLI
history. After building that response, the API schedules a Celery history
reconciliation behind per-user Redis pending and worker-lease keys. Duplicate
page requests and redelivered tasks therefore do not execute parallel CLI
refreshes; the task has bounded time limits and no automatic retry loop. Redis
or broker failure is logged and does not fall back to running the CLI inside
FastAPI.

The browser validates the complete list response while trying its configured
preferred transport first and the alternate direct-API or same-origin proxy
transport second. Only when both transports fail, are unsupported, or return
invalid data may the page show its tertiary last-known-good session cache. That
cache is schema-validated, age-bounded, and scoped to the authenticated user
plus the exact filter set. Every transition logs the failed stage and reason.
Cached UI data is observational only: it never feeds Stage 1, Stage 2, Stage 3,
order execution, reconciliation, or frozen run-audit snapshots, so historical
schema versions remain backward compatible.

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
responses, stage payloads, and canonical bundles. Referenced payloads are retained
for the lifetime of their audit records; only aged payloads with no durable
reference are reclaimed by the scheduled blob-retention task. The same
sanitization pass runs before hashing, persistence, deterministic finding
storage, and API response construction. In addition to secret-bearing keys and
URL parameters, common absolute Unix and Windows host paths are replaced with
`[REDACTED_PATH]`; audit JSON pointers and repository-relative source paths
remain intact.

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

Findings are deterministic and versioned by rule version. Before persistence, repeated
occurrences of the same `(rule_version, code)` are coalesced in first-seen order to
match the table's one-row identity. The row keeps the strongest severity, the logical
OR of `blocking`, and all unique evidence pointers. Duplicate occurrences remain
inspectable as a deterministic first-seen sample of at most 50 entries in
`detection_metadata.occurrences`, while
`detection_metadata.occurrence_count` retains the exact total.
`occurrences_truncated` states whether the sample was clipped and
`occurrences_hash` is a stable SHA-256 over the complete canonical occurrence
identity stream, so a change outside the sample remains detectable. The merged
unique evidence-pointer sample is independently capped at 50 and records its
exact count, truncation state, and full-stream hash. Evidence pointers and
detection metadata inside each sampled occurrence are also bounded and hashed.
The first occurrence's legacy detection-metadata fields remain available as a
bounded source sample with their own truncation flag and hash; even 10,000
duplicate findings therefore produce a bounded persisted row.
Singleton findings retain their original payload shape. Remarks and manual
checks are append-only and support superseding history.

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

Stage 1 scan filtering excludes release-deadline markets whose normalized event
search text contains `released by`; run-audit snapshots should preserve the
resulting rejected/accepted candidate counts without rewriting historical frozen
snapshots.

For auto-live console-profile runs, Stage 1 background Bullpen CLI reads are
expected to stay non-interactive: discover, positions, and balance refreshes
must use short worker-safe timeouts and must not block on manual Bullpen login
polling. The current worker contract is a 5 second discover timeout, a 45 second
overall Gamma API fallback timeout, a 20 second default positions-command timeout
with `BULLPEN_CONSOLE_POSITIONS_TIMEOUT_SECONDS` available for bounded overrides,
and a separate 30 second end-to-end Stage 1 wallet-handoff budget controlled by
`BULLPEN_CONSOLE_STAGE1_WALLET_REFRESH_TIMEOUT_SECONDS`. The separate handoff
budget covers waiting on shared Redis locks and auth refreshes, not just the
positions command itself. Timed-out Bullpen commands run in an isolated process
group and have bounded cleanup so descendant processes cannot hold the worker's
output pipes open indefinitely. If both scan sources fail, the run records a
sanitized scan warning and continues with an explicit empty Stage 1 candidate
set; Stage 2 and Stage 3 then complete as a no-op instead of leaving the run
parked in Stage 1.
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
When that forced fresh wallet snapshot fails for a non-transient reason, Stage 1
must record a failed workflow stage with the sanitized wallet-refresh error, and
the persisted Stage 2 and Stage 3 workflow results must remain explicitly blocked with
`blocked_by_stage1_wallet_refresh=true` instead of continuing with fallback
wallet rereads. A distinct Stage 1 handoff timeout or shared-lock timeout is handled differently: the
worker records `wallet_snapshot_status="unavailable"`,
`wallet_refresh_error`, and `stage2_candidate_only=true`, cancels the lingering
wallet read, and proceeds with read-only Stage 2 candidate analysis. Its Stage 3
result is explicitly blocked with `blocked_by_stage1_wallet_refresh=true`; it
must plan or submit no orders and the run ends as `partial_success`. This keeps a
slow shared wallet refresh from indefinitely preventing LLM review while
preserving the fresh-wallet safety gate for execution.

A fresh wallet snapshot that is present but contains unresolved positive-exposure
rows is not the same as a missing wallet snapshot. In that degraded-enrichment
case, Stage 2 remains the sole authoritative source of the exact ordered Exit and
Buy lists. The audit records `stage2_actionable_contract_version=2`, the exact
market IDs and counts, and `wallet_market_enrichment_degraded=true`. Stage 3 must
copy those exact lists into its handoff checkpoint and Planned counters, retain
unresolved positive-exposure markets as conservatively occupied slots, and then
run the normal fresh wallet, balance, credential-lineage, capacity, quote, and
durable order-intent preflight. Later blocking or exchange rejection may prevent
submission, but it must not erase or replace the Stage 2 Planned list.
If a user cancels the run while those reads are in flight, the audit
must preserve the cancelled lifecycle instead of letting a late worker progress
write revert the run back to an in-progress state. Cancellation takes a durable
row lock before terminalizing any unfinished stage as `fail` with
`phase_status=cancelled`; the run audit is then force-materialized and frozen.
This makes the cancellation snapshot authoritative even when the Celery task is
terminated before it can run its normal cleanup path.

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

Position classifier v4 treats a fresh authoritative open-market lookup as
stronger evidence than any Bullpen `redeemable`/`claimable` flag or stale payout
field. An open market remains an active holding and cannot enter
`available_for_claim`; positive claimability requires the market not to be
authoritatively open plus positive settlement evidence. This prevents an open
wallet position from being excluded from the Stage 2/Stage 3 active portfolio
because of stale claim metadata.
An explicit authoritative lookup that reports the market is not open can no
longer remain `active`; that closed/inactive evidence cannot be overridden by
stale positive wallet size/value fields. Frozen snapshots retain the classifier
version and result that were captured at materialization time and are never
reclassified in place.

The Bullpen portfolio panel and its trade-amount preview reconcile to the newest
completed Stage 1 `active_positions_found` snapshot. This is intentional: the
page-level portfolio refresh is a separate cache/read path and may temporarily
return zero or stale tracked positions even though the worker has already
verified live economic exposure. When a completed Stage 1 snapshot exists, its
serialized active rows are authoritative for the displayed active count,
investment/current value, uPnL, and occupied slots. Cash in hand still comes
from the latest usable balance. The preview is then `cash in hand / (10 -
verified active positions)`, matching the worker formula.

New audit bundles expose this evidence as
`stage_1.verified_portfolio_snapshot`; legacy frozen snapshots without that
optional projection remain valid. Deterministic checks compare the serialized
row count with the recorded occupied count, available slots, and trade amount
so a divergent zero-position flow is visible as a blocking audit finding.
The projection retains the canonical Stage 1 status, phase, timestamps,
hard-block state, and completion-evidence result. New verification requires a
`pass` or `warning` stage, a `completed` or `partial` phase, a valid
`completed_at`, fresh wallet status and freshness lineage, and no wallet error,
candidate-only, or wallet-block flag. A completed warning with a usable fresh
wallet remains valid. A failed, running, timestamp-less, or hard-blocked Stage 1
cannot certify its rows. For backward compatibility, a legacy absent
`phase_status` is accepted only when the canonical stage is `pass`/`warning`
and has a valid completion timestamp.
When Stage 1 timed out or continued candidate-only, the projection is marked
`verified=false` with the refresh error; an empty degraded list is never
represented as proof of an empty portfolio. A fresh verified empty list remains
a valid zero-position snapshot. Positive-share or positive-value wallet rows
whose exact market identity and open/closed state cannot be enriched are also
degraded and candidate-only. They are counted conservatively for Stage 1
capacity, cannot replace the last verified portfolio projection, and hard-block
Stage 3 rather than being misreported as a verified empty wallet.

The Stage 1 frozen wallet snapshot now also carries cache-safety provenance:

* Bullpen credential artifact inode, `mtime_ns`, and file size from
  `credentials.json.enc`
* non-secret Bullpen account identity or wallet address when available
* `position_classifier_version`

The audit sanitizer preserves only those three numeric credential-artifact
fingerprint fields. It drops the credential path and any other artifact fields,
while ordinary credential, token, password, and secret-bearing keys remain
fully redacted. This keeps lineage independently verifiable without persisting
credential material or host identity.

Audit consumers must treat a classifier-version bump, credential artifact
change, or account-identity mismatch as a different runtime snapshot lineage.
Only read-only UI fallback may surface stale Redis snapshots after a lock
timeout; a Stage 1 `force_fresh` run snapshot must not silently downgrade to a
stale wallet snapshot. Runtime diagnostics for that shared snapshot should also
preserve the caller source, the producing caller source when another refresh
won the single-flight, whether the result was produced by another refresh, and
the observed shared refresh lock wait/TTL/age metadata needed to explain
contention without exposing secrets.

The console's page-level wallet cache follows the same provenance comparison.
Once a tab has a verified lineage, a passive response with a different account
identity, credential artifact inode/mtime/size, or classifier version is
display-incompatible even if the response itself is fresh. The console
preserves the prior verified rows, prevents automatic claim from using the
mismatched response, and requires a deliberate user refresh before accepting a
fresh new baseline. This is a read-path guard and does not rewrite frozen audit
snapshots or relax any Stage 1/Stage 3 lineage validator.

### Stage 2

Persisted candidate reviews, per-model outputs, Stage 2 LLM runtime payloads, and
qualified handoff inputs. Stage 2 returns/day is rendered as the unpriced upside
for the current market odds on the same side as the strongest LLM Yes/No odds
divided by days left: `(100 - current side odds) / days left`. This is used
when usable current and LLM odds are available, falling back to the persisted
worker value only for legacy rows without recomputable odds.

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

Stage 2 candidate reviews and persisted `stage2_context` now also preserve the
exact Gamma child-market rule provenance used by the Stage 3 buy gate:

* matched Gamma market ID
* match method: `condition_id`, `market_id`, or slug fallback
* `exact_gamma_market_verified`
* authoritative rule source field: `resolutionCriteria`, `resolution_criteria`,
  `rules`, `description`, or `legacy_payload`
* normalized rules text
* YES-definition supporting sentence or clause
* YES-definition extraction method and confidence
* final rule gate result, including `bypassed_verified_binary_rules`

Stage 2 LLM invocation counts now come only from persisted child provider/model
executions. Wrapper task completion does not count as an LLM response, blank
provider/model rows are treated as data-integrity failures, Stage 2 may end in
`partial`, and Stage 3 may only consume persisted usable Stage 2 outputs.

### Stage 3

Decision rows, guardrail outcomes, ranking and selection results, order intents,
execution steps, order funnel metrics, and the mirrored Stage 2 handoff queue
used to explain why a Top 10 row did or did not become a concrete Step 2 buy
plan. Stage 3 Event Exits now persist the exit order IDs and terminal/partial
statuses, then force a Bullpen CLI positions refresh through the shared runtime
broker. The snapshot must prove `source=live-cli` and must be fetched after the
exit attempt before economic slot allocation runs. Slot diagnostics retain raw
and economically active counts, excluded records and reasons, canonical
market/side deduplication, replacement reservations, free slots, and any safe
stale-slot bypass. The audit schema remains additive so frozen legacy snapshots
without these optional diagnostics remain readable and are not rewritten.

The Stage 3 slot-allocation diagnostics also persist `exit_intent_ids`,
`exit_retry_history`, `exit_terminal_statuses`, `planned_buy_ids`,
`submitted_buy_ids`, `post_exit_snapshot_source`, `post_exit_snapshot_fetched_at`,
and the final blocker or bypass reason. Every saved Event Exit intent carries its
run and decision identity, condition/market identity, side, size, limit price,
idempotency key, retry count, last error, next retry time, and partial-fill
amounts. After a live run persists these durable intents and synchronizes the
run/order funnel, the worker immediately queues the same run's due `READY` exit,
redeem, and buy intents; the periodic beat dispatcher remains only a safety-net
retry path. That handoff is the required planned-exit sell algorithm: persist
the idempotent order intent first, enqueue Event Exits before replacement buys by
priority, submit each sell/redeem in a Celery worker, reconcile until the remote
order or wallet snapshot proves terminal fill/removal, then wake only the
dependent replacement buy. Rate-limit retries use the persisted Stage 3 retry
policy and history; they become terminal only after the configured attempt and
total-wait budgets are exhausted. A submitted-but-unfilled or meaningfully
partial exit continues to occupy its economic slot. A confirmed exit wakes only
its one-for-one replacement intent after a fresh live-cli wallet and cash
refresh.

Before Stage 3 performs slot allocation, Event Exit evaluation, or buy planning,
it persists `stage2_handoff_checkpoint` with `status=received`, the exact saved
Stage 2 Top 10 candidate IDs, count, and receipt time. This durable boundary
distinguishes a transfer queue from concrete Stage 3 plans. If a worker stops
after receipt but before decision rows are written, the audit reports the
interruption explicitly and recovery does not invent or submit an order. The
field is additive; frozen snapshots without it remain legacy-compatible.

Exit reconciliation reads current Bullpen trade history through `polymarket
orders --history` before legacy command fallbacks. When the fresh wallet snapshot
shows a successful sell left only two-decimal CLOB precision dust whose marked
value is at or below the configured economic dust threshold, the exit is
confirmed and its slot is released while the exact residual shares remain in the
snapshot. Wallet reconciliation matches the persisted numeric market ID,
condition ID, or slug as aliases for the same position, so a provider-facing slug
cannot leave an internally numeric sell stuck in confirmation.

Immediately before any live sell or redeem write, the durable intent forces a
fetched-after-request wallet snapshot. A `redis-cache` result is accepted only
when the broker marks it `fresh`, meaning another process completed the
single-flight refresh after this request; cached or stale results fail closed.
The intent requires complete Stage 1 account, credential
inode/`mtime_ns`/size, classifier version, and timestamp lineage, then compares
it against the pre-submit snapshot. Legacy intents without complete expected
lineage fail closed before any external write. A changed credential artifact is
accepted only when the latest healthy active-auth result attests that exact
current artifact, the stable wallet identity matches both Stage 1 and the
forced-fresh snapshot, and the auth check is no older than the Stage 1
snapshot. The comparison records the old and new artifact fingerprints plus
`auth_checked_at`; missing or stale attestation returns
`POSITION_LINEAGE_UNAVAILABLE`, while an identity change returns
`POSITION_LINEAGE_MISMATCH`.
The post-exit buy planner may continue across that same-account rotation when
the newer forced snapshot carries a newer authentication timestamp, but records
that its planner-only acceptance is deferred to the durable pre-submit gate.
This prevents benign credential refreshes from suppressing buy planning without
allowing the planner comparison itself to authorize an external write.
For current-version redeems, the forced snapshot and successful comparison are
persisted under `execution_metadata_json.wallet_snapshot_lineage` and
`wallet_lineage_comparison` before the scoped redeem function can write. An
account, credential artifact, classifier, or older-snapshot mismatch fails with
`POSITION_LINEAGE_MISMATCH`. The audit treats a v2 redeem that crosses the
remote-write boundary without complete matching proof as a blocking finding.
The redeem coordinator's first classification read consumes exactly those
verified preflight positions; only post-write reconciliation may request a
subsequent forced-fresh snapshot, which must remain on the same lineage.

The exact matched wallet row is then enriched from an authoritative Gamma market
identity before sell-versus-redeem classification. A currently open market
overrides stale claimable/redeemable/payout flags and remains an active sell; a
closed positive-payout match is rejected with `SELL_REQUIRES_REDEEM`. Resolved,
settlement-only, redeemed, closed, or stale matches are rejected with
`NO_SELLABLE_EXPOSURE`. If exact identity and open/closed status cannot be
established, no external write is issued. For an active match, submitted shares
are capped at the smaller of planned and freshly verified wallet shares.
Successful evidence is stored under
`execution_metadata_json.sell_live_preflight` with `version=v1`, snapshot
lineage, authoritative enrichment, classification, identities, and the
requested/verified/submitted share amounts.

Live Stage 3 sells use one bounded immediate-exit strategy inside a single durable
order-intent attempt. The strategy tries these paths in order:

1. `primary` / `market_sell_explicit`
2. `secondary` / `market_sell_max`
3. `tertiary` / `limit_sell_fak`

The next path is allowed only when the preceding path returns
`result=fallback` with `safe_to_fallback=true`, proving that no ambiguous or
accepted remote write exists. `accepted`, `ambiguous`, and
`provider_retry_required` are terminal for the in-provider sequence. An ambiguous
write moves to reconciliation; neither it nor a provider-level retry result may
fall through to another sell path. Write-time RPC rate limiting is treated as
ambiguous because acceptance might have preceded response loss, so it is never
automatically resubmitted. This keeps all three paths under the same order-intent
ID, idempotency key, worker operation lease, PostgreSQL advisory fence, and outer
attempt budget.

Fallback eligibility is deliberately fail-closed. It requires either a Bullpen CLI
parse/argument rejection that could not issue an order, or a structured
`unmatched`/`no_match` result with explicit zero-fill evidence and no order,
transaction, or trade reference. Generic failure, rejection, cancellation,
timeout, malformed output, any positive fill amount, or any remote reference stops
the chain and reconciles instead of issuing another sell. A positive fill smaller
than the requested shares remains `PARTIALLY_FILLED` until wallet/order
reconciliation accounts for the residual exposure.

Each telemetry-bearing sell stores
`execution_metadata_json.immediate_sell_strategy` with `version=v1`,
`selected_layer`, `execution_path`, `fallback_count`, and an ordered `attempts`
list. Every layer records its sequence, layer, path, result, reason, validation,
`safe_to_fallback`, provider alias, and start/completion timestamps. The exact
strategy object is mirrored under the owning order attempt's sanitized response at
`_stage3_immediate_sell`, so an audit can prove which fallback ran and why even if
mutable intent metadata later changes. A later attempt that stops in preflight does
not replace that owner. Missing immediate-sell telemetry is valid
legacy evidence: snapshot schema version 2 is retained, frozen snapshots are not
rewritten, and validators activate only when the versioned strategy key is
present.
`fallback_count` counts transitions that were actually taken and is therefore
bounded to `0..2`; a verified no-write failure on the final tertiary layer may
still record `result=fallback`, but it does not imply a fourth transition. That
terminal case is valid only with null selected layer/path and a permanently failed
intent.

New Stage 3 intents use the `auto-live:v2` idempotency-key format: a SHA-256
digest over the exact run, decision, and order-plan identity with a stable prefix.
This preserves deterministic retry identity while keeping the stored value below
the existing 128-character database limit. The execution metadata records the
format, and the algorithm registry plus deterministic validator audit the key and
block any oversized value. Existing frozen snapshots and already-persisted legacy
keys remain valid and are not rewritten.

An ambiguous BUY write persists `first_submitted_at`, `last_submitted_at`, and
the mirrored `uncertain_remote_write_boundary` attempt evidence before entering
reconciliation. Automatic resubmission remains disabled. BUY reconciliation
polls a persisted order reference, then requires a forced-fresh same-account,
same-credential, same-classifier wallet snapshot and alias/side/size/timestamp
correlated history before inferring a fill. Its automatic ambiguity window is
configured by `AUTO_LIVE_BUY_RECONCILIATION_MAX_AGE_SECONDS`, defaults to 900
seconds, and is clamped to 30 seconds through 24 hours. When the window expires,
the intent becomes non-retryable `TIMED_OUT`, records the v1
`buy_reconciliation_operator_block`, retains its cash/write fence, and requires
Bullpen support verification before manual recovery.

Every current terminal BUY also persists
`post_buy_terminal_wallet_refresh`. A direct or polled fill records a bounded
publication result (`published` or `refresh_failed`) with its caller source;
wallet/history reconciliation retains the forced-fresh source, fetch timestamp,
direct lineage comparison, and expected Stage 1/preflight lineage checks. This
is the authoritative bridge that makes newly bought active positions visible to
the Bullpen Portfolio without issuing a second order.

Bullpen CLI buy and sell writes use the persisted market slug as their execution
reference because the CLI resolves slugs, while the numeric Gamma market ID
remains the canonical audit and portfolio identity. Legacy intents without a slug
fall back to their stored market reference. The algorithm registry records this
selection rule so audit readers can distinguish provider execution identity from
internal market identity.

Decision rows expose the explicit execution states `EXIT_RPC_RETRYING`,
`EXIT_NOT_SUBMITTED`, `EXIT_SUBMITTED`, `EXIT_OPEN_UNFILLED`,
`EXIT_PARTIALLY_FILLED`, `EXIT_FAILED_PERMANENTLY`,
`POST_EXIT_REFRESH_PENDING`, `REPLACEMENT_SLOT_RESERVED`,
`GENUINE_CAPACITY_BLOCK`, `CAPACITY_OVERRIDE_USED`, `BUY_READY`,
`BUY_SUBMITTED`, and `BUY_FAILED`. The operator action “Retry failed exits and
continue buys” is tied to the same saved run, is idempotent, does not rerun Stage 1
or Stage 2, and never resets an intent that already has a remote order or
transaction reference. `stage3_capacity_override` defaults false and is audited
as an explicit operator bypass of only the slot-capacity gate; live cash,
duplicate-market, market-validity, order-size, exposure, slippage, pricing, and
cooldown guardrails remain active.

Stage 3 order sizing always uses the forced, lineage-fenced live economic-position
snapshot plus accepted buys from the current run. Stage 1, Stage 3 sizing, and
sell preflight share the same authoritative market enrichment so an open row with
stale claim flags cannot be active on one screen and claimable on another.
Fresh coalesced `redis-cache` snapshots are valid; cached/stale or pre-request
snapshots are rejected.

Stage 3 computes how many open slots can be funded at the normal minimum:
`spendable cash = max(0, gross cash - execution balance buffer)` and
`affordable slots = min(open slots, floor(spendable cash / minimum order))`.
It plans only the highest-ranked eligible rows up to that count, and each
lower-ranked row retains an explicit affordability blocker.
Historical accepted rows that are absent from the live wallet remain
duplicate-market denylist entries, but they cannot reduce available sizing slots
or post-buy free-slot diagnostics to zero. An explicit capacity override still
bypasses only the slot gate; it does not bypass cash or order-size limits. The
snapshot records gross cash, the shared reservation buffer, spendable cash,
capacity-gate, v2 sizing, eligible, cash-funded, affordable, concrete planned,
and free-slot counts. Existing frozen v1 snapshots without these additive
fields remain readable.

The duplicate-market denylist also retains an unresolved BUY after its parent
run becomes terminal. `TIMED_OUT`, unknown-fill `CANCELLED`/`REJECTED`, and any
other terminal BUY with persisted remote-write evidence remain blocked until
reconciliation records quantity-known definitive zero fill. A later exit does
not clear an unresolved open-order risk. Immediately before reservation, Stage
3 takes one host-global Bullpen-account row lock, matches the candidate against
all durable BUYs by market ID, condition ID, or slug regardless of side, and
persists a bounded `buy_market_exposure_preflight` proof on both the intent and
attempt. This same lock serializes collateral across app users because the
Bullpen CLI credential store is a singleton host runtime. Only a zero-conflict
proof may proceed to the external write.

A dependent replacement remains deferred and unsized until its paired exit is
terminally successful and a post-exit wallet/cash refresh establishes the actual
slot and spendable balance. A terminal or deferred buy that never acquired a
remote order, transaction, or submission timestamp releases its capital
reservation. Active-reservation sums join the durable buy intent and ignore
leaked `active` rows from terminal no-write intents, while ambiguous or persisted
submissions remain fenced. In particular, a `REJECTED`, `CANCELLED`, or
`TIMED_OUT` BUY with a persisted write timestamp/reference and unknown fill
quantity continues to count against reserved cash until reconciliation records
an explicit zero fill or the reservation is otherwise safely released. These
rules prevent a failed replacement from
artificially consuming cash or a pre-exit diagnostic amount from becoming an
executable order.

Event Exit evaluation removes every planned exit from the investable ranking
before Stage 3 freezes final ranks, candidate order, and Step 2 queue counters.
Candidates promoted by a forced, LLM/odds, or rank-out exit therefore retain
their returns-per-day order instead of falling back to market ID order. Stage 3
first assigns the portfolio's cash-affordable, already-free economic slots to
the highest-ranked candidates. Only candidates beyond that immediately
affordable count receive one-for-one replacement reservations, paired with
executable sell exits that actually release an initially occupied economic
slot. Redeem/claim rows, duplicate exits, non-economic rows, and a sell of only
one side of a multi-side market exposure cannot create a replacement
reservation. This is
`stage3_rank_and_selection` algorithm version `v2` and
`stage3_deferred_replacement_sizing` algorithm version `v2`.

The exit-to-replacement transition is serialized on the exit row. Reconciliation
flushes the terminal exit before scanning and locking dependent BUY rows, so both
paths use the same EXIT-then-BUY lock order. Every slot-releasing EXIT and its
paired replacement BUY persist the same deterministic `dependency_group`;
execution wake-up and watchdog recovery match that shared group rather than
relying on in-memory pairing. Bounded compatibility repair fills a missing EXIT
group only when the BUY group identifies that exact same-run exit market; it
never overwrites a conflicting non-empty group. This is
`stage3_dependency_exit_handoff` algorithm version `v3`. A bounded watchdog also
recovers a
historical lost-wake row only when its committed sibling exit is already
`CONFIRMED` or `FILLED`; it then records `DEPENDENCY_WAKE_RECOVERED` and the
durable `exit_confirmed_at` proof before returning the BUY to `READY`.

The Stage 2 transfer queue remains a separate handoff diagnostic. Stage 3 Step 2
`planned`, `processed`, and `submitted` execution tiles count concrete persisted
buy intents only. The backend reconciles those tiles, the Stage 3 totals, and the
order funnel from the same durable records; the UI must not combine stale queue
counters with a different decision-row source.
After an explicit same-run operator retry backfills durable intent IDs, state and
summary polling treat those intent tasks as the execution authority. A terminal
result from the original parent analysis task cannot reclassify the resumed run
as interrupted, replace its decision rows, or cascade-delete the backfilled
intents. The stored `stage3_recovery` and `stage3_resume_action` fields make that
handoff deterministic and auditable.
An exit that is merely submitted or still open never releases a slot. A partial
exit releases one only when the remaining economic exposure is at or below the
configured dust threshold. A ranked replacement is reserved for its specific
slot-releasing Event Exit and is executable only after the exit is confirmed and
the live snapshot shows the old exposure removed. When a ranked buy cannot be placed,
the persisted Stage 3 reason should distinguish an open/unfilled exit, a
meaningful partial remainder, stale cache, excluded dust/resolution, genuine
capacity, or a successfully released replacement slot. Historical snapshots
without these diagnostics remain valid and must not be rewritten.

### Guardrails

Run-level guardrails plus decision-specific guardrail payloads.

### Formulas

Immutable ledger rows for Stage 1 portfolio-slot sizing, Stage 2 consensus
statistics, returns-per-day metrics, Stage 3 ranking data, and order funnel
aggregates.

### Raw

Sanitized run payloads, stage results, decisions, orders response, and event summaries.
Native audit decision capture uses the same reconciliation visibility predicate
as run and order-intent reads. Durable rows marked
`_console_reconciliation_state=superseded` remain in PostgreSQL for foreign-key
history but are not reintroduced into current Stage 3 decisions or audit findings.

## Formula and Algorithm Registry

Defined in `AUDITED_ALGORITHM_REGISTRY`.
The current registry version is
`2026-07-27-stage3-submission-evidence-v29`. The
`bullpen_position_claimability` entry is algorithm version `v4`; historical
frozen bundles retain their earlier registry provenance and child findings.

Current required keys:

* `stage2_consensus_statistics`
* `candidate_returns_per_day`
* `bullpen_position_claimability`
* `stage2_to_stage3_handoff_checkpoint`
* `console_trade_amount_per_opportunity`
* `llm_returns_per_day`
* `position_returns_per_day`
* `stage3_rank_and_selection`
* `stage3_affordable_ranked_buy_allocation`
* `order_funnel_aggregation`
* `stage3_sell_live_exposure_preflight`
* `stage3_buy_market_exposure_preflight`
* `stage3_redeem_wallet_lineage_preflight`
* `stage3_wallet_credential_rotation_attestation`
* `stage3_post_exit_planner_credential_rotation`
* `stage3_sell_alias_reconciliation`
* `stage3_buy_reservation_terminal_release`
* `stage3_active_reservation_cash_filter`
* `stage3_buy_post_submit_reconciliation`
* `stage3_ambiguous_write_boundary_fence`
* `stage3_terminal_buy_portfolio_refresh`
* `stage3_dependency_exit_handoff`
* `stage3_waiting_exit_watchdog_recovery`
* `stage3_deferred_replacement_sizing`
* `stage3_immediate_sell_fallback`
* `stage3_persisted_counter_reconciliation`
* `stage3_restart_recovery`
* `stage3_bullpen_response_normalization`
* `stage3_verified_remote_absence_retry`
* `stage3_reconciliation_generation_guard`
* `stage3_terminal_resume_preservation`
* `stage3_terminal_doctor_blocker`
* `stage3_submission_evidence_terminality`

Materialized formula rows use the same provenance as the registry:
`console_trade_amount_per_opportunity` is `v2`,
`llm_returns_per_day` is `v3`, and both returns-per-day implementations point
to their actual `console_profile` source module.

`stage3_active_reservation_cash_filter` algorithm version `v2` counts an
otherwise consumed BUY reservation when its consumption timestamp is newer
than the forced-fresh verified balance's `checked_at`. This prevents a balance
snapshot taken before a concurrent fill from releasing that capital early and
overcommitting a later BUY; older consumed reservations remain excluded once
the verified balance is new enough to include them. Every attempted reservation
also freezes a `buy_cash_reservation_preflight` v2 proof on the intent and
latest attempt. The proof records the singleton scope, fresh balance timestamp,
$1 buffer, active plus unseen-consumed debit, requested amount, remaining cash,
and pass/block result before any remote write.

Stage 3 response normalization recursively preserves Bullpen order and transaction
references and treats a successful nested `result.status=matched` buy response as a
terminal fill. Reconciliation also backfills this evidence from persisted attempts,
so older frozen snapshots remain unchanged while active runs can converge without a
duplicate exchange write.

`stage3_buy_market_exposure_preflight` algorithm version `v2` combines the
forced-fresh wallet guard with the serialized singleton-account durable-intent
guard. Any active position or unresolved durable BUY matching the target market,
condition, or slug blocks the BUY regardless of whether the existing holding is
YES or NO. The intent and latest attempt retain identical bounded evidence:
target aliases, scope, check time, conflict count and rows, truncation, and
pass/blocked result. Explicit quantity-known definitive zero-fill evidence is
the only persisted-write terminal exception. This market-wide fence prevents
opposite-side or cross-run exposure from slipping through a side-specific or
run-terminal duplicate check while preserving older frozen registry evidence.

`stage3_immediate_sell_fallback` identifies
`submit_immediate_sell_with_fallbacks` as the execution source for the finite
three-path sell strategy. The audit validates the ordered layer/path prefix, exact
result vocabulary, terminal-stop behavior, safe fallback decisions, selected
accepted path, fallback count, required reason/validation/timestamp evidence, and
the identical latest telemetry-bearing attempt mirror. A valid use of the
secondary or tertiary path is retained as an informational finding rather than
treated as a failure.

An authenticated operator may retry a `CONFIRMING` intent only by explicitly
asserting that Bullpen order history and open orders were checked and contain no
matching remote write. The intent must also have no persisted order ID, transaction
hash, or submission timestamp. The previous status and verification timestamp are
stored in execution metadata for auditability; ordinary confirmation retries remain
blocked.

Manual retries increment the durable intent generation. Reconciliation may update an
intent only while it is still in a pending-confirmation status and its generation
matches the snapshot that was remotely checked. Queued stale reconciliation tasks
return without network work for ready/terminal intents and cannot overwrite a newer
operator retry transition.

Run-level operator resume preserves terminal `CONFIRMED` and `FILLED` intents even
when they retain their required remote submission references. Only nonterminal
intents with persisted order, transaction, or submission evidence are moved into
reconciliation, preventing a completed exchange write from regressing to
`CONFIRMING` while retaining backward-compatible frozen snapshots.

Bullpen doctor and Polymarket preflight failures now retain typed upstream
fields including `error_code`, `safe_to_retry`, `support_required`, `terminal`,
and `resolution_owner`. A known support-owned blocker such as
`POLYMARKET_WALLET_ROUTE_UNCONFIRMED`, or any typed doctor response with
`safe_to_retry=false`, becomes a non-retryable Stage 3 terminal failure before
the remote write boundary. Untyped transport and doctor-read failures retain
the historical retryable `DOCTOR_READ_FAILED` behavior. The deterministic
validator emits `STAGE3_TERMINAL_DOCTOR_BLOCKER_RETRYABLE` when a known
support-owned doctor blocker is flattened, scheduled for retry, or left
outside `FAILED_PERMANENT`. Ordinary terminal exchange responses such as
`MARKET_CLOSED` are not reclassified as doctor failures merely because they
also carry `safe_to_retry=false`.

Stage 3 terminal success is now evidence-fenced. `CONFIRMED` and `FILLED`
durable intents count as submitted/executed only when a submission timestamp,
remote order/transaction reference, or uncertain write-boundary marker was
persisted. Attempt count and wallet absence alone are insufficient. Legacy
evidence-free terminal rows remain readable, but current projections show them
as unsubmitted/deferred, replacement capacity stays blocked, funnel rates remain
bounded to 100%, and the validator emits
`STAGE3_TERMINAL_SUCCESS_WITHOUT_SUBMISSION_EVIDENCE`.

Current order-plan projections add
`submission_evidence_present` and `submission_evidence_kind` so the workflow
tiles, run details, shortlist outcomes, and Stage 3 counters consume the same
durable-write contract. The kind identifies a remote order ID, transaction
hash, submission timestamp, or uncertain-write-boundary marker. Frozen legacy
plans leave these additive fields absent and may fall back only to their exact
submission timestamp or remote identifiers, never success prose. An
evidence-backed order that later becomes cancelled, rejected, timed out, or
permanently failed remains counted as submitted and is rendered separately
from orders that never crossed the remote-write boundary.

If Bullpen logic adds or replaces critical formulas, the registry and tests must be
updated in the same change.

## Finding Rule Registry

Defined in `validators.py` with `BULLPEN_RUN_AUDIT_RULE_VERSION`.

Rule version
`2026-07-27-stage3-submission-evidence-v29` retains deterministic
duplicate coalescing, buffered affordable-buy validation, verified-only Stage 1
portfolio formulas, and remote-write-boundary sell-preflight validation. It also
audits the v2 redeem wallet-lineage fence while registering alias-aware sell
reconciliation, terminal no-write reservation release and terminal-leak
filtering, and deferred post-exit replacement sizing. Current-format intent
validation also deterministically rejects active capital left on a waiting or
definitive no-fill buy, reservation consumption before `CONFIRMED`/`FILLED`,
and any dependent buy that reaches sizing, reservation, or execution without
both `exit_confirmed_at` and v1 force-fresh post-exit wallet/balance sizing
proof. It also validates mirrored ambiguous-write timestamps and retry fences,
the bounded terminal operator block for aged ambiguous BUYs, and terminal BUY
portfolio publication or same-lineage reconciliation evidence. A current-format
replacement BUY whose `dependency_group` is absent from every same-run sell or
redeem intent emits `STAGE3_REPLACEMENT_EXIT_DEPENDENCY_MISSING`; legacy intent
formats remain readable. A recorded immediate-buy count that differs from the
buffered affordable allocation, or exceeds the initial free slots, emits
`STAGE3_PRE_EXIT_FREE_SLOT_ALLOCATION_INVALID`. These additive
rules are gated by the `auto-live:v2` intent identity so
legacy rows without the newer evidence remain readable.
The terminal-doctor and submission-evidence rules are additive and use already
captured order and attempt fields. They do not change the v2 snapshot schema,
rewrite frozen snapshots, or require a migration. Existing frozen findings
retain the rule version and payload captured when they were materialized.

Current deterministic checks include:

* missing run start or invalid duration
* missing code provenance
* explicit audit capture gaps
* Stage 1 verified row count contradicting its recorded occupied count
* Stage 1 available slots or trade amount contradicting verified active rows
* Stage 2 candidate without LLM outputs
* invalid YES/NO sum
* rationale-versus-odds mismatch
* provider failure markers
* incomplete Stage 2 universe missing a stored cause or remediation
* candidate-only Stage 2 requiring Stage 3 to remain blocked with no decisions or orders
* qualified Stage 2 candidate missing Stage 3 result
* Stage 2 Top 10 handoff row missing from Stage 3 decisions
* Stage 2 -> Stage 3 handoff checkpoint invalid or inconsistent with the saved
  transfer queue when the additive checkpoint is present
* Stage 3 interruption after a received handoff checkpoint but before decision rows
* Stage 2 Top 10 handoff row missing a recorded planning blocker
* blocked Stage 3 decision without reason
* rank duplicates or gaps
* selection count exceeding max positions
* affordable ranked-buy counts exceeding eligible rows, cash-funded minimum
  orders, or capacity slots
* post-buy free-slot counts derived from the historical duplicate denylist
* orphaned order intents and submitted orders without attempts
* current-version buys that crossed the remote-write boundary with a missing,
  malformed, nonzero-conflict, non-mirrored, or non-singleton market preflight
* current-version buys that crossed the remote-write boundary without a
  forced-fresh wallet/account/credential/classifier lineage proof
* current-version buys that crossed the remote-write boundary with missing,
  malformed, stale, non-mirrored, or insufficient singleton cash-reservation
  preflight evidence
* current-version sells that crossed the remote-write boundary with missing
  preflight evidence
* sell preflight that is not fresh, classifier-v4 active, lineage-fenced, or
  capped to verified shares
* current-version redeems that crossed the remote-write boundary without a
  forced-fresh, matching Stage 1 account/credential/classifier lineage proof
* current-version waiting/deferred or definitive no-fill buys that retain
  nonzero or active capital reservations
* reservations marked consumed before their intent is `CONFIRMED` or `FILLED`
* dependent buys that reach sizing, reservation, or execution without a
  durable exit confirmation and a fresh post-exit wallet/balance sizing proof
* claimable/resolved sell blocks that nevertheless contain a remote write
  reference
* immediate-sell layers duplicated, out of order, unbounded, or mapped to the
  wrong execution path
* immediate-sell fallback without complete trigger, validation, provider, and
  timestamp evidence
* fallback count or selected accepted path contradicting the layer results
* unsafe fallthrough after an accepted, ambiguous, or provider-retry result
* intent-level immediate-sell telemetry missing from or disagreeing with its
  newest telemetry-bearing durable attempt mirror
* persisted Stage 3 counters that violate `submitted <= processed <= planned`
* interrupted Stage 3 runs incorrectly left working/confirming
* restart recovery that does not disable automatic resubmission
* retryable intents that already contain persisted order/submission references

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

## Stage 3 Durable Sell-Intent Watchdog

Stage 3 durable order snapshots now include watchdog and retry diagnostics from
`execution_metadata_json`, order attempts, and order-plan blockage fields. The audit
must preserve these fields when materializing runs so reviewers can distinguish:

* `PLANNED` intents promoted to `READY` because Beat/worker dispatch never saw them.
* due `READY`/`RETRY_WAIT`/`WAITING_FOR_COLLATERAL` intents requeued by the watchdog.
* `WAITING_FOR_EXIT` replacement BUYs recovered only when a committed terminal-success exit proves a prior dependency wake was lost.
* stale `SUBMITTING` intents moved to confirmation/reconciliation before any retry, preventing duplicate sells after ambiguous worker or network failures.
* per-attempt retryability, root cause, worker task ID, sanitized request/response, next retry time, remote order references, and operator resolution guidance.

Only the canonical reconciliation scheduler queues reconcilable
`SUBMITTED`/`CONFIRMING`-style intents; the due-intent dispatcher handles
executable work. Every execution, retry, operator action, watchdog action, and
reconciliation task first takes the same token-owned per-intent Redis operation
lease and refreshes it while it owns remote Bullpen work. It also holds a
PostgreSQL session advisory fence across that remote operation, so a Redis
eviction cannot admit a second worker for the same intent. A duplicate or stale
Celery delivery therefore exits before any remote read or write. The durable
intent state, idempotency key, remote-order evidence, and recovery-required
guards remain the final Stage 3 safety boundary; audit materialization is never a
precondition for order reconciliation.

Historical snapshots remain backward-compatible: missing watchdog fields mean the run
predates the durable-intent watchdog and should be rendered as legacy diagnostics.
The same rule applies to `immediate_sell_strategy`: its absence does not create a
finding. The v1 checks run only for intents that opt in by persisting the strategy
key, so existing schema-v2 frozen snapshots remain valid without backfilled or
inferred fallback facts.

## Console Scheduler First-Paint Status

The Bullpen AI console's first-paint scheduler endpoint,
`GET /polymarket/auto-live/status`, reads only the authenticated user's persisted
Auto-Live settings and scheduler-state rows plus a narrow indexed identity/status
lookup for a durable non-terminal run. It is intentionally read-only and does
not recover runs, enqueue due work, inspect Celery or Redis, invoke Bullpen CLI
authentication, or materialize audit evidence. This permits the console to
render the persisted enabled/paused/mode state even while optional runtime
diagnostics are unavailable, and prevents it from treating a historical last
run as still in progress.

Run transitions, Stage 1–3 evidence, and audit snapshot capture remain owned by
the existing worker and summary flows. The lightweight response contains only
existing persisted identifiers and timestamps; it neither mutates frozen audit
snapshots nor changes their schema. Older snapshots therefore remain fully
compatible, while deferred diagnostics continue to supply their established
runtime and guardrail evidence.

## Console Run History Source

The Bullpen console History dialog loads the authenticated user's database-
paginated, compact records from `GET /polymarket/auto-live/history`. It must not
treat `BullpenAutoLiveSummary.recent_runs` or `recent_decisions` as authoritative
history. The first page reads scalar run columns plus the additive
`console_projection`; it does not select the full run `payload` or all decision
rows. Selecting one run lazily loads the compatible `GET /runs/{id}` detail and
the additive `GET /runs/{id}/decisions` detail.

History requests bypass browser caches, preserve the current page if a refresh
fails, and are cancelled when the dialog closes or the authenticated console is
replaced. A legacy row with no projection is marked
`projection_available=false`; scalar identity, status, times, summary, and
durable counts remain visible, but the compact read does not invent missing
stage evidence.

Migration `x0y1z2a3b4c5` adds nullable JSON console projections beside run and
decision payloads. Normal durable saves populate projection version 1 with
bounded stage status, counters, diagnostics, funnels, and decision summaries.
The migration deliberately performs no all-row backfill because production
contains multi-gigabyte TOAST values and rewriting them during deploy would
create CPU and lock pressure. Full historical detail remains available through
existing payload adapters.

The console projection is not part of the frozen audit snapshot, is never an
input to ranking, sizing, guardrails, execution, retry, or reconciliation, and
does not alter the algorithm registry or deterministic audit validators.
Therefore the frozen snapshot schema remains version 2; historical snapshot
facts and hashes are unchanged.

During an active run, compact console projections must retain the last observed
outputs of completed stages. In particular, starting Stage 3 must not clear the
persisted Stage 1 and Stage 2 counts and make the main workflow cards fall back
to zero. This is presentation-state preservation only; the completed stage
facts remain the values captured by the worker. In Run Details, the Stage 3
Planned, Processed, and Submitted tiles use the same evidence-filtered detail
dialogs as the main workflow monitor and pass the detail view's exact decision
rows into those dialogs.

The deterministic Stage 2 unit adapter used only when tests replace
`run_llm_consensus` now derives selected, started, completed, usable, and failed
provider-target counters from the configured provider/model identities and the
adapter's usable outputs. This mirrors the production shared runner's existing
fail-closed selected-target invariant; the normal worker runner, prompt,
evidence fields, algorithm registry, and snapshot schema are unchanged. The
adapter exists to validate the current target-accounting fields and does not
backfill or reinterpret any frozen snapshot.

## Active Auth Recovery and Restart-Safe Stage 3

Snapshot schema version 2 adds the current Stage 3 recovery and durable-counter
representation without rewriting frozen version 1 snapshots.

The centralized Bullpen runtime broker persists the latest active
`doctor auth --refresh` verdict in Redis. Historical command text is not an active
auth verdict. Console login remediation is valid only when that latest active result
reports invalid credentials, required login, blocked trade auth, or a failed doctor
refresh. A later healthy result marks the earlier auth rejection stale/recovered.
Because this is mutable runtime state, the latest verdict is returned with the
Auto-Live summary; frozen run snapshots continue to record only the auth and
guardrail evidence observed during that run.

Auto-Live planning is isolated on the `auto_live` queue and records a task
lifecycle before publishing: `QUEUED`, `RESERVED` (received but waiting for a
pool slot), `STARTED`, `RETRYING`, then a terminal lifecycle state. The dedicated
planning worker defers destructive restart recovery for the configured startup
grace period. A queued/reserved lifecycle, an ambiguous Celery `PENDING` result,
or a partial `inspect` response is not evidence of a dead worker. A started run
can be marked worker-lost only after its explicit heartbeat expires, the
worker-loss grace period passes, no redelivery, Redis execution lease, or
PostgreSQL run advisory fence is present, the inspection evidence is complete
and negative, and Celery has no terminal result. `WorkerLostError` is treated as
potentially redeliverable during that grace period rather than an immediate
terminal workflow failure. The two-hour workflow circuit breaker remains an
independent absolute limit. Backend startup does not perform an immediate
destructive stale-run sweep.

Production launchers bound retained worker memory without changing Bullpen
inputs, formulas, decisions, order identities, or evidence. The primary worker
uses a dedicated `ai` child and the low-priority email unit uses a dedicated
`email` child. Each has concurrency one, preserving the former total of two
children while preventing email work from reserving Stage 3 capacity. Both use
prefetch one, bounded child task counts, and resident-memory limits. The dedicated planning child is
replaced after every completed task so a large Stage 1 scan cannot retain its
event payload into the next hourly cycle. Deploy removes the legacy hard-coded
primary-worker `ExecStart` drop-in and verifies that the canonical launcher is
effective before restarting services. Child replacement occurs only after a
task completes; an OOM or other mid-task loss still follows the existing late
acknowledgement, run lease, PostgreSQL advisory fence, heartbeat, and redelivery
contract above. These runtime bounds add no snapshot fields and do not rewrite
frozen historical audits.

The synchronous Celery-to-async bridge also closes its Bullpen runtime broker
and disposes the worker process's async SQLAlchemy pool before `asyncio.run()`
closes the current loop. A later Stage 3 attempt therefore opens fresh asyncpg
connections on its own loop instead of reusing a connection bound to an earlier
task loop. This is execution-lifecycle cleanup only: retry identity, intent and
attempt state, audit capture, snapshot schema, formulas, decisions, and frozen
historical records are unchanged.

Run creation and the worker handoff use a bounded three-layer recovery contract:

1. The preferred primary path persists a client-generated run ID, task ID, and
   `QUEUED` lifecycle before publishing once to the dedicated `auto_live` queue.
2. If the primary publish fails immediately, or the durable lifecycle remains
   strictly `QUEUED` beyond `AUTO_LIVE_PRIMARY_HANDOFF_TIMEOUT_SECONDS` (default
   `30`), the same run ID and Celery task ID are dispatched once to
   `CELERY_AUTO_LIVE_FALLBACK_QUEUE` (default `ai`). `RESERVED`, `STARTED`, or
   `RETRYING` work never enters this fallback.
3. If neither queue claims the task within
   `AUTO_LIVE_FALLBACK_HANDOFF_TIMEOUT_SECONDS` (default `180`), and neither the
   Redis execution lease nor PostgreSQL advisory fence proves a live owner, the
   run is failed closed. Stage progress is terminalized and no inline or repeated
   AI execution is attempted.

Every layer is appended to `audit_metadata.execution_handoff` with the approach,
queue, trigger time, reason, and validation result. Audit timelines expose these
entries as `execution_handoff` events. Deterministic validation rejects duplicate
or out-of-order fallback stages, missing trigger evidence, a non-failed tertiary
result, or a mismatch between `request_context.client_run_id` and the durable run
ID. A still-live legacy run with a persisted `QUEUED` lifecycle can reconstruct
only that already-proven primary handoff before using the secondary; frozen
legacy snapshots without this additive metadata remain valid and are not
rewritten.

The browser also treats a timed-out `POST /polymarket/auto-live/run-once` as
ambiguous rather than failed. It never repeats the POST. It first reads the new
user-scoped `GET /polymarket/auto-live/runs/{run_id}` resource, then falls back
once to matching the existing run-history endpoint. The persisted client run ID
makes both reconciliation reads deterministic and prevents duplicate execution.
Status and mode use the focused persisted-status endpoint first, a schema-validated
summary adapter second, and an age-bounded account-scoped last-known-good cache
third. Automatic status retries are capped; fallback transitions and reasons are
logged without credentials or response bodies.

The Bullpen dashboard hydrates workflow progress from the additive
`GET /polymarket/auto-live/summary/dashboard` resource. It returns the existing
summary schema but includes only the latest full run in `recent_runs`; historical
run detail remains available through the existing run resources and the legacy
`GET /polymarket/auto-live/summary` contract is unchanged. This prevents every
progress poll from hydrating and serializing ten multi-megabyte frozen Stage 1
and Stage 2 snapshots. The projection changes no run inputs, evidence, formulas,
decisions, execution state, frozen payload, audit schema, validator, or legacy
backfill mapping.

The dashboard enforces a 150,000-byte wire budget by first reducing optional
decision rows and then optional expandable stage diagnostics. Section metadata
marks every omission as degraded or unavailable, while scheduler/settings and
durable identifiers remain authoritative. If even mandatory state cannot fit,
the route fails closed with a sanitized `503` and operators can use the focused
status and lazy detail resources. This response shaping is outside the frozen
audit snapshot and never changes stored evidence.

On worker recovery, persisted `running`/`confirming` work is reconciled only
through those lifecycle and lease checks. Runs with a healthy worker heartbeat or
queued/redelivered task are left alone.
Interrupted Stage 3 runs record `stage3_recovery` with
`status=aborted_recovery_required`, `required=true`, and
`automatic_resubmission=false`. Unsubmitted intents are deferred. Ambiguous or
persisted submissions move only to reconciliation. The explicit operator retry path
first checks remote order IDs, transaction hashes, and persisted submission
timestamps so it cannot issue a duplicate order.

While Stage 3 is visibly working, the console keeps its Stage 3 retry control
available. Invoking it stops the scheduler, cancels the active worker and its
unsubmitted intents through the existing backend stop contract, restores the
scheduler when it was enabled, and queues a new Stage 3 pass from the complete
persisted Stage 2 handoff. The control is disabled only while that retry request
itself is in flight (or when no reusable Stage 2 handoff exists). This is an
operator-control change only: cancellation, durable intent reconciliation,
duplicate-submission guards, audit capture, frozen snapshots, schema versions,
and legacy mappings retain their existing behavior.

When a running record contains a historical auth rejection but active doctor
auth is now healthy, the old error is recorded as stale in `auth_recovery`, the
interrupted record is closed, and it no longer blocks a new run. That close keeps
the existing decision rows in place and never replaces them, preserving linked
durable intents and their attempt history for explicit reconciliation or retry.
The audit captures `auth_recovery` and raises a critical blocking finding when a
recovered run retains live order plans but has lost its durable intents. Remote
writes re-read this recovery state immediately before submission. The explicit
same-run retry records `auth_recovery.operator_resume_at`; only that audited
operator transition clears the stale-auth recovery block, while all current
doctor, balance, capacity, quote, sizing, and duplicate-submission checks remain
active. Active-run discovery honors the same marker and must not close an
operator-resumed run again merely because its immutable history still contains
the original auth error.

Stage 3 `orders_planned`, `orders_processed`, `orders_submitted`, both execution-step
tiles, and the run-level order funnel are materialized from durable order-intent and
attempt records. `persisted_execution_counters.source` is
`persisted_order_intents`; validators reject contradictory counter orderings.

## Bullpen account-route support blocker

Stage 3 performs one run-level Bullpen Doctor check before durable order intents
are fanned out to individual execution workers. When Doctor returns a terminal,
support-owned Polymarket account-route error such as
`POLYMARKET_WALLET_ROUTE_UNCONFIRMED`, the run records the additive
`audit_metadata.stage3_support_blocker` object and pauses Auto Runs. The blocker
contains the sanitized code, message, source, timestamps, support ownership, and
`automatic_resubmission=false`; credentials and raw provider bodies are never
stored.

The exact Stage 2 Exit and Buy contract remains authoritative. Every unsubmitted
durable intent stays counted in Planned and is moved to `DEFERRED` with
`support_blocked=true`, `stage2_authoritative_plan_preserved=true`, and no next
automatic attempt. Execution-step projections report the step as `blocked`, with
Processed reflecting the durable preflight and Submitted remaining evidence-based
at zero. Intents that already contain a remote order ID, transaction hash, or
other persisted submission evidence are not rewritten and continue through normal
reconciliation.

A second fence re-reads the same run blocker immediately before any remote write,
so sibling tasks already reserved by Celery cannot bypass a blocker discovered by
another worker. Resuming later remains an explicit operator action after Bullpen
support confirms the route and fresh preflight reports `trade_ready=true`. This
metadata is additive; frozen historical runs that predate the blocker contract
remain valid and are not backfilled.

## Non-blocking portfolio balance refresh

The manual portfolio balance endpoint starts or coalesces the Bullpen refresh and
returns the current `loading` snapshot immediately. The browser polls the ordinary
bot-state resource until the background refresh is ready, retains the last usable
balance throughout, and confines timeout/unavailability messages to the portfolio
card. This presentation/runtime change does not modify Stage 1 evidence, the Stage
2 actionable contract, durable Stage 3 intents, or frozen audit snapshots.

# Lightweight run-list projection

`GET /polymarket/auto-live/runs` preserves the historical response shape but
omits stage payloads, request context, diagnostics, identifiers, and audit
metadata by default. These frozen facts remain unchanged and available from
`GET /polymarket/auto-live/runs/{run_id}`. Explicit diagnostic callers may pass
`include_detail=true`; ordinary list and initial-render callers must use the
lightweight projection. This is a presentation-only projection and does not
rewrite or version any frozen audit snapshot.

The console can receive the same run as both a compact `latest_run` projection
and a richer `recent_runs` entry. Before rendering the worker-stage monitor, it
reconciles those same-ID copies: current status remains authoritative from the
latest projection, while completed Stage 1 and Stage 2 counts and frozen evidence
remain sourced from the richer copy. This prevents completed metrics from
disappearing or changing to fallback zeroes when Stage 3 publishes a compact
update; frozen snapshots and historical facts are not modified.

## Insufficient-evidence LLM estimates

The Stage 2 console treats an LLM output whose normalized `evidence_status` is
`insufficient` as non-contributing evidence. It remains visible in historical run
details, but is labelled excluded, has an effective consensus weight of zero, and
does not participate in displayed consensus odds. This is a deterministic
presentation and consensus-validation rule over already-frozen output fields; it
does not rewrite historical snapshots or change their schema version.
