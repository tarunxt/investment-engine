# Bullpen X AI reliability map

Last updated: 2026-07-27

This document is the route, ownership, performance, and rollback record for the
Bullpen X AI Auto-Live console. Frozen run-audit facts remain governed by
`docs/bullpen-run-audit.md`.

## Request and ownership matrix

| Resource or command | Browser owner / mount | Poll and deadline | Cache / dedupe | Server work | Mutation safety |
| --- | --- | --- | --- | --- | --- |
| `GET /polymarket/auto-live/status` | `BullpenAutoRunScheduleCard`; mounted once | initial; 2 s while active; bounded idle revalidation; browser 2 s, server 2 s | account-scoped last-known-good; status single-flight; hidden tabs stop active polling | one short SQLAlchemy session; settings/state scalar records and active-run identity only | read-only; no Redis, Celery, Bullpen CLI, recovery, or enqueue |
| `GET /polymarket/auto-live/summary/dashboard` | same active-workflow controller | initial idle callback; 2 s only while active and visible; browser/server 4 s | private/no-cache, ETag, GET single-flight where request signals permit | settings/state plus latest run and decision `console_projection`; cached auth verdict only | read-only; no recovery, commit, CLI, LLM, provider, audit materialization, or full run payload |
| `GET /polymarket/auto-live/history?page=&size=` | History dialog only | on open, retry, or page navigation; browser 5 s, server 4 s | private/no-cache; superseded and closed-dialog requests abort | database `COUNT`, `LIMIT`, and `OFFSET`; scalar run columns plus compact projection | read-only |
| `GET /polymarket/auto-live/runs/{id}` | selected history detail or ambiguous Start recovery | on selection/recovery; 10 s in history | no-store; selected request aborts with dialog | one user-owned full run payload | read-only; never used to repeat Start |
| `GET /polymarket/auto-live/runs/{id}/console` | selected History detail, then its active-run dialog | once on History selection; every 2 s only while that exact run remains active and the page is visible; browser 5 s, server 4 s | private/no-cache; one abortable request owned by the dialog | exact user-owned run projection, at most 32 decision projections, and at most 200 current decision IDs; no full payload | read-only; authoritative empty guardrails/IDs and the current decision identity set clear recovered or superseded state |
| `GET /polymarket/auto-live/runs/{id}/decisions` | selected history detail only | on selection; 10 s | no-store; selected request aborts with dialog | ownership scalar plus at most 200 full decisions for that run | read-only |
| `GET /polymarket/state` | Auto-Live portfolio cash/state owner | mount and every 30 s while visible | no-store; in-flight guard | persisted Polymarket bot state; no forced wallet command | read-only |
| `GET /api/bullpen-ai/positions?passive=true` | `BullpenAiPageClient`, the live position owner | mount and every 60 s while visible | server session; distributed runtime snapshot cache; in-flight guard | passive centralized-broker snapshot read plus bounded enrichment/fallback | passive read; explicit manual refresh alone requests fresh runtime work |
| `GET /polymarket/auto-live/settings` | prompt editor only | once before editor mount; 4 s | no-store | persisted settings | read-only; keeps prompt text off active polling |
| scheduler controls | schedule card buttons | one request per click; optimistic in-flight label | mutation transport has no alternate-origin replay | persist state and return; long work remains Celery-owned | existing idempotent state semantics; conflicting duplicate buttons disabled |
| `POST /run-once` | Start Now | one client run ID per click | never replayed after transport ambiguity | persist run and task handoff, enqueue `auto_live` | reconciliation reads exact client run ID |
| Stage 3 retry/order controls | explicit operator controls | one command in flight | mutations never direct/proxy replay | durable intent/generation/lease path | remote evidence is reconciled before retry |

The useful first paint has four critical application reads: persisted status,
compact workflow summary, passive positions, and persisted Polymarket state.
History, full run payloads, prompt text, audit material, and historical cost
tables do not load until their owning dialog/section opens.

## Data flow and compatibility

`x0y1z2a3b4c5` adds nullable `console_projection` JSON columns to Auto-Live
runs and decisions. A normal run/decision save writes both the unchanged full
payload and bounded projection version 1. Operational summary/history queries
select the projection and scalar columns, so PostgreSQL does not decompress the
large `payload` TOAST value.

