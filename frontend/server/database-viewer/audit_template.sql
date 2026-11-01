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
    WITH expected(relation,column_name) AS (VALUES __EXPECTED_COLUMN_VALUES__)
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname NOT IN ('pg_catalog','information_schema','credx_viewer')
      AND n.nspname<>'pg_toast' AND n.nspname !~ '^pg_toast_temp_[0-9]+$' AND n.nspname !~ '^pg_temp_[0-9]+$' AND c.relkind IN ('r','p','v','m','f')
      AND (has_column_privilege(views_owner,c.oid,a.attnum,'INSERT,UPDATE,REFERENCES,SELECT WITH GRANT OPTION') OR
        (has_column_privilege(views_owner,c.oid,a.attnum,'SELECT') AND NOT EXISTS (
          SELECT 1 FROM expected e WHERE n.nspname='public' AND e.relation=c.relname AND e.column_name=a.attname)))
  ) OR EXISTS (
    WITH expected(relation,column_name) AS (VALUES __EXPECTED_COLUMN_VALUES__)
    SELECT 1 FROM expected e WHERE NOT has_column_privilege(views_owner,format('public.%I',e.relation),e.column_name,'SELECT')
  ) THEN
    RAISE EXCEPTION 'Effective base-relation/column privileges differ from the reviewed allowlist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relowner IN (reader,views_owner) AND
      (c.relowner=reader OR n.nspname<>'credx_viewer' OR c.relkind<>'v' OR c.relname NOT IN (__EXPECTED_RELATIONS__))
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
