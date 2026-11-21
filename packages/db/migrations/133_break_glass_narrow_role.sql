-- 133_break_glass_narrow_role.sql
--
-- Break-glass without superuser.
--
-- The operator CLI and the observability surfaces need to answer one question:
-- "does this caller currently hold an active platform_operator grant?" That is
-- `app.is_platform_operator()`, a SECURITY DEFINER helper that reads
-- public.platform_roles on the caller's behalf.
--
-- This migration gives a dedicated role permission to call that helper and
-- nothing else. It deliberately does NOT:
--   * hand out superuser or BYPASSRLS,
--   * let the guard read the grant table directly,
--   * touch the migrator role, which must stay DDL-only.
--
-- An earlier draft granted SELECT on `app.platform_roles`. There are no
-- relations in the `app` schema at all (it holds functions only), so that
-- statement would have failed on apply. The table is `public.platform_roles`,
-- and it is not granted here on purpose: the guard should go through the
-- helper, which applies its own expiry and revocation checks.
--
-- The role itself is created by the operator bootstrap (`npm run db:setup`,
-- which connects as the database admin), not here: `medveris_migrator` is
-- NOCREATEROLE by design, so role DDL in a migration made every fresh database
-- unmigratable. This migration verifies the role exists with the intended
-- attributes and applies the grants. See
-- docs/observability/MIGRATION_132_133_RUNBOOK.md.
--
-- Rollback:
--   DROP ROLE medveris_operator_guard;
--
BEGIN;

DO $$
DECLARE
  role_row record;
BEGIN
  SELECT r.rolsuper, r.rolbypassrls, r.rolcanlogin INTO role_row
    FROM pg_roles r WHERE r.rolname = 'medveris_operator_guard';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role medveris_operator_guard is missing: run the operator bootstrap (npm run db:setup) before migrating'
      USING HINT = 'The migration role is NOCREATEROLE by design; see docs/observability/MIGRATION_132_133_RUNBOOK.md';
  END IF;
  IF role_row.rolsuper OR role_row.rolbypassrls THEN
    RAISE EXCEPTION 'role medveris_operator_guard must be NOSUPERUSER NOBYPASSRLS (found rolsuper=%, rolbypassrls=%)',
      role_row.rolsuper, role_row.rolbypassrls
      USING HINT = 'Recreate the role with scripts/db-setup.ts; break-glass must not bypass RLS';
  END IF;
END
$$;

-- Zero baseline, so a re-run cannot accumulate privileges.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM medveris_operator_guard;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM medveris_operator_guard;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM medveris_operator_guard;
REVOKE ALL ON FUNCTION app.is_platform_operator() FROM medveris_operator_guard;
REVOKE ALL ON SCHEMA app FROM medveris_operator_guard;
REVOKE ALL ON SCHEMA public FROM medveris_operator_guard;

-- The only capability this role has.
GRANT USAGE ON SCHEMA app TO medveris_operator_guard;
GRANT EXECUTE ON FUNCTION app.is_platform_operator() TO medveris_operator_guard;

-- The role comment is set by the bootstrap, where a role-owning superuser is
-- connected; COMMENT ON ROLE is not available to a NOCREATEROLE migrator.

COMMIT;
