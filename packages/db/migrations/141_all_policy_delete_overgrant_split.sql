-- 141_all_policy_delete_overgrant_split.sql
--
-- For every public ALL policy whose USING differs from WITH CHECK (or whose
-- WITH CHECK is NULL), replace it with command-specific SELECT/INSERT/UPDATE
-- policies. DELETE is deliberately not recreated: RLS DELETE uses only USING,
-- so an ALL policy silently grants deletes to everyone matching USING.
--
-- Pseudonymous backup of the original ALL definitions is kept in
-- app.rls_migration_3b_policy_backup so the rollback file can restore them.
-- Five policies had NULL WITH CHECK; those write paths are not recreated
-- (narrowing). patient_accounts still has its separate INSERT policy, which
-- preserves self-registration.
--
-- DELETE grants are revoked on all affected tables and on patients. No hard
-- delete flow was found for any of them (rg over apps/scripts/tests).
--
-- Rollback: packages/db/rollbacks/141_all_policy_delete_overgrant_split_rollback.sql

BEGIN;

CREATE TABLE IF NOT EXISTS app.rls_migration_3b_policy_backup (
  tablename text NOT NULL,
  policyname text NOT NULL,
  roles name[],
  qual text,
  with_check text,
  PRIMARY KEY (tablename, policyname)
);

DELETE FROM app.rls_migration_3b_policy_backup;

INSERT INTO app.rls_migration_3b_policy_backup (tablename, policyname, roles, qual, with_check)
SELECT tablename, policyname, roles, qual, with_check
FROM pg_policies
WHERE schemaname='public'
  AND cmd='ALL'
  AND (with_check IS NULL OR qual IS DISTINCT FROM with_check);

DO $split$
DECLARE
  item record;
  roles_clause text;
BEGIN
  FOR item IN SELECT * FROM app.rls_migration_3b_policy_backup ORDER BY tablename, policyname LOOP
    roles_clause := CASE
      WHEN item.roles IS NULL OR item.roles = ARRAY['public']::name[] THEN ''
      ELSE ' TO ' || (SELECT string_agg(quote_ident(r::text), ', ') FROM unnest(item.roles) r)
    END;

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', item.policyname, item.tablename);

    IF item.qual IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', item.policyname || '_rls_select', item.tablename);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT%s USING (%s)',
        item.policyname || '_rls_select', item.tablename, roles_clause, item.qual
      );
    END IF;

    IF item.with_check IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', item.policyname || '_rls_insert', item.tablename);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR INSERT%s WITH CHECK (%s)',
        item.policyname || '_rls_insert', item.tablename, roles_clause, item.with_check
      );
    END IF;

    IF item.qual IS NOT NULL AND item.with_check IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', item.policyname || '_rls_update', item.tablename);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR UPDATE%s USING (%s) WITH CHECK (%s)',
        item.policyname || '_rls_update', item.tablename, roles_clause, item.qual, item.with_check
      );
    END IF;
  END LOOP;
END
$split$;

DO $grants$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT DISTINCT tablename FROM app.rls_migration_3b_policy_backup
    UNION SELECT 'patients'::text
    ORDER BY 1
  LOOP
    EXECUTE format('REVOKE DELETE ON public.%I FROM medveris_runtime', item.tablename);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='medveris_app') THEN
      EXECUTE format('REVOKE DELETE ON public.%I FROM medveris_app', item.tablename);
    END IF;
  END LOOP;
END
$grants$;

COMMIT;
