# Cred-X runtime performance investigation

Date: 2026-07-26

## Executive result

The dominant dashboard bottlenecks were browser work and request fan-out, not DNS
or the public API hostname. In an equivalent three-run production-build test, the
throttled-mobile dashboard improved as follows:

| Metric, first visit | Before | After | Change |
| --- | ---: | ---: | ---: |
| Meaningful dashboard content | 5,013.8 ms | 2,369.6 ms | -53% |
| LCP | 4,756 ms | 2,180 ms | -54% |
| TBT | 623 ms | 57 ms | -91% |
| JavaScript transferred | 625,268 B | 214,493 B | -66% |
| JavaScript decoded | 1,958,538 B | 691,089 B | -65% |
| Initial requests | 59 | 21 | -64% |
| Initial API requests, including session/theme | 14 | 3 | -79% |
| Critical API completion | not separately marked | 2,043.2 ms | within 3 s target |

The optimized dashboard has one portfolio-data request. The other two measured
authenticated requests were Auth.js session bootstrap and the private theme
preference. There were no duplicated initial reads.

Bullpen AI transferred substantially less code and did far less main-thread work,
but its interactive-ready time did not materially improve on throttled mobile.
That remaining route is not presented as a usability win:

| Metric, first visit | Before | After | Change |
| --- | ---: | ---: | ---: |
| Shell visible | 3,420 ms | 2,367.5 ms | -31% |
| LCP | 3,416 ms | 3,144 ms | -8% |
| TBT | 633 ms | 88 ms | -86% |
| JavaScript transferred | 775,752 B | 353,360 B | -54% |
| JavaScript decoded | 2,526,276 B | 1,217,035 B | -52% |
| Initial requests | 61 | 31 | -49% |
| Initial API requests | 9 | 8 | -11% |
| Critical API completion | not separately marked | 3,048.8 ms | above target |

## Measurement method and evidence

`frontend/scripts/performance-audit.mjs` records browser navigation timing,
FCP/LCP/CLS/INP, long tasks and TBT, shell and meaningful-ready markers, JavaScript
and CSS transfer/decoded bytes, API waterfalls, response bytes, `Server-Timing`,
duplicate reads, and route-to-route navigation.

The authenticated before/after control used:

- the unchanged `origin/main` commit and this branch, each built with the
  production webpack and standalone settings;
- the same Chromium version, machine, compact response fixtures, and synthetic
  local Auth.js identity;
- three first and repeat runs on 1440 px desktop and Moto G4 with 4x CPU,
  150 ms latency, 1.6 Mbps down, and 750 Kbps up;
- no production credential, account data, broker call, mutation, or trading
  action.

Evidence:

- `performance-results/baseline-authenticated-local.json`
- `performance-results/after-local.json`
- their Markdown companions
- `performance-results/baseline-public.json`
- Lighthouse mobile and desktop login artifacts in `performance-results/`

The production public-login baseline was also measured directly at
`https://cred-x.in`: mobile first-visit LCP was 1,884 ms, TBT 56 ms, and usable
time 2,086.5 ms. Lighthouse reported mobile LCP 2.257 s and a 0.97 performance
score. The login route therefore already met the 2.5 s LCP goal. Before this
change it still issued two identical `/api/auth/session` requests despite being
public; the route-scoped provider change removes that dependency.

Production authenticated before-results could not be collected because no
performance test-account secret was available. The local identity is deliberately
synthetic, and the report does not claim it is production account data. A
production rerun can use `PERF_TEST_EMAIL` and `PERF_TEST_PASSWORD`; the harness
does not print either value.

## Equivalent route results

### Throttled mobile medians

| Route and visit | Shell/usable before | Shell/usable after | LCP before | LCP after | TBT before | TBT after | JS before | JS after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Login first | 1,820.7 ms | 1,842.9 ms | 1,776 ms | 1,592 ms | 51 ms | 53 ms | 180,109 B | 176,454 B |
| Login repeat | 1,815.4 ms | 1,839.9 ms | 1,772 ms | 1,580 ms | 42 ms | 46 ms | 180,109 B | 176,454 B |
| Dashboard first | 5,013.8 ms | 2,366.8 ms | 4,756 ms | 2,180 ms | 623 ms | 57 ms | 625,268 B | 214,493 B |
| Dashboard repeat | 5,009.7 ms | 2,372 ms | 4,684 ms | 2,120 ms | 622 ms | 67 ms | 625,268 B | 214,493 B |
| Bullpen first | 3,420 ms | 2,367.5 ms shell | 3,416 ms | 3,144 ms | 633 ms | 88 ms | 775,752 B | 353,360 B |
| Bullpen repeat | 3,397.6 ms | 2,378.4 ms shell | 3,392 ms | 3,144 ms | 632 ms | 84 ms | 775,752 B | 353,360 B |

