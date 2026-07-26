# Performance hardening follow-up

Generated 2026-07-26. Baseline: `origin/main` at
`675b7e5fe294af01f8958bf4e4b7ecc60b5a6704`. Candidate branch:
`codex/performance-hardening-followup`.

## Release decision

Do not merge yet.

The code-level P0 defects listed in this follow-up have executable regression
coverage, but authenticated production validation cannot run because the
repository does not contain `PERF_TEST_EMAIL` or `PERF_TEST_PASSWORD`. The
branch-safe deployment workflow also allows production deployment only from
`main`. Merging to obtain production evidence would violate the requirement not
to merge before authenticated validation, so zero candidate production
deployments were attempted. No financial mutation, broker refresh, AI run, or
trade was performed.

The missing secrets and the two required successful frontend-only deployments
remain release blockers. The pull request must stay unmerged until an operator
adds the read-only performance account secrets, runs the authenticated matrix,
and records two successful frontend-only deployment timing summaries.

## Ranked root causes and code outcomes

1. **P0 financial presentation was not trustworthy.** Sparse portfolio history
   generated synthetic chart points and dashboard conversion used a hard-coded
   USD/INR value. The candidate renders an explicit insufficient-history state,
   accepts only genuine source points, and reads a verified persisted FX rate.
   Dashboard, API-usage, provider-estimate, run-detail, scan-history, Bullpen,
   and rebalance conversion paths no longer contain an arbitrary fallback or
   perform synchronous provider reads. The FX record carries value, source,
   source timestamp, age, and validity. A 36-hour stale boundary is tested.
   Missing or stale FX keeps native USD values and omits INR conversions and
   combined INR totals.
2. **P0 authentication still blocked real content on client bootstrap.** The
   server-validated identity now renders the console shell and route content
   immediately. Access and refresh tokens remain inside the encrypted Auth.js
   JWT and server-only helpers. The browser uses the same-origin BFF and cannot
   submit an Authorization token through the API helper. Failed client session
   reconciliation is finite and recoverable.
3. **P0 private-data provenance and isolation were incomplete.** Dashboard
   displays now identify server/live, stored snapshot, or browser-cache origin
   and age. Cache ownership is reconciled by user ID and private dashboard and
   Bullpen keys are purged on logout or account change. The shared Bullpen
   runtime is explicitly an administrator-only singleton; non-admin access is
   rejected instead of silently ignoring identity.
4. **P1 API failover had no real half-open state.** The candidate has explicit
   closed, open, and half-open state per origin, one logical recovery probe,
   stage-based primary budgets, one absolute deadline across fallback and
   refresh, mutation transport pinning, and identity-aware request
   deduplication. Independent cancellation remains independent.
5. **P1 initial responses selected or serialized detail data.** Run lists now
   load a persisted prompt preview rather than a complete prompt. Dashboard top
   holdings and invested totals are persisted summaries rather than reductions
   over large holdings JSON. List and history caps are enforced, Auto-Live list
   models omit detail output, and full run/audit/history data remains on
   explicit detail routes.
6. **P1 route graphs mounted hidden work.** Dashboard and Bullpen now return
   meaningful server-rendered summaries. Large interactive clients are loaded
   only after explicit interaction, hidden clients do not mount or poll, and
   the Playwright test proves their chunks and requests are absent before
   interaction. The global 404 component was also found to pull the full URL/API
   registry into every route; removing that static dependency brought login
   back under the baseline-relative JavaScript gate.
7. **P0 rollback proof was textual rather than behavioral.** The temporary
   deployment harness now exercises symlinked app roots, active/inactive slots,
   checksummed extraction, fake services and Nginx, candidate verification, and
   11 injected failures. Every post-promotion failure restores and verifies the
   previous pointer/runtime while retaining the candidate and preserving the
   active slot. Frontend-only cases prove no backend or Celery command runs.
8. **Infrastructure CPU contention remains.** Existing evidence shows a
   two-vCPU `t3.large`, near-zero CPU-credit balance, 71% steal during worker
   activity, and two Celery children each consuming approximately one CPU.
   Redis latency, PostgreSQL connection count, memory, disk I/O, and the sampled
   SQL plans did not justify speculative cache, database, index, or hosting
   changes.

## Current-main versus candidate evidence

