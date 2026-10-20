# Stage05 runtime and administrator boundary handoff

Base: independently checked and owner-accepted Stage04 `23be68c9366ea41bb252c34974525e3ec9c6c0ff`. Isolated branch `codex/stage05-runtime-admin-20261020`; no edits to earlier worktrees or the UAT2 executor workspace. Full stages/05.md remains unchanged and was matched to authoritative HTML p05. Current main still preserves Google #1235/#1236; historical PR1240 remains baseline-only. No Stage06 work.

## Implemented behavior

All 126 HTTP routes across Polymarket, Direct, Auto-Live (including nested clustering), Bullpen008, trade analysis, audit and trading-bot overview require a current active ADMIN. This includes sanitized display caches, discovery/research, balance/positions, start/unlock and execution. Per-user folders/objects do not confer an independent wallet: managers recheck the database before returning warm objects or constructing adapters. Dashboard singleton loading defaults off and rechecks an explicit operator request. Ordinary responses also omit historical Bullpen and combined series that could encode a former singleton snapshot, retaining India/INDmoney series without rewriting history; private portfolio/shared-data reads retain their existing scope. Research in these closed Bullpen categories is operator-only; no public financial/research capability was enabled.

The 13 Next BFF handlers likewise validate `/auth/me` before filesystem cache, export, body parsing or dispatch. They use current backend role/activity, not Auth.js role claims, share the same refresh context, bound the admission lookup, return no-store denials and fail closed when authorization is unavailable. No browser token/credential is returned.

Scheduled/queued scan, history, planner, intent execution/reconciliation/retry, export and Bullpen008 recovery entry points recheck current persisted owners before runtime work. Revoked owners' historical records and frozen audit fields are retained. Recovery/financial gates are unchanged. No runtime was started for verification.

Sports classify/refresh/cricket-reconcile require current active ADMIN and structured actor/decision/path audit. Ordinary authenticated users retain the pure shared catalogue/resolve/event-comparison backend reads. Provider models/configuration metadata stay shared; recent estimates and last-run web queries/sources now use only the current user's Jobs. Cost administration uses existing ADMIN or a narrow explicit `cost_dashboard_admin` grant. That grant never satisfies runtime, sports, Sheets or global ADMIN admission. There is no role-management API.

## Migration and live security gate

`admin_roles_001` follows `tenant_idempotency_001`, adding only `administrative_role_grants`. Existing User roles, IDs/profiles and Bullpen audit/history are unchanged. Historical email exceptions exist solely as migration input; runtime authorization has no email bypass. A verified unambiguous active legacy non-ADMIN cost member can receive only the equivalent cost scope, with durable ActivityLog evidence. The migration requires an exact specifically approved ID set in `STAGE05_APPROVED_COST_ROLE_MIGRATION_IDS`; missing/extra/malformed IDs, duplicates and inactive/unverified proposed members fail before table/grant changes. Existing global ADMINs require no new grant. Downgrade drops the added table but retains audit; operational rollback needs the existing database/source backup contract.

**No actual live grant is authorized or performed here.** Before any UAT2 migration, the existing executor must identify the actual target and limits, then obtain read-only equivalence evidence under its existing backend runtime configuration. Run the packaged `app.uat2.stage05_role_preflight` module with process-only `CREDX_STAGE05_PREFLIGHT_READ_ONLY=1` and existing `CREDX_UAT2=1`; it uses a PostgreSQL read-only transaction, reports IDs/current roles and proposed cost-only IDs, and never writes/prints environment values or secrets. Do not copy runtime configuration into artifacts. If it reports any proposed/ambiguous/invalid mapping, STOP before migration/deployment and report the exact identity/scope for specific security approval. This task does not set the live approval-ID variable. No generic Stage05 approval grants global ADMIN or financial runtime access.

UAT2 retains `app.uat2.main`, exact owner allowlist and outer barrier. It does not mount the runtime, sports or cost routers: those capabilities remain unavailable503. Do not add them merely to demonstrate this stage. Source/CI/private tests exercise the full application boundary; deployed tests must report the actual restricted composition. No new public test identity, credentials, access permission, provider, queue or production workflow is enabled.

