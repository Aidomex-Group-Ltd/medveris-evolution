-- Rollback for 141_all_policy_delete_overgrant_split.sql
-- Recreates the original ALL policies from the backup table, removes the
-- command-specific split policies, and restores DELETE grants.

BEGIN;

DO $rollback$
DECLARE
  item record;
  roles_clause text;
BEGIN
  FOR item IN SELECT * FROM app.rls_migration_3b_policy_backup ORDER BY tablename, policyname LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', item.policyname, item.tablename);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', item.policyname || '_rls_select', item.tablename);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', item.policyname || '_rls_insert', item.tablename);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', item.policyname || '_rls_update', item.tablename);

    roles_clause := CASE
      WHEN item.roles IS NULL OR item.roles = ARRAY['public']::name[] THEN ''
      ELSE ' TO ' || (SELECT string_agg(quote_ident(r::text), ', ') FROM unnest(item.roles) r)
    END;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I%s%s%s',
      item.policyname,
      item.tablename,
      roles_clause,
      CASE WHEN item.qual IS NOT NULL THEN ' USING (' || item.qual || ')' ELSE '' END,
      CASE WHEN item.with_check IS NOT NULL THEN ' WITH CHECK (' || item.with_check || ')' ELSE '' END
    );
  END LOOP;
END
$rollback$;

DO $grants$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT DISTINCT tablename FROM app.rls_migration_3b_policy_backup
    UNION SELECT 'patients'::text
    ORDER BY 1
  LOOP
    EXECUTE format('GRANT DELETE ON public.%I TO medveris_runtime', item.tablename);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='medveris_app') THEN
      EXECUTE format('GRANT DELETE ON public.%I TO medveris_app', item.tablename);
    END IF;
  END LOOP;
END
$grants$;

DROP TABLE IF EXISTS app.rls_migration_3b_policy_backup;

COMMIT;
