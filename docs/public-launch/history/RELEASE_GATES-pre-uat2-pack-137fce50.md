# Public-launch release gates

Stage 00 live acceptance: **BLOCKED**. Latest UAT2 amendment: Stage01 candidate preparation only; parent-confirmed dedicated UAT2 acceptance and exact-candidate CI/artifact checks precede any deployment coordinated by the UAT2 task. Old Stage00 history is preserved; no production action is authorized. This task prepares source only; it does not deploy UAT2 or authorize production merge/deployment. Read stages/01.md, STATUS.md, DECISIONS.md and ROUTE_MATRIX.md before dependent stages.

| Gate | State | Required evidence |
| --- | --- | --- |
| Stage 01 specification | Recovered / recorded | Library version 2 Stage 01 text and current amendment; local source bytes/hash not verified |
| Persistent baseline and inventory | Source implemented | Reproducible source scanner, hash manifest, route/task/schedule/export matrix and synthetic fixtures |
| Local baseline checks | 5 baseline + 19 Google + 42 API/BFF checks PASS; production frontend build/type PASS | Exact commands and actual results; no count borrowed from Stage 00 |
| CI checks | Draft PR #1240 published; fresh exact-head CI pending | Check actual head SHA and isolated test results; never infer from local or historical CI |
| Local UI preview | Running on localhost; scoped interactive browser walkthrough PASS with recorded baseline display limitation | Real Next.js/Auth.js/FastAPI auth-profile harness, synthetic SQLite, no external actions; LOCAL_PREVIEW.md |
| Existing-source failures | Open | Source-verified ownership/stream/auth-bypass findings in DECISIONS.md; later-stage negative tests and fixes required |
| Stage 00 isolation/lifecycle/private/TLS/Google | BLOCKED | Actual admitted live evidence; retained artifacts and stopped infrastructure unchanged |
| Actual deployed ingress and population | Unknown this task | Read-only deployed SHA, ingress paths, active user/role counts, owner IDs and ownership mapping via admitted route; config examples insufficient |
| Both Kite modes | Pending | Provider/commercial approval; isolated connection lifecycle tests under BOTH modes; no cross-mode fallback |
| Capacity, budgets, products, retention | Pending decisions | Assigned owners, explicit values and evidence from DECISIONS.md; proposals are not approvals |
| India eligibility / Bullpen availability / disclosures | Pending review | Feature-specific legal/provider release decisions; no baseline certification |
| Orders | Not implemented in Stage 01 | Explicit payload-bound approval, durable intent, deterministic risk limits, reconciliation and separately authorized live validation |
| Stage01 UAT2 candidate | Prepared; deployment held | Parent-confirmed dedicated UAT2 owner acceptance plus exact-head CI/native artifact review; deployment coordinated by UAT2 task; old Stage00 remains separately BLOCKED |
| Production release | Not authorized | Separate user instruction after complete release review; no merge in this task |

## Push and PR safety at the recorded base

All 14 GitHub workflows were inspected before pushing. deploy.yml is push-to-main/manual, with manual main check. The two diagnostic push triggers name fix/sports-ranking-live-validation and codex/fix-ranking-errors and their own workflow paths. Operational repair/live-execution/disk workflows are manual dispatch. No workflow_run, pull_request_target or repository_dispatch trigger was found. pr-checks.yml uses hosted checks and disposable DB/Redis containers; api-attempt-migration.yml is path-filtered PR testing with disposable PostgreSQL inside a container.

The added Stage 01 workflow is PR-only/path-filtered, read-only contents, hosted runner, synthetic SQLite/no-network fixtures and source checks. It has no deployment credentials, broker keys, environment binding, AWS commands, application startup or schedulers. No production pipeline is changed. Recheck triggers and current main before future pushes.

GitHub workflow inspection does not certify outside hosting integrations. vercel.json is source configuration only, not proof of a connected deployment or its permissions. No external deployment is requested or invoked.

## Current separate UAT2 candidate gate

Read UAT2_INTEGRATION.md and SEQUENTIAL_UAT2_PLAN.md. Stage01 source integrates baseline documentation/inventory/fixtures/localhost tools into guarded UAT2 source. Parent acceptance and candidate CI/native artifact/deployment evidence remain pending; no deployment here. Stage02 starts only after Stage01 is accepted. Sequential authorization does not enable real providers/orders, expand owner access, change spending/retention limits or authorize Stage20 production cutover.
