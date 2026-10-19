# Stage02 requirement-to-source map

Base:4b69c472d5d30d87d17df0e435a9ece0c722d5b0. Stage01 deployed67cb8e6d plus approved proxy709bbac; parent reports owner accepted dashboard, India1100+960=2060 and navigation/refresh session continuity. Stage02 separately authorized. Source worktree/branch:task-5/stage02-private-ownership, codex/stage02-private-ownership-20261019. No schema change planned; preserve Google identity and existing UAT2 owner/barrier/simulation controls.

Full stages/02.md matches the decoded p02 prompt in current Library HTML libfile_8c0887a3e4f88191b24fba523ef6959e (supplied original hash c25d5b69b160b0a9228667d6374b17f5e6b135ac8e941f2eee7404a81e8f1449). PR1240 remains ddefd730; its actual baseline diff supplies no ownership implementation. Reuse baseline fixtures, inventory and real-app preview, not duplicate tenant infrastructure.

| Requirement | Existing source and finding | Implementation/test plan |
| --- | --- | --- |
| Active identity for private jobs | jobs/router.py GET list/detail unauthenticated; app/main.py mounts directly | Reuse get_current_user on router and handlers; anonymous/inactive direct HTTP regressions |
| DB owner predicate, totals/search/pages | PostgresJobRepository.get/list unscoped | Mandatory owner on async private methods; both item/count SQL scoped; two-user real database tests |
| Cancel/create/replay | cancel distinguishes foreign403; CreateJobUseCase cache key global | Scoped404, authenticated create identity, per-user replay cache/lock; fake Redis/Celery tests |
| Internal worker/admin access | SyncJobRepository used by jobs/tasks.py and export workers | Explicit worker lookup names with limited callsites; keep worker semantics and test affected mocks |
| Runs and cross-record ownership | HTTP Run queries already owner-filtered, but optional repository owner; eager Job links and cancel secondary query not owner filtered; prompt_id not checked | Require repository owner; constrain related Job loads/cancel; validate owned/system prompt before creation; preserve existing output_sources both-owner predicates |
| WebSockets | Job detail checks owner only for initial payload then subscribes foreign channel; Run detail checks identity only | Resolve owned resource before accept/subscribe; foreign/missing indistinguishable and relay never invoked |
| Snapshots/recommendations | INDmoney and Zerodha snapshot repositories use user+ID/date; recommendation comparison/materialize/verification and calculation source checks existing | Reuse checks, add cross-owner regression evidence; review relationship queries |
| Export/artifact writes | Sheets HTTP queues foreign IDs before worker owner guard; worker missing-credential/error branches mutate unscoped Job/Run | Check owned resource before credential/dispatch, owner-scope worker failure queries and related jobs; no provider calls in tests |
| Usage | Current/legacy API usage queries already user-filtered; Run joins require review for cross-owner links | Preserve correct filters; constrain linked Run owner where needed and test totals/records |
| Private artifacts outside equity release | Bullpen audit/export routes pass authenticated user to services; public live/copy/direct remains closed under release gates | Inspect service ownership; document any residual broad subsystem as public-release blocker rather than claim exhaustive isolation |
| Direct+BFF | Next backend-api proxy derives session tokens and strips Authorization/owner spoof headers | Test real proxy forwarding + FastAPI ownership with isolated fake integrations; no dummy UI |
| Delivery | Existing PR-only CI/native artifact pipeline, production push main-only | Separate draft Stage02 PR; exact SHA CI/artifact evidence; coordinate deployment through parent after READY, then owner review before03 |

Code:IMPLEMENTED pending exact CI/deployed acceptance. CI:PENDING. UAT2 deployment:NOT_RUN. UAT2 verification:NOT_RUN. Owner acceptance:NOT_RUN. External approvals:unchanged/not granted by this stage. No live operations performed.

Implemented/test evidence:22 isolated ownership regressions plus affected suites total367 PASS locally; real localhost A/B FastAPI+BFF and Chrome negative cases PASS. PostgreSQL schema parity is CI-pending. No migration. Detailed current states and release boundaries are in STATUS.md; preview steps in STAGE02_PREVIEW.md.