Local standalone static responses do not reproduce production Nginx/browser
immutable-cache behavior, so first/repeat transferred bytes remained similar.
Production hashed assets have a one-year immutable policy.

### Desktop medians

| Route and visit | Usable before | Usable after | LCP before | LCP after | TBT before | TBT after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Login first | 84.4 ms | 77.1 ms | 92 ms | 88 ms | 0 ms | 0 ms |
| Dashboard first | 340.5 ms | 150.9 ms meaningful | 348 ms | 180 ms | 97 ms | 0 ms |
| Bullpen first | 480.8 ms | 114.3 ms shell / 508.5 ms interactive | 432 ms | 520 ms | 94 ms | 0 ms |

Dashboard-to-Bullpen client navigation after both route chunks were warm was
74.1 ms before and 108.7 ms after on desktop, and 624.5 ms before and 569.7 ms
after on throttled mobile. The variation is small relative to cold route cost and
is not claimed as a material desktop improvement.

## Root causes ranked by measured impact

1. **Dashboard route graph and eager prefetch/mount work.** The dashboard pulled
   the 789 KB syntax/Markdown chunk, rebalance workflow, final-actionable tables,
   charts, histories, editors, and route chunks that were not above the fold.
   CSS-hidden Bullpen controls also mounted and polled. This produced 1.96 MB of
   decoded JavaScript and 623 ms mobile TBT.
2. **Dashboard request fan-out.** The initial dashboard made separate status,
   India, US, Polymarket, Bullpen, threat, event, run, FX, and duplicated session
   reads. Independent request setup and large response models delayed useful
   content even when the underlying services were fast.
3. **Client-only authentication gate.** The complete console child tree waited
   for `SessionProvider` hydration. Strict/effect behavior caused duplicate
   session resolution, and a failed session request could leave the loading gate
   indefinitely.
4. **Unbounded serial API failover.** Ordinary reads could spend a full six
   seconds on the configured transport and then start a second timeout on the
   proxy. The direct API is currently healthy, so this was a latent high-severity
   tail-latency defect rather than the median production bottleneck.
5. **Burst CPU contention on the shared host.** The production `t3.large` has two
   vCPUs. During the read-only snapshot, two AI/email Celery children each used
   approximately one full CPU and `vmstat` recorded 71% CPU steal for four
   consecutive samples. Load was 3.20 on two vCPUs. This explains intermittent
   backend and database scheduling delay during worker bursts, although it does
   not explain the dashboard's deterministic browser delay.
6. **Single-host data growth and process leakage.** Production inspection found
   `aidb` at 5.497 GB, `bullpen_run_audit_blobs` at 4.595 GB (almost entirely
   TOAST), and `polymarket_auto_live_runs` at 785 MB. It also found a stale Next
   process rooted in a deleted release directory. These are operational risks,
   but the browser-controlled results prove they were not the primary cause of
   the dashboard's deterministic mobile delay.

## API transport decision

The production direct API was healthy from public browser-compatible checks:

- `api.cred-x.in`, `cred-x.in`, and `www.cred-x.in` resolved to
  `13.233.155.36`;
- the API certificate covered the hostname;
- credentialed CORS allowed both public website origins;
- repeated direct health requests were approximately 43–67 ms, versus
  approximately 53–64 ms through `/backend-api`.

The canonical production read transport remains `https://api.cred-x.in`.
The same-origin proxy remains the fallback. A per-origin circuit now:

- gives the direct primary at most 1.5 s inside one 5 s logical-read deadline;
- opens after two retryable failures for 30 s;
- sends reads to the proxy while open;
- permits one bounded direct recovery probe after cooldown;
- closes on direct recovery;
- never replays successful mutations;
- retains in-flight identical-GET deduplication.

## Implemented fixes

- Server-resolved console authentication with token-free user/session props,
  route-scoped providers, one deduplicated token bootstrap, and bounded failure
  behavior. Access and refresh tokens remain in the encrypted Auth.js/session
  path and are not rendered into HTML.
- Auth providers removed from the public root layout, eliminating public-login
  session reads.
- `GET /dashboard/summary`, with three independent sections loaded concurrently,
  stored snapshots only, four holdings and twelve history points maximum,
  per-section degradation/freshness/timing, stable ETag, and private revalidation.
- Dashboard initial render reduced to the summary; threats mount on visibility,
  while rebalance histories, prompts, action tables, audits, and detailed reports
  move to explicit route links. The complete multi-stage automated workflow is
  preserved at `/console/automated-rebalance`; it is not bundled or prefetched
  by the dashboard.
- Bullpen legacy CSS-hidden controls no longer mount by default; inactive polling
  observes document visibility; route links no longer prefetch large consoles.
