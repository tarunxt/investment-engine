# A6-13 native viewer: first review gate

Private preparation only. Base: `8d25f34a33242adcaab092afdb07af7956f327bd`. No owner identity, credential or private data is included. No host operation or publication has occurred.

## Exact source-backed projection allowlist

All eleven keys are original relation names exposed through same-named views in `credx_viewer`. Every row uses a private verified owner constant. NULL owners fail equality and are excluded. There are no admitted shared relations. Every key uses the source integer primary key `id` for filtering, keyset pagination and detail. Catalog/structure exposes ONLY the columns below, never full base-table reflection.

### runs

Source: `backend/app/domains/runs/models.py`, `Run`.

Columns: `id`, `status`, `current_stage`, `auto_rebalance_portfolio`, `auto_rebalance_sequence`, `created_at`, `updated_at`.

Predicate: `t.user_id = {owner_id}`.

### jobs

Source: `backend/app/domains/jobs/models.py`, `Job`.

Columns: `id`, `provider`, `model`, `status`, `tokens_in`, `tokens_out`, `estimated_cost`, `web_search_used`, `scheduled_at`, `created_at`, `updated_at`.

Predicate: `t.user_id = {owner_id}`.

### run_jobs

Source: `backend/app/domains/runs/models.py`, `RunJob`.

Columns: `id`, `run_id`, `job_id`, `stage`, `created_at`, `updated_at`.

Predicate: `EXISTS (SELECT 1 FROM public.runs r WHERE r.id = t.run_id AND r.user_id = {owner_id}) AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = t.job_id AND j.user_id = {owner_id})`.

### prompts

Source: `backend/app/domains/prompts/models.py`, `Prompt`.

Columns: `id`, `version`, `is_system`, `is_active`, `created_at`, `updated_at`.

Predicate: `t.user_id = {owner_id} AND t.is_system = false`.

### auto_rebalance_workflows

Source: `backend/app/domains/runs/models.py`, `AutoRebalanceWorkflow`.

Columns: `id`, `portfolio`, `sequence`, `status`, `current_stage`, `completed_at`, `created_at`, `updated_at`.

Predicate: `t.user_id = {owner_id}`.

### auto_rebalance_workflow_stages

Source: `backend/app/domains/runs/models.py`, `AutoRebalanceWorkflowStage`.

Columns: `id`, `workflow_id`, `stage`, `status`, `started_at`, `completed_at`, `created_at`, `updated_at`.

Predicate: `EXISTS (SELECT 1 FROM public.auto_rebalance_workflows w WHERE w.id = t.workflow_id AND w.user_id = {owner_id}) AND (t.run_id IS NULL OR EXISTS (SELECT 1 FROM public.runs r WHERE r.id = t.run_id AND r.user_id = {owner_id})) AND (t.job_id IS NULL OR EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = t.job_id AND j.user_id = {owner_id}))`.

### final_actionable_history

Source: `backend/app/domains/runs/models.py`, `FinalActionableHistory`.

Columns: `id`, `market`, `stock_symbol`, `stock_name`, `covered_at`, `action`, `score`, `consensus_numerator`, `consensus_denominator`, `historical_current_units`, `historical_current_value`, `action_units`, `amount`, `formula_version`, `coverage_status`, `created_at`, `updated_at`.

Predicate: `t.user_id = {owner_id} AND EXISTS (SELECT 1 FROM public.runs r WHERE r.id = t.rebalance_run_id AND r.user_id = {owner_id}) AND (t.workflow_id IS NULL OR EXISTS (SELECT 1 FROM public.auto_rebalance_workflows w WHERE w.id = t.workflow_id AND w.user_id = {owner_id})) AND (t.technical_scan_run_id IS NULL OR EXISTS (SELECT 1 FROM public.runs r WHERE r.id = t.technical_scan_run_id AND r.user_id = {owner_id}))`.

### zerodha_portfolio_snapshots

Source: `backend/app/domains/zerodha/models.py`, `ZerodhaPortfolioSnapshot`.

Columns: `id`, `snapshot_date`, `captured_at`, `source`, `holdings_count`, `net_positions_count`, `day_positions_count`, `holdings_market_value`, `holdings_pnl`, `holdings_day_change_value`, `available_margin`, `positions_pnl`, `positions_m2m`, `holdings_invested_value`, `created_at`, `updated_at`.

Predicate: `t.user_id = {owner_id}`.

### indmoney_us_portfolio_snapshots

Source: `backend/app/domains/indmoney_us/models.py`, `IndMoneyUsPortfolioSnapshot`.

Columns: `id`, `snapshot_date`, `captured_at`, `source`, `parse_status`, `holdings_count`, `reported_holdings_count`, `indices_count`, `wallet_balance`, `current_value`, `invested_value`, `day_return_value`, `day_return_percent`, `total_return_value`, `total_return_percent`, `created_at`, `updated_at`.

Predicate: `t.user_id = {owner_id}`.

### llm_provider_usage_calls

Source: `backend/app/domains/api_usage/models.py`, `LlmProviderUsageCallRecord`.

Columns: `id`, `provider`, `model`, `occurred_at`, `tokens_in`, `tokens_out`, `cache_hit_tokens`, `cache_miss_tokens`, `actual_cost`, `created_at`, `updated_at`.

Predicate: `t.user_id = {owner_id} AND (t.job_id IS NULL OR EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = t.job_id AND j.user_id = {owner_id}))`.

### llm_provider_usage_daily_snapshots

Source: `backend/app/domains/api_usage/models.py`, `LlmProviderUsageDailySnapshot`.

Columns: `id`, `provider`, `model`, `usage_date`, `timezone`, `requests`, `tokens_in`, `tokens_out`, `cache_hit_tokens`, `cache_miss_tokens`, `actual_cost`, `source`, `captured_at`, `created_at`, `updated_at`.

Predicate: `t.user_id = {owner_id}`.

## Exclusions and privilege risks