| Measure | Current main or current production | Candidate |
| --- | ---: | ---: |
| Synthetic history on sparse input | Present | 0 points; insufficient state |
| Dashboard USD/INR fallback | Hard-coded | Persisted verified rate only |
| Authenticated child render gate | Present | Removed |
| Circuit states | failure count/open-until | closed/open/half-open |
| Frontend executable tests | baseline narrow set green | 298/298 |
| Targeted backend hardening tests | not present | 29/29 |
| Deployment/scope tests | textual rollback checks | 55/55, including 11 injected failures |
| Login initial JS, transferred | production baseline 176,383 B | artifact 192,441 B |
| Login initial JS, decoded | production baseline 567,403 B | artifact 613,395 B |
| Dashboard initial JS, decoded | prior optimized baseline 691,089 B | artifact 739,227 B |
| Bullpen initial JS, decoded | prior optimized baseline 1,217,035 B | artifact 747,781 B |
| Dashboard summary fixture | no dedicated multi-route suite | 2,746 B |
| Runs summary, 100 fixtures | prompt selected | 67,144 B |
| Auto-Live runs, 50 fixtures | detail-heavy | 106,641 B |
| Threat history, 100 fixtures | capped after follow-up | 45,503 B |
| Audit list, 100 fixtures | capped summary | 123,140 B |

All artifact JavaScript routes pass a fixed maximum and a baseline-relative gate
that rejects more than 10% unexplained growth. Transfer and decoded bytes are
tracked separately. The standalone artifact verifier also exercises Auth.js,
authenticated BFF proxying, token non-disclosure in dashboard/Bullpen HTML and
RSC, route rendering, fingerprints, and JS/CSS serving.

The seven-sample public production control measured throttled-mobile first-visit
login p75 LCP at 1,652 ms, TBT at 53 ms, and usable content at 2,064.8 ms. This
satisfies the public login LCP criterion. It is evidence for the currently
deployed public route, not evidence for an authenticated candidate deployment.

## Response-size audit

The machine-readable inventory is
`performance-results/high-traffic-response-inventory.json`. It records caller
and render phase, selected columns, caps, fixture compressed/uncompressed size,
available timing percentiles, and inclusion of prompt, model output, audit blob,
or order history. Route and database p50/p75 values that require production
instrumentation remain `null`; they were not invented. An executable schema
test keeps the required route coverage and the 250 KB measured initial-response
ceiling.

Residual response risks:

- the full legacy `/runs` list remains an explicit-detail compatibility path,
  capped at 20 and guarded at 1 MB; clients should keep using `summary=true`;
- the latest Auto-Live dashboard object can still contain a full latest run;
- the latest INDmoney portfolio detail screen intentionally retains parsed raw
  text for explicit portfolio inspection;
- production route/database/serialization percentiles require the blocked
  authenticated run.

## Validation record

- Frontend Node tests: 298 passed.
- Targeted backend financial/auth/response tests: 29 passed.
- Deployment, scope, packaging, and rollback tests: 55 passed.
- Inventory and JavaScript budget tests: 5 passed.
- TypeScript: passed.
- ESLint: 0 errors, 2 pre-existing unused-variable warnings.
- Webpack standalone build: passed.
- Packaged runtime: approximately 15 MB; verified in 1.38 seconds.
- Auth/render/lazy Playwright hardening suite: passed.
- Alembic metadata: one head and 45 registered model tables. Migration
  generation/application was not run because Docker is unavailable and project
  rules require Alembic execution inside the backend container.

The complete candidate backend suite reports 595 passed and 43 failed (one new
hardening test accounts for the additional pass). A detached pristine
`origin/main` worktree reports 594 passed and 43 failed and reproduced all seven
sampled signatures, including
missing local `aiosqlite`, an existing missing `asyncio` test import, unchanged
Bullpen executor mocks rejecting `extra_env`, Auto-Live failures, and unchanged
provider/net-worth expectations. Those baseline failures were not broadened
into this hardening task and must not be represented as candidate regressions.

## Deployment measurement status

Instrumentation now records checkout, dependency restore, Webpack build,
packaging, artifact upload/download/transfer, remote extraction, candidate
verification, service restart, smoke verification, and total duration. Raw logs
are uploaded as workflow artifacts. The deployment script emits machine-readable
per-phase timing records, which the workflow includes in its concise JSON timing
artifact; detailed logs are not committed to the repository.

No candidate production timing is claimed. The requested two frontend-only
deployments and the 60% improvement target are unresolved because the workflow
is main-only and this branch cannot be merged before authenticated production
validation. The previous comparison point remains approximately 18 minutes for
the full-stack path. Do not weaken checks if the eventual frontend-only result
misses seven minutes; report the dominant measured phase.

## Authenticated production validation status