- Structured request timing with correlation ID, auth time, SQL query count/time,
  Redis, external, serialization, response bytes, and non-sensitive
  `Server-Timing`.
- Nginx HTTP/2 syntax, TLS session cache, upstream keepalive, immutable hashed
  assets, JSON buffering, gzip, and explicit private/no-store rules for console,
  Auth.js, and proxy data. WebSocket buffering remains disabled.
- CI regression contracts for response size, bounded collections, partial
  dashboard failure, circuit behavior/recovery, deduplication, server auth,
  hidden-control mounting, Nginx policies, and per-route JavaScript budgets.
  The selected production Webpack login budget remains 700 KB; the benchmark-only
  Turbopack build has an explicit 800 KB allowance for its additional shared
  chunk.

## Response-size audit

No full run, audit, prompt, model Markdown, order history, or raw Polymarket state
is used by the initial dashboard. The new fixture response is under 150 KB and
excludes raw fields; the measured compact response was 1,993 B. Existing run
list paths retain summary models, prompt previews, pagination, and a client cap
on full-run retrieval. Detail and audit material remain explicit detail-route
loads.

The largest production tables are not automatically deleted or rewritten. Frozen
Bullpen audit compatibility and user financial history are preserved. Retention,
deduplication, or archival of audit blobs needs a separate migration and product
retention decision.

## Changes that did not improve meaningful time

- Loading skeletons were not counted as useful content.
- Dynamic import by itself did not remove dashboard code because the dashboard
  still statically imported the rebalance event constants from the 5,000-line
  implementation. Moving those constants to a tiny module and removing the
  detailed dashboard workflow was the change that actually removed the chunks.
- Bullpen bundle and TBT reductions did not materially improve mobile
  interactive-ready time. More decomposition of `BullpenAiPageClient` into
  route-level islands remains necessary.
- No database index was added without an `EXPLAIN ANALYZE` plan proving value.
- Process counts and EC2 size were not changed speculatively.

## Production host and data-service evidence

The branch's read-only production inspection ran through the existing
GitHub-to-host workflow. It recorded:

- a `t3.large` in `ap-south-1b`, with two vCPUs, seven Celery worker processes,
  one Uvicorn worker, and two stale `next start` shell processes;
- 7.6 GiB RAM with 5.2 GiB available; 593 MiB of swap allocated but no swap-in or
  swap-out during the samples; 19% disk use and 0% I/O wait;
- two active Celery children at 98-100% CPU while the guest received only 29% CPU
  and reported 71% steal; seven-day EC2 CPU averaged 31.44% and reached 100%;
- seven PostgreSQL connections with one active. Two Celery connections were
  observed `idle in transaction`, which should be traced separately even though
  connection count was not exhausted;
- Redis latency averaging 0.20 ms, 10.19 MiB used, and no configured memory cap;
- the 12-point INDmoney summary query at 1.424 ms. The 13-row Zerodha iterator
  took 4.556 ms, but its end-to-end `EXPLAIN ANALYZE` elapsed time was 142.275 ms
  while the host was CPU-starved. The plan did not scan an unbounded history, so
  this snapshot does not justify a speculative index.

Memory, disk, Redis, and PostgreSQL connection capacity were not the limiting
resources in this sample. CPU scheduling during Celery work was. The report tool
now records current and minimum CPU-credit values as well as seven-day averages
so a follow-up sample can distinguish exhausted T-series credits from underlying
host steal.

## Remaining manual infrastructure actions

1. Remove the stale Next process only after confirming it is not referenced by
   the active systemd unit.
2. Decide a retention/archive policy for Bullpen audit blobs; do not delete
   frozen audit data ad hoc.
3. Re-run authenticated production Playwright with a secret test account.
4. Run the updated resource report across several worker bursts. If CPU credits
   reach zero with high steal again, move the AI/email Celery queue off the web
   host or replace the burstable instance with a non-burstable instance sized
   from p75/p95 CPU. Do not increase worker concurrency on the current two-vCPU
   host.
5. Trace and close Celery transactions that remain idle across task boundaries.
   PostgreSQL did not need to be moved based on this sample alone.
6. A CDN can reduce static distance/transfer time; apply only the safe rules in
   `docs/cdn-performance.md`.

## Security and correctness review

- Summary cache and browser storage keys are user-scoped.
- Summary responses are `private, no-cache` and never publicly cached.
- No external broker, Polymarket CLI, LLM, or refresh action runs during summary
  reads.
- Section failures are explicit and logged; one failure does not falsify the
  other sections.
- Existing detail, refresh, trading, worker, retry, and audit APIs are retained.
- No schema migration, destructive data action, or authentication relaxation is
  part of this change.
