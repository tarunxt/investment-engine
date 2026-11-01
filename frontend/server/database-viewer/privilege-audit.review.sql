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