## Verification and regression reconciliation

Receipts are recorded in evidence/stage05-local-checks.json. Real HTTP/SQL tests cover every mapped route for anonymous, ordinary, cost-only, viewer and inactive identities; current-role grants/revocation, authorized passive reads, warm object admission/revocation, authorization outage, worker enqueue/execution denial, global maintenance, and A/B provider-cost/web metadata isolation. Existing operator behavior is also exercised by unchanged snapshot/history assertions with explicit active-ADMIN fixtures.

The first targeted run had44 failures/43 passes. Each was reconciled: eight cost-route fixtures patched the removed dependency alias rather than the real auth dependency; positive operator fixtures lacked role/activity; two historical display tests explicitly allowed a regular user and now test active operator display with separate regular-user denial; detached projection/worker unit suites now explicitly opt into an admitted synthetic-operator fixture. Full real SQL admission tests never use that fixture. The dashboard positive concurrency test now explicitly requests the privileged singleton section; its default is intentionally closed. No failure was waived or skipped.

The broader run exposed one additional order-dependent telemetry logger-capture failure. Exact unchanged Stage04 reproduced it (1 failure/1140 passes, with the expected safe warning visible on stdout). The test now attaches its capture handler directly to the non-propagating application logger; both the expected warning and absence of private bound parameters remain asserted. No production telemetry change. Additional worker/domain checks have231 passes and2 pre-existing optimizer failures reproduced identically on exact Stage04; no algorithm or test waiver is included and no whole-suite-green claim is made. Frontend structural assertions now check the shared admission context rather than duplicate session creation.

Docker-only migration checks use a dedicated internal network/PG container, no host ports, synthetic credentials and random isolated schemas. All Alembic operations run inside the backend container. The full upgrade/downgrade/re-upgrade preserves prior roles and requires all checks to execute. Mandatory PR CI adds the migration gate and SQL role checks against the existing disposable PostgreSQL service; all previous release checks remain present. No production pipeline change.

## Actual localhost preview

http://localhost:59388/console/trading-bots and http://localhost:59388/console/profile/cost-drivers; API `http://127.0.0.1:59389`. Real Next production build, Auth.js/BFF and FastAPI/SQL auth run from this isolated Stage05 worktree. Fake-only fixtures return offline runtime health, empty shared catalogue and empty billing data. No AWS request, CLI, email, broker, paid AI or external data is used. Backend network and frontend external sockets remain denied. SQLite preview is not PostgreSQL parity or UAT acceptance.

From `/Users/tarunsingh/Documents/Codex/2026-10-19/task-5/stage05-runtime-admin`:

```sh
.runtime/python/bin/python scripts/public_launch/preview.py status
.runtime/python/bin/python scripts/public_launch/preview.py stop
.runtime/python/bin/python scripts/public_launch/preview.py start
.runtime/python/bin/python scripts/public_launch/check_stage05_preview.py
```

Existing synthetic accounts: usera/userb/admin@stage01.example.com, password SyntheticPreview123!. Regular user: Trading Bots -> refresh auto-run status shows “Active administrator role required”; no wallet/position data loads. Administrator: the existing Platform Cost Drivers screen loads its empty offline fixture, with the existing missing-live-data notice; zero values are not actual AWS billing. Shared Sports catalogue remains readable. Browser and66 protocol checks passed. Screenshots in `.runtime/stage01-preview/stage05-browser-{denial,admin}.png` supplement functional testing. Other application paths without explicit fake support remain unavailable. The prior Stage04 preview remains preserved.

## Delivery states

Code: implemented with local checks. Exact-head CI/native artifact: pending publication. UAT2 deployment/verification: pending existing executor, READY/current limits, role-equivalence preflight and independent review. Fresh signed-in live browser walkthrough: not claimed. Owner acceptance05: pending. External approvals: unchanged. Stage06 waits for owner acceptance. Preserve totalUS$10 and stop21Oct2026 21:04:13IST; no extension, production merge/deployment, AWS operation, secret retrieval or live permission expansion.
