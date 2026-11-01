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