The dashboard response has a hard 150,000-byte application budget. It
deterministically drops optional decision rows and expandable diagnostics first,
labels the affected section degraded or unavailable, and preserves focused
scheduler/settings state. It returns a sanitized `503` only if mandatory state
itself cannot fit; it never disguises an oversized response as empty success.

Existing rows are not rewritten during deployment. A compact legacy row exposes
its scalar facts and `projection_available=false`; it does not fabricate stage
facts. Existing `/summary`, `/runs`, `/runs/{id}`, and `/decisions` routes retain
their response shapes. The prompt remains available through `/settings` and the
legacy summary; the active dashboard intentionally omits prompt text.

The projection is display-only. It cannot feed Stage 1 filtering, Stage 2
ranking, Stage 3 sizing, guardrails, duplicate detection, order submission,
retry, reconciliation, or audit hashing.

The scheduler state also retains one small Stage 1-only verified portfolio DTO.
It is not a second execution source: it is a last-known-good console fallback
containing at most ten rows per active, claimable, settlement-pending, and
excluded partition plus exact pre-truncation active-row total, truncation,
occupancy, cash, slot, account-lineage, credential-artifact, classifier,
source, and freshness metadata. Both wallet status and freshness must
explicitly be `fresh`; the canonical Stage 1 row must be completed with
`pass`/`warning` and have neither a wallet-refresh nor market-enrichment
error. A newer candidate-only, cached, degraded, missing-lineage, or failed
Stage 1 snapshot cannot replace the prior verified snapshot.

The browser applies the same lineage boundary to its last verified live wallet
snapshot. A background, post-run, preflight, or manual refresh may
automatically re-baseline rotated credential-artifact or position-classifier
lineage only when the response is a complete, fresh, usable live snapshot for
the same explicit account. Account identity changes and missing-lineage,
cached, degraded, or error-bearing responses remain blocked from replacing
the prior verified baseline or triggering auto-claim. The previous verified
snapshot remains visible with a sanitized warning. The portfolio card renders
the non-secret abbreviated account identity, snapshot source, and classifier
version for live and Stage 1 fallback snapshots; it never renders credential
paths or credential contents.

Exact wallet-market enrichment uses one shared Gamma HTTP client, a fixed
lookup cap, bounded concurrency, per-request timeout, and an overall deadline.
Diagnostics retain exact totals with bounded samples. Any positive exposure
whose exact identity or tri-state open/closed status remains unknown is
quarantined as stale, remains conservatively occupied, and blocks execution.

Stage 3 also fences unresolved durable BUYs independently of the wallet view.
Under one singleton Bullpen-account PostgreSQL lock, reservation checks match
market ID, condition ID, and slug across runs and outcome sides. An ambiguous
or unknown-fill terminal BUY remains in the Top-10 denylist and pre-write
database fence until explicit definitive-zero-fill reconciliation; terminal
run status and a later exit cannot silently make an unresolved remote order
safe. The per-intent and per-attempt audit proof records a zero-conflict result
before any live BUY write. A separate v2 singleton-cash proof also preserves
the balance timestamp and counts consumed fills newer than that balance, so a
different-market BUY cannot spend collateral already consumed by a concurrent
fill.

## Queue topology

```text
auto_live -> investor-celery-auto-live-worker  concurrency 1, prefetch 1
ai        -> investor-celery-worker            concurrency 1, prefetch 1
email     -> investor-celery-email-worker      concurrency 1, prefetch 1
beat      -> investor-celery-beat-worker       periodic recovery/dispatch
```

The old primary pool had two children consuming `ai,email`. The new topology
reallocates those same two children, so email cannot reserve Stage 3 capacity
and no same-host concurrency is added. `/health/ready` treats PLANNED, READY,
RETRY_WAIT, SUBMITTING, SUBMITTED, CONFIRMING, PARTIALLY_FILLED,
SETTLEMENT_PENDING, WAITING_FOR_COLLATERAL, and WAITING_FOR_EXIT as work that
requires an `ai` consumer.

## Baseline evidence

Read-only production workflow run `30205980284` observed:

| Signal | Before change |
| --- | ---: |
| Auto-Live run relation | about 785 MB total; about 368 KB main heap |
| Audit blob relation | about 5.2 GB |
| primary Celery child CPU | about 98-100% each |
| guest CPU steal | about 71-72% |
| EC2 CPU credit balance | latest 0.18; observed minimum 0.06 |
| Redis | PONG; about 9.7 MiB; sampled average 2.40 ms |
| PostgreSQL connections | 7; 1 active; idle-in-transaction observed |
| memory / disk | about 5.2 GiB available; disk about 20% |

The evidence separates two causes: active console reads decompressed giant
TOAST payloads, while the burstable host was independently CPU-credit starved.
The repository change removes the first cause and reduces Stage 3 queue
contention. It cannot remove the EC2 credit ceiling.

Synthetic serialization of an adversarial run:

| Representation | Bytes |
| --- | ---: |
| complete run | 12,043,208 |
| console projection | 36,164 |
| one history tile | 3,614 |

A second 30-iteration fixture capture measured the transformation itself:

| Operation | p50 | p95 | worst | Encoded bytes |
| --- | ---: | ---: | ---: | ---: |
| complete run serialization | 6.623 ms | 6.911 ms | 7.219 ms | 2,947,280 |
| console projection construction | 0.061 ms | 0.085 ms | 0.135 ms | 7,072 |
| one history tile construction | 0.008 ms | 0.018 ms | 0.045 ms | 1,057 |

These are deterministic local serialization measurements, not a claim about
production network latency. Post-deploy `Server-Timing` and response headers
remain the authoritative route measurements.

## Operator command semantics

- Enable persists scheduler state and next-cycle inputs; it does not submit an
  order.
- Start Now creates one durable client run ID and publishes one handoff.
- Pause blocks new scheduled work under the existing current-run contract.
- Resume clears pause without creating another active run.
- Stop disables future scheduling and preserves submitted/ambiguous evidence.
- Kill targets the selected run task, terminalizes unfinished local work, and
  leaves submitted/ambiguous intents for reconciliation.
- Emergency Stop persists the global write block before acknowledgement;
  reconciliation reads remain allowed.
- Clear Emergency Stop is explicit and does not imply a new run or order.
- Stage 3 retry uses the saved Stage 2 handoff and generation/evidence checks.

Mutations use a single transport attempt. A browser timeout is ambiguous and is
resolved by durable reads, never by automatically issuing the mutation again.

## Rollback

Application rollback is a normal deploy of the previous commit. The additive
nullable projection columns may remain safely in place while old code runs. If
the migration itself must be downgraded, stop new-code writers first, deploy old
code, then run `alembic downgrade -1` through the production deployment
mechanism. Do not delete run payloads or frozen audit blobs.

Rollback immediately if readiness loses the `ai` consumer, response schemas
regress, portfolio lineage becomes inconsistent, durable terminal intents
regress, or any duplicate-write risk is observed.

## Remaining infrastructure decision

The host remained at its CPU-credit floor with extreme steal. If post-deploy
measurements still breach latency targets, move latency-sensitive workers off
the web host or migrate to a non-burstable instance sized from measured p75/p95
CPU. Do not increase concurrency on the current two-vCPU host. This
infrastructure change requires explicit operator approval.


<!-- UNIFIED_AUTO_RUN_TRIGGER_TEMPLATE -->
## Unified Auto-Run trigger template

All full Bullpen Auto-Run triggers now converge on
`BullpenAutoLiveBot.run_once`, which is the canonical durable run template. The
calendar/custom start time, the immediate **Start Auto Run Now** action, and the
fixed fallback slots at 00:00, 06:00, 12:00, and 18:00 IST differ only in how
they create a trigger. After that point they share the same run persistence,
guardrails, audit metadata, queue handoff, worker stages, retries, and Stage 3
execution path.

The immediate action no longer waits for the browser to build a candidate
snapshot before queueing. It starts the scheduler, immediately calls the
canonical run endpoint without a client snapshot, and lets Stage 1 build the
current authoritative backend scan exactly like scheduled execution. Explicit
stage-only operator actions may still provide a request context because they are
not full Auto-Run triggers.
