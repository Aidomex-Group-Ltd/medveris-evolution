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
-- Prepared, NOT applied to staging or production.
--
-- Rollback:
--   DROP ROLE medveris_operator_guard;
--
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medveris_operator_guard') THEN
    CREATE ROLE medveris_operator_guard LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  ELSE
    ALTER ROLE medveris_operator_guard NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Zero baseline, so a re-run cannot accumulate privileges.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM medveris_operator_guard;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM medveris_operator_guard;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM medveris_operator_guard;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM medveris_operator_guard;
REVOKE ALL ON SCHEMA app FROM medveris_operator_guard;
REVOKE ALL ON SCHEMA public FROM medveris_operator_guard;

-- The only capability this role has.
GRANT USAGE ON SCHEMA app TO medveris_operator_guard;
GRANT EXECUTE ON FUNCTION app.is_platform_operator() TO medveris_operator_guard;

COMMENT ON ROLE medveris_operator_guard IS
  'Break-glass verification: EXECUTE on app.is_platform_operator() only. No table access, no BYPASSRLS.';

COMMIT;