Entire authentication, user/session/API-key, broker credential and Google Sheets credential relations are excluded. No raw prompt/response/error/context/runtime JSON, workflow summary/error, prompt body/description, imported raw text, export URL, provider request identifier or unreviewed relationship is projected. The viewer cannot execute SQL supplied by the browser. Provider or financial actions are absent.

The nonlogin view owner receives only explicit source-column SELECT. The viewer login receives SELECT on eleven individually named security-barrier views, no base grants, no view-owner membership and no security-invoker workaround. The owner ID is bound into a private operator-reviewed SQL artifact, never the public source or logs. Database statement/audit logging must be assessed before generating real-owner SQL; this task supplies placeholders only.

The audit must consider effective PUBLIC and transitive privileges, SET ROLE, schema/database CREATE, database TEMP, sequence privileges and executable security-definer functions. NOINHERIT is insufficient. PostgreSQL PUBLIC TEMP/CREATE defaults may make strict isolation impossible with additive role grants alone. If the guard fails, roll back and report the exact ambient privilege; do not revoke PUBLIC globally or change other applications. No claim of actual privilege isolation is made without live metadata review and disposable-DB denial tests.

Unexpected existing roles/schema/views cause CREATE to fail; there is no takeover, replacement, CASCADE or automatic deletion. This versioned operational migration creates no application table and does not advance the backend application migration history. Operator must review it under the established native database migration/backup procedure before application.

## First-stage tests executed

Four offline tests pass: exact projected/policy columns against model AST; forbidden relation/column exclusion; dual-parent ownership rules; deterministic nonexecuting SQL template with no broad SELECT. These tests do NOT prove live schema, privileges, rows, socket isolation or deployment acceptance.

## Required next test gates

Disposable PostgreSQL: two synthetic owners plus NULL owners; mismatched run/job/stage references; owner views; denied base reads, view/base writes, DDL, SET ROLE and unsafe functions; intentional PUBLIC TEMP/CREATE blockers; rollback leaves no partial objects. HTTP: owner/nonowner/inactive/missing identity, every root/child/write path, bounded filters/cursors bound to relation/filter/sort/key, details using the same view, injection/escaping/cancellation/failed/empty/populated states. Socket/service: only frontend Unix identity can connect, no credentials in HTML/logs, bounded resource and shutdown tests. UI: keyboard and narrow layout. No live write probes.

## Safe release/provisioning separation

Native Python source/tests/units will live under `frontend/server/database-viewer/`, use the verified installed packages and a separate engine/service, and never import app startup/settings/session/workers. The existing owner gate, POST denial and cookie/bearer stripping remain. Socket transport uses built-in Node HTTP, no HTTP/public-port fallback. Native service and view provisioning are performed only by the designated operator after this mapping/SQL review. No Docker, package installation, backend/recovery restart or financial worker change is required.

Add executable native tests to the existing CI Python job; a narrowly reviewed `.github/workflows/pr-checks.yml` change is already covered by the orchestration gate and will hold automatic production delivery. All new code remains frontend/docs/that exact reviewed orchestration path: the current manual frontend proof must pass the final exact diff. Native artifact installation is a separate exact-SHA/checksum operator operation, not a backend/full-stack deploy. Stage and verify the private socket/service and DB role before the coordinated frontend-only release. If any unforeseen shared/backend path is needed, hold rather than broadening scope. No merge until exact-head CI and both native/SQL reviews pass.

## Implementation and execution checkpoint

Independent private implementation started at **2026-11-01 17:02:49 UTC**.
Checkpoint at **17:40:28 UTC**: no long-running command or approval was pending.
No publication, production database access, grant, installation or service
operation has occurred.

The native Python service now implements the approved catalog, structure,
exact-match filters, unique-ID keyset pagination bound to relation/filter/sort,
and detail reads of the same filtered view. It validates the dedicated login,
rechecks the fixed privilege audit on each connection/transaction, enforces read
and response budgets, preserves scalar textual precision, and uses no application
startup/settings/session/worker imports. All browser paths retain the existing
current-owner check, GET/HEAD-only methods and cookie/bearer stripping.
The frontend transport uses only a private Unix socket; there is no TCP fallback.

The socket template is owned by frontend `investor:investor`, mode0600. This
authorizes every process sharing the investor UID, not exclusively the frontend
process. The browser-facing owner boundary remains mandatory. Root and the
existing application Unix identity are trusted local actors; exclusive process
isolation would require a separately reviewed identity/capability design.
Host identity and package metadata are verified; immutable artifact and actual
socket ownership/permissions remain operator staging checks. The
separate socket-activated service uses `DynamicUser`, systemd credential delivery,
resource/sandbox limits and no application environment or financial-service
startup dependency. The executable artifact path is a deliberate unresolved
placeholder: templates are not ready for installation. The operator must stage
only serve.py, browser.py, catalog.json and privilege-audit.review.sql from the
reviewed exact source SHA into a root-owned immutable directory, verify hashes,
verify interpreter access/import compatibility, and render the unit to that path.
Do not include fixtures/tests, reuse write credentials, install packages, alter
pg_hba/PUBLIC defaults, or start anything without the remaining review gates.

### Actual checks

- **14 Python tests passed**: 4 mapping/template, 7 HTTP and 3 service/launcher
  contracts. **One PostgreSQL test class was skipped**; its six actual-database
  cases have NOT executed. The overall local result is not a full database pass.
- **14 Node owner/proxy/socket tests passed**, including actual private-socket
  transfer, credential stripping, mode/owner rejection, body bounds and aborts.
- **2 offline browser viewport cases passed** through the real private socket,
  with synthetic data: owner/nonowner/unauthenticated/write boundaries, structure,
  filtering, pagination, detail, precision, keyboard navigation/horizontal scroll
  and narrow layout. Synthetic desktop/narrow screenshot pixels were inspected
  locally; images are not deliverables and contain no real account data.
- TypeScript, targeted ESLint, Python compilation, YAML parsing and diff checks
  pass. Original private report screenshots remain unreviewed.

