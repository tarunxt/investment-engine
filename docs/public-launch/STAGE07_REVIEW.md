# Stage07 review checkpoint

Base: accepted/deployed f985ea727eb04d140f5794d95880be50418ff1fb. Separate codex/stage07-module-lifecycle-20261020/worktree task-5/stage07-module-lifecycle. Full stages/07.md governs backend lifecycle;08 is the module-selection UI. No08 implementation, production action, AWS operation, credential/access grant, real provider/order/email/paidAI or resource-limit extension is included.

Implemented: transactional selection events/cancellation, owned Job/Run/rebalance-parent attribution, current policy at enqueue/start/transitions/effects, version-bound generic task locators in existing outbox, explicit safety classifications, paused schedules/analysis-only explicit resume, stream revocation/epoch invalidation, and direct provider/Sheets/notification/broker command guards. See STAGE07_COVERAGE.md for exact mapping, linearization, closed legacy work and later reuse requirements. Additive module_lifecycle_001 adds only lifecycle columns; it neither backfills ownership nor grants roles. New selects do not imply eligibility/execution or restart work.

Local evidence at this checkpoint:

- Backend PR release selection:1,230 passed,0failed after generic-binding/coverage refinements.
- Most recent combined real SQL module/ownership/stream/lifecycle suite:110 passed.
- Targeted layering/recovery/audit suite:195 passed.
- Actual Next production build/TypeScript passed.
- Real localhost Auth.js/BFF/FastAPI lifecycle walkthrough passed41 checks, including queue/running disable, stale tabs, isolation and no schedule restart; final source refresh passed; the protocol count includes repeated polling checks.
- Standalone native-compatible no-network private-file fake-work smoke passed7 checks; no live owner/database was used.
- Initial actual Docker PostgreSQL run:3 passed,1 migration-fixture failure (missing required seed current_stage). The fixture was corrected and extended to6 checks; the rerun is NOT PASSED locally because Docker's socket disappeared. The PR has a mandatory backend-Docker PostgreSQL job with no skipped checks. Its actual result is required, not inferred.

Initial broad probe was1131passed/82failed. Repairs retain meaningful original tests: detached provider/algorithm fixtures explicitly opt into a synthetic admitted context; real SQL/HTTP/stream/lifecycle negative suites never request it. Original domain/recovery/financial assertions remain. Old ADMIN warm-cache allow expectations now assert the independent closed module gate while preserving cached objects. Existing schema/default assertions include the additive paused state. Celery wrappers preserve bound-method behavior, including explicit test receivers. Source-only inventory shares the runtime classifier. No test is skipped to claim success.

## Local preview

Actual app: http://localhost:61386/login?redirectTo=/console/profile/preferences
API: http://127.0.0.1:61387
Start/status/stop from this worktree:

```sh
.runtime/python/bin/python scripts/public_launch/preview.py status
.runtime/python/bin/python scripts/public_launch/preview.py stop
.runtime/python/bin/python scripts/public_launch/preview.py start
.runtime/python/bin/python scripts/public_launch/check_stage07_preview.py
```

State/verified process stamps and logs: .runtime/stage01-preview/. Synthetic usera/userb/admin@stage01.example.com, password SyntheticPreview123!. This is a separate database/process pair; old previews remain untouched. The process-stamp stop command targets only this preview. Wait for its listeners to exit before immediate restart; if another process occupies a recorded port, rebuild to choose fresh ports.

No dummy UI is added. Existing Preferences, Jobs and Runs remain real screens; API evidence demonstrates backend-only changes. The harness supplies fake eligibility only for synthetic AI Studio, uses an offline fake consumer and denies outbound sockets. All other facts remain unknown. SQLite is not PostgreSQL concurrency proof or live UAT acceptance; fake eligibility is never a deployment permission.

Fresh Chrome Preferences/reload, completed Job history/refresh, ten default-off/paused modules and unavailable Bullpen Runs passed. Browser used an existing synthetic ADMIN session; ordinary A/B users were exercised through real Auth.js/BFF. Screenshots and receipt are in .runtime/stage07-browser/.

Pending: exact-head CI/native artifact, mandatory independent review, sole-executor UAT2 READY/current budget/limit check and controlled fake-work/live verification, then owner acceptance before08. US$10 total and inherited earlier shutdown/retention controls are unchanged; do not infer renewal from this file. The separately requested future stop reminder is in RELEASE_GATES.md, not an infrastructure action.

## First exact candidate3357fb92 — superseded, not deployable

Stage07 mandatory Docker CI passed all6 PostgreSQL checks with no skips and the7-check private smoke. Stage06/05 migration jobs, backend release selection, both frontend builds/runtime checks, frontend regressions and native packaging passed. Overall PR Checks failed on: workflow-audit fixtures carrying unbound legacy parents; Stage04 named-old-schema seed using newer ORM Job columns; and one detached recommendation transport test without an admitted module fixture. No result was waived or called a deployment pass.

Successor repairs use explicit owned/versioned eligibility in the real PostgreSQL audit fixture, reflect the actual named old schema for Stage04 seed data while retaining all strict snapshot assertions, and scope the detached transport test to a fake module context while retaining its original queue/connection restrictions. Direct workflow stage calls now also take the selection fence before the workflow row, matching disable's lock order. Exact-successor CI/artifact remain required; no old artifact identity transfers.

Stage07 successor repair (independent review of 3357): synchronous effect fences now set transaction-local PostgreSQL lock/statement bounds; asynchronous adapters use async sessions, with a 30-second adapter bound. CLI authorization is rechecked under the SQL fence at actual subprocess creation after broker waits. The fence covers start, not the entire subprocess lifetime: an already accepted process can finish under existing command timeouts; each later command must reauthorize. Reconciliation preserves active-ADMIN/known-read-only checks and rechecks the owner at process start. Added real PostgreSQL contention/heartbeat tests and fake-executable ordering/denial tests. Three prior failing CI paths retain their assertions with schema-version-correct seeding and explicit owned module fixtures. Successor CI and renewed independent review remain pending; 3357 is not deployable.

Successor local evidence: full backend release list 1,237 passed; lifecycle/recommendation 42 passed; isolated fake broker contracts 31 passed; affected synchronous/asynchronous provider/export checks 42 passed; layering checks 210 passed; native private-file smoke 7 passed. Restarted own preview only, PIDs 34381/34382 on 61387/61386; real Next/Auth.js/BFF/FastAPI synthetic lifecycle walkthrough 48 checks passed. Real PostgreSQL contention tests are mandatory CI (minimum eight, zero skipped), not claimed locally. An exploratory broker run without its explicit detached context failed and was interrupted; its fixture was corrected and all 31 contracts then passed. No PostgreSQL test, role check, recovery guard, or migration assertion was waived.

Exact successor 3342a2ed Docker CI: Stage07 eight PostgreSQL checks and seven private smoke checks passed; workflow audit, recommendation audit, Stage05/06, baseline and API migration passed. Stage04 retained a separate failure: real terminal-replay task was patched to the private schema internally, while its new outer lifecycle wrapper resolved the canonical public-schema factory. Corrected this test-only factory wiring (no policy bypass); final exact-head CI and independent review still required.
