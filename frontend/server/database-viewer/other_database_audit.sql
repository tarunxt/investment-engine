-- Startup metadata-only audit of every other connectable database. No records read.
-- There are no approved persistent relation/function/sequence exposures here.
DO $other_audit$
DECLARE
  reader oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='credx_viewer_read');
  views_owner oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='credx_viewer_views');
BEGIN
  IF reader IS NULL OR views_owner IS NULL OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_temp_[0-9]+$'
      AND (has_schema_privilege(reader,n.oid,'CREATE') OR has_schema_privilege(views_owner,n.oid,'CREATE')
        OR n.nspowner IN (reader,views_owner))
  ) THEN RAISE EXCEPTION 'Other database schema privileges are outside the approved scope'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname<>'pg_toast'
      AND n.nspname !~ '^pg_(toast_)?temp_[0-9]+$'
      AND ((c.relkind IN ('r','p','v','m','f') AND
        (has_table_privilege(reader,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_any_column_privilege(reader,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
         OR has_table_privilege(views_owner,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_any_column_privilege(views_owner,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        OR (c.relkind='S' AND (has_sequence_privilege(reader,c.oid,'USAGE,SELECT,UPDATE')
          OR has_sequence_privilege(views_owner,c.oid,'USAGE,SELECT,UPDATE')))
        OR c.relowner IN (reader,views_owner))
  ) THEN RAISE EXCEPTION 'Other database protected relation privileges are outside the approved scope'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc WHERE proowner IN (reader,views_owner) OR
      (prosecdef AND (has_function_privilege(reader,oid,'EXECUTE') OR has_function_privilege(views_owner,oid,'EXECUTE')))
  ) OR has_any_column_privilege(reader,'pg_catalog.pg_authid','SELECT')
    OR has_any_column_privilege(views_owner,'pg_catalog.pg_authid','SELECT')
    OR has_table_privilege(reader,'pg_catalog.pg_shadow','SELECT')
    OR has_table_privilege(views_owner,'pg_catalog.pg_shadow','SELECT')
    OR has_column_privilege(reader,'pg_catalog.pg_subscription','subconninfo','SELECT')
    OR has_column_privilege(views_owner,'pg_catalog.pg_subscription','subconninfo','SELECT') THEN
    RAISE EXCEPTION 'Other database function/credential privileges are outside the approved scope';
  END IF;
END;
$other_audit$;