Cloud fixtures explicitly simulate root metadata for / and /tmp because this
cloud filesystem exports root ownership as UID65534. Socket and immediate-parent
ACLs and transport are real. Production always uses actual filesystem metadata;
there is no environment flag that weakens its root/owner checks. Actual foreign-UID
connection and systemd activation/readiness checks remain operator/staging gates.

### Exact local PostgreSQL limitation

No postgres/initdb executable or usable package catalog exists in this cloud.
A package lookup reported missing postgresql-17 packages and could not read
/etc/apt/apt.conf.d/80-applied-apt-retries. A read of the official PostgreSQL18.0
source checksum URL failed with `Tunnel connection failed: 403 Forbidden`.
No escalation, alternate PostgreSQL download route or production fallback was
attempted. The proposed private CI job uses an explicitly disposable PostgreSQL18
service, validates its actual major version and fails if any database test skips.
The first published CI run executed all six PG18 cases without skips: five passed,
and an escalation-denial assertion failed because it used a session authenticated
as the fixture superuser. The exact failed statement was `SET ROLE credx_viewer_views`: the authenticated
`session_user` remained the fixture superuser. The corrected suite now requires
`session_user=current_user=credx_viewer_read`, actual privilege SQLSTATE42501,
and separate SQLSTATE42703 schema-exclusion assertions. No privilege audit is
weakened. The next exact-head CI
result is required before any grant or deployment.

### Independent SQL review corrections

The DO block now ends with `END;`. Both roles are audited for attributes,
membership/SET ROLE, effective data/function/sequence access and unexpected
ownership. The view owner is limited to exactly enumerated base-column SELECT,
without table-wide SELECT, extra columns, writes or grant options. New schema/view
and column ACLs reject unexpected default-ACL grantees and reader grant options.
System credential catalog access is rejected. Lock/statement timeouts precede
DDL; the audit precedes the deliberately noncommitting ROLLBACK.

The actual-PG fixtures cover all eleven views with two synthetic owners, NULL,
system prompts and mismatched run/job/stage/final/usage links; actual viewer login
and write/escalation denial; seeded PUBLIC TEMP/CREATE/base-column, membership,
security-definer and default-ACL hazards; and role/schema rollback. All mutations
in those tests are restricted to an explicitly acknowledged disposable fixture
administrator/database/host. None has run against any real database here.

### Release gate

The final diff is frontend/docs plus the existing specifically reviewed
.github/workflows/pr-checks.yml path, so orchestration changes hold automatic
production delivery. CI-only draft publication is approved so the disposable PG18 gate can execute.
Do not merge or request a host grant until the corrected SQL/HTTP/socket review
and exact-head real PG18 execution gate are resolved. No required
check is disabled. Keep the current unavailable state on any unresolved privilege,
RLS, schema, native-runtime or source-provenance mismatch. No global PUBLIC
revocation or full-stack/recovery delivery is an acceptable workaround.

## SQL review template (nonexecuting; ends in ROLLBACK)

