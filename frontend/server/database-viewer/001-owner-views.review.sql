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
