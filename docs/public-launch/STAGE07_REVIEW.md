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
