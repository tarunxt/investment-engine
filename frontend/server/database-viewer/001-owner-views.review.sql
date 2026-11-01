-- REVIEW TEMPLATE ONLY: invalid private placeholders deliberately prevent direct execution.
-- Apply only after live relation/column/ownership and effective privilege review.
-- Versioned native-viewer provisioning migration; no application data is modified.
BEGIN;
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
-- Run inside the reviewed provisioning transaction, after creating only NEW objects.
-- This gate intentionally fails if PUBLIC defaults defeat strict isolation.
-- It changes no global/public privileges and prints no account identity.
DO $audit$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname IN ('credx_viewer_read', 'credx_viewer_views')
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
    WHERE r.rolname IN ('credx_viewer_read', 'credx_viewer_views')
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
    WHERE r.rolname='credx_viewer_views'
  ) THEN
    RAISE EXCEPTION 'Viewer role attributes or membership permit privilege escalation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_database d WHERE d.datallowconn
      AND has_database_privilege('credx_viewer_read', d.oid, 'CONNECT')
      AND has_database_privilege('credx_viewer_read', d.oid, 'CREATE,TEMP')
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_temp_%'
      AND has_schema_privilege('credx_viewer_read', n.oid, 'CREATE')
  ) THEN
    RAISE EXCEPTION 'Ambient CREATE/TEMP privilege prevents strict viewer isolation; no PUBLIC grants changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','f')
      AND n.nspname NOT IN ('pg_catalog','information_schema','credx_viewer')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
      AND (has_table_privilege('credx_viewer_read',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege('credx_viewer_read',c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
  ) OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='credx_viewer' AND c.relkind='v'
      AND has_table_privilege('credx_viewer_read',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  ) THEN
    RAISE EXCEPTION 'Viewer has effective base-relation access or view write privileges';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND has_function_privilege('credx_viewer_read',p.oid,'EXECUTE')
  ) OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND has_sequence_privilege('credx_viewer_read',c.oid,'USAGE,SELECT,UPDATE')
  ) THEN
    RAISE EXCEPTION 'Unreviewed effective function/sequence privileges prevent viewer isolation';
  END IF;
END
$audit$;

-- Mandatory in-transaction effective privilege audit before COMMIT:
-- reject any membership/SET ROLE path, base-table/column access, persistent writes,
-- schema/database CREATE, database TEMP, unsafe executable security-definer functions.
-- A PUBLIC-derived privilege cannot be denied by revoking it from this role alone.
-- If the audit fails, ROLLBACK; do not globally revoke PUBLIC or alter other services.
-- No password, credential generation, existing-object replacement, CASCADE or DROP here.
ROLLBACK; -- review template never commits