The repository currently has `APP_PATH`, `EC2_HOST`, `EC2_SSH_KEY`, and
`EC2_USER`. It does not have `PERF_TEST_EMAIL` or `PERF_TEST_PASSWORD`.
Therefore:

- zero authenticated production samples are claimed;
- warm shell, dashboard freshness, Bullpen meaningful readiness, navigation,
  Server-Timing, host contention, and worker-activity criteria remain blocked;
- no credentials were printed, committed, or placed in an artifact;
- the pull request must remain unmerged.

After the secrets are added, run at least seven samples per desktop/mobile,
first/repeat, both navigation directions, low-worker and representative-worker
activity. The test must remain read-only and capture the full browser, API,
Server-Timing, host CPU/credit/steal, Redis, PostgreSQL, and Celery matrix.

## Infrastructure implementation plan

No AWS change was made. The existing evidence justifies comparing these two
options, but not changing instance type automatically.

### Option 1: isolate AI and email Celery workers

Use a separate fixed-performance x86 compute host, initially evaluate
`c7a.xlarge` (4 vCPU, 8 GiB), while leaving web, PostgreSQL, Redis, and the
frontend on the current host. C7a is compute-optimized and every vCPU maps to a
physical core. Before selection, confirm seven-day worker memory p75/p95; if the
workers need more than the safe 8 GiB envelope, choose a larger-memory fixed
family rather than adding concurrency.

Implementation sequence:

1. Measure per-queue CPU, RSS, task latency, and failure rate for seven days.
2. Define the worker host in infrastructure as code with encrypted EBS, IMDSv2,
   least-privilege instance profile, and private connectivity.
3. Route only AI/email queues to the new host. Preserve current task concurrency
   initially.
4. Canary read-only/email-safe tasks, then compare web p75 latency, task p75/p95,
   CPU steal, credit balance, queue depth, and failure rate.
5. Keep a documented queue-routing rollback and do not move PostgreSQL or Redis
   without separate evidence.

Cost model: current `t3.large` cost remains, plus
`730 * ap-south-1 c7a.xlarge on-demand hourly rate`, EBS, monitoring, and any
cross-AZ transfer. Benefit is the strongest failure-domain and CPU-scheduling
isolation. Risks are a second host to patch/observe, queue-network dependency,
and duplicated base storage.

### Option 2: replace the shared burstable host

Evaluate `m7a.xlarge` (4 vCPU, 16 GiB) as the fixed-performance general-purpose
starting point. It preserves the single-host topology and provides four
physical-core vCPUs without T-family credit accounting.

Implementation sequence:

1. Confirm x86 package and agent compatibility and capture a restorable image.
2. Create a launch template and rehearse a replacement with the same encrypted
   EBS and systemd service definitions.
3. Stop writes for a bounded cutover, attach/restore durable storage safely,
   validate PostgreSQL/Redis, then start services in dependency order.
4. Run authenticated smoke and rollback drills before declaring the replacement
   active.
5. Compare p75/p95 CPU, load, steal, web latency, worker task latency, and cost
   for at least seven days.

Cost model:
`730 * (ap-south-1 m7a.xlarge hourly rate - t3.large hourly rate)` minus avoided
T3 surplus-credit charges. Benefit is lower operational complexity and more
memory. Risk is that web, data services, and workers still share one failure and
contention domain.

Option 1 is the preferred architectural test because it directly removes the
measured worker/web contention. Option 2 is the lower-complexity fallback. Exact
Mumbai on-demand prices were not inserted because the local AWS session is
expired; obtain current Price List or AWS Pricing Calculator values before
approval. AWS documents T3 as burstable with Unlimited mode and separately
documents C7a as compute-optimized and M7a as general-purpose fixed performance.
Do not increase worker concurrency on the current two-vCPU host.

## Residual risks and attempted non-wins

- **Release blocker:** authenticated production performance is unmeasured.
- **Release blocker:** two frontend-only production deployments are unmeasured.
- **Release blocker:** migrations are not applied or rolled back in the required
  Docker backend container in this environment.
- Bullpen's large legacy client is excluded from initial load, but deeper
  route/tab-specific decomposition remains a follow-up before treating every
  tab as independently optimized.
- Host CPU isolation remains an infrastructure limitation; code changes cannot
  remove steal caused by colocated CPU-bound workers.
- No speculative caching, retry, skeleton, worker-count, index, AWS, DNS, CDN,
  or database-hosting change was made.
- Turbopack was not selected for production. Production remains Webpack.

Final review must continue to reject token serialization, cross-user cache
sharing, stale/implicit FX, synthetic history, silent singleton access, and any
change to trading execution semantics.