```sql
-- REVIEW TEMPLATE ONLY: invalid private placeholders deliberately prevent direct execution.
-- Apply only after live relation/column/ownership and effective privilege review.
-- Versioned native-viewer provisioning migration; no application data is modified.
BEGIN;
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '5s';
CREATE ROLE credx_viewer_views NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE credx_viewer_read LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
CREATE SCHEMA credx_viewer AUTHORIZATION credx_viewer_views;
REVOKE ALL ON SCHEMA credx_viewer FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO credx_viewer_views;
GRANT USAGE ON SCHEMA credx_viewer TO credx_viewer_read;
GRANT CONNECT ON DATABASE __VERIFIED_DATABASE_IDENTIFIER__ TO credx_viewer_read;
ALTER ROLE credx_viewer_read SET default_transaction_read_only = on;
ALTER ROLE credx_viewer_read SET statement_timeout = '3s';
ALTER ROLE credx_viewer_read SET lock_timeout = '500ms';
ALTER ROLE credx_viewer_read SET idle_in_transaction_session_timeout = '5s';
GRANT SELECT ("auto_rebalance_portfolio", "auto_rebalance_sequence", "created_at", "current_stage", "id", "status", "updated_at", "user_id") ON public."runs" TO credx_viewer_views;
GRANT SELECT ("created_at", "estimated_cost", "id", "model", "provider", "scheduled_at", "status", "tokens_in", "tokens_out", "updated_at", "user_id", "web_search_used") ON public."jobs" TO credx_viewer_views;
GRANT SELECT ("created_at", "id", "job_id", "run_id", "stage", "updated_at") ON public."run_jobs" TO credx_viewer_views;
GRANT SELECT ("created_at", "id", "is_active", "is_system", "updated_at", "user_id", "version") ON public."prompts" TO credx_viewer_views;
GRANT SELECT ("completed_at", "created_at", "current_stage", "id", "portfolio", "sequence", "status", "updated_at", "user_id") ON public."auto_rebalance_workflows" TO credx_viewer_views;
GRANT SELECT ("completed_at", "created_at", "id", "job_id", "run_id", "stage", "started_at", "status", "updated_at", "workflow_id") ON public."auto_rebalance_workflow_stages" TO credx_viewer_views;
GRANT SELECT ("action", "action_units", "amount", "consensus_denominator", "consensus_numerator", "coverage_status", "covered_at", "created_at", "formula_version", "historical_current_units", "historical_current_value", "id", "market", "rebalance_run_id", "score", "stock_name", "stock_symbol", "technical_scan_run_id", "updated_at", "user_id", "workflow_id") ON public."final_actionable_history" TO credx_viewer_views;
GRANT SELECT ("available_margin", "captured_at", "created_at", "day_positions_count", "holdings_count", "holdings_day_change_value", "holdings_invested_value", "holdings_market_value", "holdings_pnl", "id", "net_positions_count", "positions_m2m", "positions_pnl", "snapshot_date", "source", "updated_at", "user_id") ON public."zerodha_portfolio_snapshots" TO credx_viewer_views;
GRANT SELECT ("captured_at", "created_at", "current_value", "day_return_percent", "day_return_value", "holdings_count", "id", "indices_count", "invested_value", "parse_status", "reported_holdings_count", "snapshot_date", "source", "total_return_percent", "total_return_value", "updated_at", "user_id", "wallet_balance") ON public."indmoney_us_portfolio_snapshots" TO credx_viewer_views;
GRANT SELECT ("actual_cost", "cache_hit_tokens", "cache_miss_tokens", "created_at", "id", "job_id", "model", "occurred_at", "provider", "tokens_in", "tokens_out", "updated_at", "user_id") ON public."llm_provider_usage_calls" TO credx_viewer_views;
GRANT SELECT ("actual_cost", "cache_hit_tokens", "cache_miss_tokens", "captured_at", "created_at", "id", "model", "provider", "requests", "source", "timezone", "tokens_in", "tokens_out", "updated_at", "usage_date", "user_id") ON public."llm_provider_usage_daily_snapshots" TO credx_viewer_views;
CREATE VIEW credx_viewer."runs" WITH (security_barrier=true) AS SELECT t."id", t."status", t."current_stage", t."auto_rebalance_portfolio", t."auto_rebalance_sequence", t."created_at", t."updated_at" FROM public."runs" t WHERE t.user_id = __PRIVATE_VERIFIED_OWNER_ID__;
ALTER VIEW credx_viewer."runs" OWNER TO credx_viewer_views;
REVOKE ALL ON credx_viewer."runs" FROM PUBLIC;
GRANT SELECT ON credx_viewer."runs" TO credx_viewer_read;
CREATE VIEW credx_viewer."jobs" WITH (security_barrier=true) AS SELECT t."id", t."provider", t."model", t."status", t."tokens_in", t."tokens_out", t."estimated_cost", t."web_search_used", t."scheduled_at", t."created_at", t."updated_at" FROM public."jobs" t WHERE t.user_id = __PRIVATE_VERIFIED_OWNER_ID__;
ALTER VIEW credx_viewer."jobs" OWNER TO credx_viewer_views;
REVOKE ALL ON credx_viewer."jobs" FROM PUBLIC;
GRANT SELECT ON credx_viewer."jobs" TO credx_viewer_read;
CREATE VIEW credx_viewer."run_jobs" WITH (security_barrier=true) AS SELECT t."id", t."run_id", t."job_id", t."stage", t."created_at", t."updated_at" FROM public."run_jobs" t WHERE EXISTS (SELECT 1 FROM public.runs r WHERE r.id = t.run_id AND r.user_id = __PRIVATE_VERIFIED_OWNER_ID__) AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = t.job_id AND j.user_id = __PRIVATE_VERIFIED_OWNER_ID__);
ALTER VIEW credx_viewer."run_jobs" OWNER TO credx_viewer_views;
REVOKE ALL ON credx_viewer."run_jobs" FROM PUBLIC;
GRANT SELECT ON credx_viewer."run_jobs" TO credx_viewer_read;
CREATE VIEW credx_viewer."prompts" WITH (security_barrier=true) AS SELECT t."id", t."version", t."is_system", t."is_active", t."created_at", t."updated_at" FROM public."prompts" t WHERE t.user_id = __PRIVATE_VERIFIED_OWNER_ID__ AND t.is_system = false;
ALTER VIEW credx_viewer."prompts" OWNER TO credx_viewer_views;
REVOKE ALL ON credx_viewer."prompts" FROM PUBLIC;
GRANT SELECT ON credx_viewer."prompts" TO credx_viewer_read;
CREATE VIEW credx_viewer."auto_rebalance_workflows" WITH (security_barrier=true) AS SELECT t."id", t."portfolio", t."sequence", t."status", t."current_stage", t."completed_at", t."created_at", t."updated_at" FROM public."auto_rebalance_workflows" t WHERE t.user_id = __PRIVATE_VERIFIED_OWNER_ID__;
ALTER VIEW credx_viewer."auto_rebalance_workflows" OWNER TO credx_viewer_views;
REVOKE ALL ON credx_viewer."auto_rebalance_workflows" FROM PUBLIC;
GRANT SELECT ON credx_viewer."auto_rebalance_workflows" TO credx_viewer_read;
CREATE VIEW credx_viewer."auto_rebalance_workflow_stages" WITH (security_barrier=true) AS SELECT t."id", t."workflow_id", t."stage", t."status", t."started_at", t."completed_at", t."created_at", t."updated_at" FROM public."auto_rebalance_workflow_stages" t WHERE EXISTS (SELECT 1 FROM public.auto_rebalance_workflows w WHERE w.id = t.workflow_id AND w.user_id = __PRIVATE_VERIFIED_OWNER_ID__) AND (t.run_id IS NULL OR EXISTS (SELECT 1 FROM public.runs r WHERE r.id = t.run_id AND r.user_id = __PRIVATE_VERIFIED_OWNER_ID__)) AND (t.job_id IS NULL OR EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = t.job_id AND j.user_id = __PRIVATE_VERIFIED_OWNER_ID__));
ALTER VIEW credx_viewer."auto_rebalance_workflow_stages" OWNER TO credx_viewer_views;
REVOKE ALL ON credx_viewer."auto_rebalance_workflow_stages" FROM PUBLIC;
GRANT SELECT ON credx_viewer."auto_rebalance_workflow_stages" TO credx_viewer_read;
CREATE VIEW credx_viewer."final_actionable_history" WITH (security_barrier=true) AS SELECT t."id", t."market", t."stock_symbol", t."stock_name", t."covered_at", t."action", t."score", t."consensus_numerator", t."consensus_denominator", t."historical_current_units", t."historical_current_value", t."action_units", t."amount", t."formula_version", t."coverage_status", t."created_at", t."updated_at" FROM public."final_actionable_history" t WHERE t.user_id = __PRIVATE_VERIFIED_OWNER_ID__ AND EXISTS (SELECT 1 FROM public.runs r WHERE r.id = t.rebalance_run_id AND r.user_id = __PRIVATE_VERIFIED_OWNER_ID__) AND (t.workflow_id IS NULL OR EXISTS (SELECT 1 FROM public.auto_rebalance_workflows w WHERE w.id = t.workflow_id AND w.user_id = __PRIVATE_VERIFIED_OWNER_ID__)) AND (t.technical_scan_run_id IS NULL OR EXISTS (SELECT 1 FROM public.runs r WHERE r.id = t.technical_scan_run_id AND r.user_id = __PRIVATE_VERIFIED_OWNER_ID__));
ALTER VIEW credx_viewer."final_actionable_history" OWNER TO credx_viewer_views;
REVOKE ALL ON credx_viewer."final_actionable_history" FROM PUBLIC;
GRANT SELECT ON credx_viewer."final_actionable_history" TO credx_viewer_read;
CREATE VIEW credx_viewer."zerodha_portfolio_snapshots" WITH (security_barrier=true) AS SELECT t."id", t."snapshot_date", t."captured_at", t."source", t."holdings_count", t."net_positions_count", t."day_positions_count", t."holdings_market_value", t."holdings_pnl", t."holdings_day_change_value", t."available_margin", t."positions_pnl", t."positions_m2m", t."holdings_invested_value", t."created_at", t."updated_at" FROM public."zerodha_portfolio_snapshots" t WHERE t.user_id = __PRIVATE_VERIFIED_OWNER_ID__;
ALTER VIEW credx_viewer."zerodha_portfolio_snapshots" OWNER TO credx_viewer_views;
REVOKE ALL ON credx_viewer."zerodha_portfolio_snapshots" FROM PUBLIC;
GRANT SELECT ON credx_viewer."zerodha_portfolio_snapshots" TO credx_viewer_read;
CREATE VIEW credx_viewer."indmoney_us_portfolio_snapshots" WITH (security_barrier=true) AS SELECT t."id", t."snapshot_date", t."captured_at", t."source", t."parse_status", t."holdings_count", t."reported_holdings_count", t."indices_count", t."wallet_balance", t."current_value", t."invested_value", t."day_return_value", t."day_return_percent", t."total_return_value", t."total_return_percent", t."created_at", t."updated_at" FROM public."indmoney_us_portfolio_snapshots" t WHERE t.user_id = __PRIVATE_VERIFIED_OWNER_ID__;
ALTER VIEW credx_viewer."indmoney_us_portfolio_snapshots" OWNER TO credx_viewer_views;
REVOKE ALL ON credx_viewer."indmoney_us_portfolio_snapshots" FROM PUBLIC;
GRANT SELECT ON credx_viewer."indmoney_us_portfolio_snapshots" TO credx_viewer_read;
CREATE VIEW credx_viewer."llm_provider_usage_calls" WITH (security_barrier=true) AS SELECT t."id", t."provider", t."model", t."occurred_at", t."tokens_in", t."tokens_out", t."cache_hit_tokens", t."cache_miss_tokens", t."actual_cost", t."created_at", t."updated_at" FROM public."llm_provider_usage_calls" t WHERE t.user_id = __PRIVATE_VERIFIED_OWNER_ID__ AND (t.job_id IS NULL OR EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = t.job_id AND j.user_id = __PRIVATE_VERIFIED_OWNER_ID__));
ALTER VIEW credx_viewer."llm_provider_usage_calls" OWNER TO credx_viewer_views;
REVOKE ALL ON credx_viewer."llm_provider_usage_calls" FROM PUBLIC;
GRANT SELECT ON credx_viewer."llm_provider_usage_calls" TO credx_viewer_read;
CREATE VIEW credx_viewer."llm_provider_usage_daily_snapshots" WITH (security_barrier=true) AS SELECT t."id", t."provider", t."model", t."usage_date", t."timezone", t."requests", t."tokens_in", t."tokens_out", t."cache_hit_tokens", t."cache_miss_tokens", t."actual_cost", t."source", t."captured_at", t."created_at", t."updated_at" FROM public."llm_provider_usage_daily_snapshots" t WHERE t.user_id = __PRIVATE_VERIFIED_OWNER_ID__;
ALTER VIEW credx_viewer."llm_provider_usage_daily_snapshots" OWNER TO credx_viewer_views;
REVOKE ALL ON credx_viewer."llm_provider_usage_daily_snapshots" FROM PUBLIC;
GRANT SELECT ON credx_viewer."llm_provider_usage_daily_snapshots" TO credx_viewer_read;
-- Fixed privilege gate; no user data or identity is printed.
DO $audit$
DECLARE
  reader oid := (SELECT oid FROM pg_roles WHERE rolname='credx_viewer_read');
  views_owner oid := (SELECT oid FROM pg_roles WHERE rolname='credx_viewer_views');
BEGIN
  IF reader IS NULL OR views_owner IS NULL OR EXISTS (
    SELECT 1 FROM pg_roles WHERE oid IN (reader, views_owner)
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit
        OR (oid=views_owner AND rolcanlogin) OR (oid=reader AND (NOT rolcanlogin OR rolconnlimit NOT BETWEEN 1 AND 2)))
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members WHERE member IN (reader,views_owner) OR roleid IN (reader,views_owner)
  ) THEN
    RAISE EXCEPTION 'Viewer role attributes or membership permit privilege escalation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_database d WHERE d.datallowconn AND
      ((has_database_privilege(reader,d.oid,'CONNECT') AND has_database_privilege(reader,d.oid,'CREATE,TEMP'))
       OR (has_database_privilege(views_owner,d.oid,'CONNECT') AND has_database_privilege(views_owner,d.oid,'CREATE,TEMP'))
       OR d.datdba IN (reader,views_owner))
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_temp_[0-9]+$' AND
      (has_schema_privilege(reader,n.oid,'CREATE') OR (n.nspname<>'credx_viewer' AND has_schema_privilege(views_owner,n.oid,'CREATE'))
       OR (n.nspowner=views_owner AND n.nspname<>'credx_viewer'))
  ) THEN
    RAISE EXCEPTION 'Ambient CREATE/TEMP/ownership prevents strict viewer isolation; no PUBLIC grants changed';
  END IF;
  IF has_any_column_privilege(reader,'pg_catalog.pg_authid','SELECT')
     OR has_any_column_privilege(views_owner,'pg_catalog.pg_authid','SELECT')
     OR has_table_privilege(reader,'pg_catalog.pg_shadow','SELECT')
     OR has_table_privilege(views_owner,'pg_catalog.pg_shadow','SELECT')
     OR has_column_privilege(reader,'pg_catalog.pg_subscription','subconninfo','SELECT')
     OR has_column_privilege(views_owner,'pg_catalog.pg_subscription','subconninfo','SELECT') THEN
    RAISE EXCEPTION 'Effective system credential-catalog access prevents viewer isolation';
  END IF;
  -- The view owner may SELECT only the exact listed base columns, never a table-wide grant.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema','credx_viewer')
      AND n.nspname<>'pg_toast' AND n.nspname !~ '^pg_toast_temp_[0-9]+$' AND n.nspname !~ '^pg_temp_[0-9]+$' AND c.relkind IN ('r','p','v','m','f')
      AND (has_table_privilege(reader,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(reader,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
        OR has_table_privilege(views_owner,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  ) OR EXISTS (
    WITH expected(relation,column_name) AS (VALUES ('runs','auto_rebalance_portfolio'), ('runs','auto_rebalance_sequence'), ('runs','created_at'), ('runs','current_stage'), ('runs','id'), ('runs','status'), ('runs','updated_at'), ('runs','user_id'), ('jobs','created_at'), ('jobs','estimated_cost'), ('jobs','id'), ('jobs','model'), ('jobs','provider'), ('jobs','scheduled_at'), ('jobs','status'), ('jobs','tokens_in'), ('jobs','tokens_out'), ('jobs','updated_at'), ('jobs','user_id'), ('jobs','web_search_used'), ('run_jobs','created_at'), ('run_jobs','id'), ('run_jobs','job_id'), ('run_jobs','run_id'), ('run_jobs','stage'), ('run_jobs','updated_at'), ('prompts','created_at'), ('prompts','id'), ('prompts','is_active'), ('prompts','is_system'), ('prompts','updated_at'), ('prompts','user_id'), ('prompts','version'), ('auto_rebalance_workflows','completed_at'), ('auto_rebalance_workflows','created_at'), ('auto_rebalance_workflows','current_stage'), ('auto_rebalance_workflows','id'), ('auto_rebalance_workflows','portfolio'), ('auto_rebalance_workflows','sequence'), ('auto_rebalance_workflows','status'), ('auto_rebalance_workflows','updated_at'), ('auto_rebalance_workflows','user_id'), ('auto_rebalance_workflow_stages','completed_at'), ('auto_rebalance_workflow_stages','created_at'), ('auto_rebalance_workflow_stages','id'), ('auto_rebalance_workflow_stages','job_id'), ('auto_rebalance_workflow_stages','run_id'), ('auto_rebalance_workflow_stages','stage'), ('auto_rebalance_workflow_stages','started_at'), ('auto_rebalance_workflow_stages','status'), ('auto_rebalance_workflow_stages','updated_at'), ('auto_rebalance_workflow_stages','workflow_id'), ('final_actionable_history','action'), ('final_actionable_history','action_units'), ('final_actionable_history','amount'), ('final_actionable_history','consensus_denominator'), ('final_actionable_history','consensus_numerator'), ('final_actionable_history','coverage_status'), ('final_actionable_history','covered_at'), ('final_actionable_history','created_at'), ('final_actionable_history','formula_version'), ('final_actionable_history','historical_current_units'), ('final_actionable_history','historical_current_value'), ('final_actionable_history','id'), ('final_actionable_history','market'), ('final_actionable_history','rebalance_run_id'), ('final_actionable_history','score'), ('final_actionable_history','stock_name'), ('final_actionable_history','stock_symbol'), ('final_actionable_history','technical_scan_run_id'), ('final_actionable_history','updated_at'), ('final_actionable_history','user_id'), ('final_actionable_history','workflow_id'), ('zerodha_portfolio_snapshots','available_margin'), ('zerodha_portfolio_snapshots','captured_at'), ('zerodha_portfolio_snapshots','created_at'), ('zerodha_portfolio_snapshots','day_positions_count'), ('zerodha_portfolio_snapshots','holdings_count'), ('zerodha_portfolio_snapshots','holdings_day_change_value'), ('zerodha_portfolio_snapshots','holdings_invested_value'), ('zerodha_portfolio_snapshots','holdings_market_value'), ('zerodha_portfolio_snapshots','holdings_pnl'), ('zerodha_portfolio_snapshots','id'), ('zerodha_portfolio_snapshots','net_positions_count'), ('zerodha_portfolio_snapshots','positions_m2m'), ('zerodha_portfolio_snapshots','positions_pnl'), ('zerodha_portfolio_snapshots','snapshot_date'), ('zerodha_portfolio_snapshots','source'), ('zerodha_portfolio_snapshots','updated_at'), ('zerodha_portfolio_snapshots','user_id'), ('indmoney_us_portfolio_snapshots','captured_at'), ('indmoney_us_portfolio_snapshots','created_at'), ('indmoney_us_portfolio_snapshots','current_value'), ('indmoney_us_portfolio_snapshots','day_return_percent'), ('indmoney_us_portfolio_snapshots','day_return_value'), ('indmoney_us_portfolio_snapshots','holdings_count'), ('indmoney_us_portfolio_snapshots','id'), ('indmoney_us_portfolio_snapshots','indices_count'), ('indmoney_us_portfolio_snapshots','invested_value'), ('indmoney_us_portfolio_snapshots','parse_status'), ('indmoney_us_portfolio_snapshots','reported_holdings_count'), ('indmoney_us_portfolio_snapshots','snapshot_date'), ('indmoney_us_portfolio_snapshots','source'), ('indmoney_us_portfolio_snapshots','total_return_percent'), ('indmoney_us_portfolio_snapshots','total_return_value'), ('indmoney_us_portfolio_snapshots','updated_at'), ('indmoney_us_portfolio_snapshots','user_id'), ('indmoney_us_portfolio_snapshots','wallet_balance'), ('llm_provider_usage_calls','actual_cost'), ('llm_provider_usage_calls','cache_hit_tokens'), ('llm_provider_usage_calls','cache_miss_tokens'), ('llm_provider_usage_calls','created_at'), ('llm_provider_usage_calls','id'), ('llm_provider_usage_calls','job_id'), ('llm_provider_usage_calls','model'), ('llm_provider_usage_calls','occurred_at'), ('llm_provider_usage_calls','provider'), ('llm_provider_usage_calls','tokens_in'), ('llm_provider_usage_calls','tokens_out'), ('llm_provider_usage_calls','updated_at'), ('llm_provider_usage_calls','user_id'), ('llm_provider_usage_daily_snapshots','actual_cost'), ('llm_provider_usage_daily_snapshots','cache_hit_tokens'), ('llm_provider_usage_daily_snapshots','cache_miss_tokens'), ('llm_provider_usage_daily_snapshots','captured_at'), ('llm_provider_usage_daily_snapshots','created_at'), ('llm_provider_usage_daily_snapshots','id'), ('llm_provider_usage_daily_snapshots','model'), ('llm_provider_usage_daily_snapshots','provider'), ('llm_provider_usage_daily_snapshots','requests'), ('llm_provider_usage_daily_snapshots','source'), ('llm_provider_usage_daily_snapshots','timezone'), ('llm_provider_usage_daily_snapshots','tokens_in'), ('llm_provider_usage_daily_snapshots','tokens_out'), ('llm_provider_usage_daily_snapshots','updated_at'), ('llm_provider_usage_daily_snapshots','usage_date'), ('llm_provider_usage_daily_snapshots','user_id'))
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname NOT IN ('pg_catalog','information_schema','credx_viewer')
      AND n.nspname<>'pg_toast' AND n.nspname !~ '^pg_toast_temp_[0-9]+$' AND n.nspname !~ '^pg_temp_[0-9]+$' AND c.relkind IN ('r','p','v','m','f')
      AND (has_column_privilege(views_owner,c.oid,a.attnum,'INSERT,UPDATE,REFERENCES,SELECT WITH GRANT OPTION') OR
        (has_column_privilege(views_owner,c.oid,a.attnum,'SELECT') AND NOT EXISTS (
          SELECT 1 FROM expected e WHERE n.nspname='public' AND e.relation=c.relname AND e.column_name=a.attname)))
  ) OR EXISTS (
    WITH expected(relation,column_name) AS (VALUES ('runs','auto_rebalance_portfolio'), ('runs','auto_rebalance_sequence'), ('runs','created_at'), ('runs','current_stage'), ('runs','id'), ('runs','status'), ('runs','updated_at'), ('runs','user_id'), ('jobs','created_at'), ('jobs','estimated_cost'), ('jobs','id'), ('jobs','model'), ('jobs','provider'), ('jobs','scheduled_at'), ('jobs','status'), ('jobs','tokens_in'), ('jobs','tokens_out'), ('jobs','updated_at'), ('jobs','user_id'), ('jobs','web_search_used'), ('run_jobs','created_at'), ('run_jobs','id'), ('run_jobs','job_id'), ('run_jobs','run_id'), ('run_jobs','stage'), ('run_jobs','updated_at'), ('prompts','created_at'), ('prompts','id'), ('prompts','is_active'), ('prompts','is_system'), ('prompts','updated_at'), ('prompts','user_id'), ('prompts','version'), ('auto_rebalance_workflows','completed_at'), ('auto_rebalance_workflows','created_at'), ('auto_rebalance_workflows','current_stage'), ('auto_rebalance_workflows','id'), ('auto_rebalance_workflows','portfolio'), ('auto_rebalance_workflows','sequence'), ('auto_rebalance_workflows','status'), ('auto_rebalance_workflows','updated_at'), ('auto_rebalance_workflows','user_id'), ('auto_rebalance_workflow_stages','completed_at'), ('auto_rebalance_workflow_stages','created_at'), ('auto_rebalance_workflow_stages','id'), ('auto_rebalance_workflow_stages','job_id'), ('auto_rebalance_workflow_stages','run_id'), ('auto_rebalance_workflow_stages','stage'), ('auto_rebalance_workflow_stages','started_at'), ('auto_rebalance_workflow_stages','status'), ('auto_rebalance_workflow_stages','updated_at'), ('auto_rebalance_workflow_stages','workflow_id'), ('final_actionable_history','action'), ('final_actionable_history','action_units'), ('final_actionable_history','amount'), ('final_actionable_history','consensus_denominator'), ('final_actionable_history','consensus_numerator'), ('final_actionable_history','coverage_status'), ('final_actionable_history','covered_at'), ('final_actionable_history','created_at'), ('final_actionable_history','formula_version'), ('final_actionable_history','historical_current_units'), ('final_actionable_history','historical_current_value'), ('final_actionable_history','id'), ('final_actionable_history','market'), ('final_actionable_history','rebalance_run_id'), ('final_actionable_history','score'), ('final_actionable_history','stock_name'), ('final_actionable_history','stock_symbol'), ('final_actionable_history','technical_scan_run_id'), ('final_actionable_history','updated_at'), ('final_actionable_history','user_id'), ('final_actionable_history','workflow_id'), ('zerodha_portfolio_snapshots','available_margin'), ('zerodha_portfolio_snapshots','captured_at'), ('zerodha_portfolio_snapshots','created_at'), ('zerodha_portfolio_snapshots','day_positions_count'), ('zerodha_portfolio_snapshots','holdings_count'), ('zerodha_portfolio_snapshots','holdings_day_change_value'), ('zerodha_portfolio_snapshots','holdings_invested_value'), ('zerodha_portfolio_snapshots','holdings_market_value'), ('zerodha_portfolio_snapshots','holdings_pnl'), ('zerodha_portfolio_snapshots','id'), ('zerodha_portfolio_snapshots','net_positions_count'), ('zerodha_portfolio_snapshots','positions_m2m'), ('zerodha_portfolio_snapshots','positions_pnl'), ('zerodha_portfolio_snapshots','snapshot_date'), ('zerodha_portfolio_snapshots','source'), ('zerodha_portfolio_snapshots','updated_at'), ('zerodha_portfolio_snapshots','user_id'), ('indmoney_us_portfolio_snapshots','captured_at'), ('indmoney_us_portfolio_snapshots','created_at'), ('indmoney_us_portfolio_snapshots','current_value'), ('indmoney_us_portfolio_snapshots','day_return_percent'), ('indmoney_us_portfolio_snapshots','day_return_value'), ('indmoney_us_portfolio_snapshots','holdings_count'), ('indmoney_us_portfolio_snapshots','id'), ('indmoney_us_portfolio_snapshots','indices_count'), ('indmoney_us_portfolio_snapshots','invested_value'), ('indmoney_us_portfolio_snapshots','parse_status'), ('indmoney_us_portfolio_snapshots','reported_holdings_count'), ('indmoney_us_portfolio_snapshots','snapshot_date'), ('indmoney_us_portfolio_snapshots','source'), ('indmoney_us_portfolio_snapshots','total_return_percent'), ('indmoney_us_portfolio_snapshots','total_return_value'), ('indmoney_us_portfolio_snapshots','updated_at'), ('indmoney_us_portfolio_snapshots','user_id'), ('indmoney_us_portfolio_snapshots','wallet_balance'), ('llm_provider_usage_calls','actual_cost'), ('llm_provider_usage_calls','cache_hit_tokens'), ('llm_provider_usage_calls','cache_miss_tokens'), ('llm_provider_usage_calls','created_at'), ('llm_provider_usage_calls','id'), ('llm_provider_usage_calls','job_id'), ('llm_provider_usage_calls','model'), ('llm_provider_usage_calls','occurred_at'), ('llm_provider_usage_calls','provider'), ('llm_provider_usage_calls','tokens_in'), ('llm_provider_usage_calls','tokens_out'), ('llm_provider_usage_calls','updated_at'), ('llm_provider_usage_calls','user_id'), ('llm_provider_usage_daily_snapshots','actual_cost'), ('llm_provider_usage_daily_snapshots','cache_hit_tokens'), ('llm_provider_usage_daily_snapshots','cache_miss_tokens'), ('llm_provider_usage_daily_snapshots','captured_at'), ('llm_provider_usage_daily_snapshots','created_at'), ('llm_provider_usage_daily_snapshots','id'), ('llm_provider_usage_daily_snapshots','model'), ('llm_provider_usage_daily_snapshots','provider'), ('llm_provider_usage_daily_snapshots','requests'), ('llm_provider_usage_daily_snapshots','source'), ('llm_provider_usage_daily_snapshots','timezone'), ('llm_provider_usage_daily_snapshots','tokens_in'), ('llm_provider_usage_daily_snapshots','tokens_out'), ('llm_provider_usage_daily_snapshots','updated_at'), ('llm_provider_usage_daily_snapshots','usage_date'), ('llm_provider_usage_daily_snapshots','user_id'))
    SELECT 1 FROM expected e WHERE NOT has_column_privilege(views_owner,format('public.%I',e.relation),e.column_name,'SELECT')
  ) THEN
    RAISE EXCEPTION 'Effective base-relation/column privileges differ from the reviewed allowlist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relowner IN (reader,views_owner) AND
      (c.relowner=reader OR n.nspname<>'credx_viewer' OR c.relkind<>'v' OR c.relname NOT IN ('runs', 'jobs', 'run_jobs', 'prompts', 'auto_rebalance_workflows', 'auto_rebalance_workflow_stages', 'final_actionable_history', 'zerodha_portfolio_snapshots', 'indmoney_us_portfolio_snapshots', 'llm_provider_usage_calls', 'llm_provider_usage_daily_snapshots'))
  ) OR EXISTS (
    SELECT 1 FROM pg_proc WHERE proowner IN (reader,views_owner)
  ) THEN
    RAISE EXCEPTION 'Dedicated viewer roles own unexpected objects';
  END IF;
  -- Reject grantees introduced by default ACLs, including grant-option leakage.
  IF EXISTS (
    SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
    WHERE n.nspname='credx_viewer' AND (a.grantee NOT IN (reader,views_owner)
      OR (a.grantee=reader AND (a.privilege_type<>'USAGE' OR a.is_grantable)))
  ) OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE n.nspname='credx_viewer' AND (a.grantee NOT IN (reader,views_owner)
      OR (a.grantee=reader AND (a.privilege_type<>'SELECT' OR a.is_grantable)))
  ) OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute col ON col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped
      CROSS JOIN LATERAL aclexplode(col.attacl) a
    WHERE n.nspname='credx_viewer' AND (a.grantee NOT IN (reader,views_owner)
      OR (a.grantee=reader AND (a.privilege_type<>'SELECT' OR a.is_grantable)))
  ) THEN
    RAISE EXCEPTION 'Unexpected viewer schema/view ACL grantee or grant option';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE prosecdef AND
      (has_function_privilege(reader,oid,'EXECUTE') OR has_function_privilege(views_owner,oid,'EXECUTE'))
  ) OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema') AND
      (has_sequence_privilege(reader,c.oid,'USAGE,SELECT,UPDATE') OR has_sequence_privilege(views_owner,c.oid,'USAGE,SELECT,UPDATE'))
  ) THEN
    RAISE EXCEPTION 'Unreviewed effective function/sequence privileges prevent viewer isolation';
  END IF;
END;
$audit$;

-- Mandatory in-transaction effective privilege audit before COMMIT:
-- reject any membership/SET ROLE path, base-table/column access, persistent writes,
-- schema/database CREATE, database TEMP, unsafe executable security-definer functions.
-- A PUBLIC-derived privilege cannot be denied by revoking it from this role alone.
-- If the audit fails, ROLLBACK; do not globally revoke PUBLIC or alter other services.
-- No password, credential generation, existing-object replacement, CASCADE or DROP here.
ROLLBACK; -- review template never commits
```
