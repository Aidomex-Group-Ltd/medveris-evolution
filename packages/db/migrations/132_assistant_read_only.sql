-- 132_assistant_read_only.sql
--
-- Data-layer refusal enforcement for the assistant read path.
--
-- The assistant is an observability/support surface. It must be unable to read
-- clinical content even if a prompt, tool definition or job is written badly.
-- That guarantee cannot live in prompt text or application code alone, so this
-- migration creates a dedicated login role with genuinely narrow privileges:
--
--   * NOSUPERUSER, NOBYPASSRLS -> it is always subject to RLS.
--   * EXECUTE on the two count-only, platform-gated SECURITY DEFINER helpers
--     that already exist in the `app` schema.
--   * No table privileges anywhere. PostgreSQL grants nothing on tables to a
--     new role, so every clinical table read fails with "permission denied for
--     table ..." before RLS is even consulted.
--
-- The `app` schema holds functions only (no relations), so there is nothing to
-- grant SELECT on there; an earlier draft of this migration referenced tables
-- that do not exist and would have failed on apply.
--
-- The role itself is created by the operator bootstrap (`npm run db:setup`,
-- which connects as the database admin), not here. `medveris_migrator` is
-- deliberately NOCREATEROLE, so role DDL in a migration cannot run under the
-- normal migration role: it failed CI with "permission denied to create role"
-- and made every fresh database unmigratable. This migration only verifies the
-- role exists with the intended attributes and applies the grants.
-- See docs/observability/MIGRATION_132_133_RUNBOOK.md.
--
-- Rollback:
--   DROP ROLE medveris_assistant;   -- takes effect immediately; grants die with it
--
BEGIN;

-- Fail loudly and actionably if the bootstrap was not run, and refuse to
-- continue silently if the existing role is over-privileged. Both checks are
-- catalog reads, so they work for any migration role.
DO $$
DECLARE
  role_row record;
BEGIN
  SELECT r.rolsuper, r.rolbypassrls, r.rolcanlogin INTO role_row
    FROM pg_roles r WHERE r.rolname = 'medveris_assistant';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role medveris_assistant is missing: run the operator bootstrap (npm run db:setup) before migrating'
      USING HINT = 'The migration role is NOCREATEROLE by design; see docs/observability/MIGRATION_132_133_RUNBOOK.md';
  END IF;
  IF role_row.rolsuper OR role_row.rolbypassrls THEN
    RAISE EXCEPTION 'role medveris_assistant must be NOSUPERUSER NOBYPASSRLS (found rolsuper=%, rolbypassrls=%)',
      role_row.rolsuper, role_row.rolbypassrls
      USING HINT = 'Recreate the role with scripts/db-setup.ts; it must stay subject to RLS';
  END IF;
END
$$;

-- Start from zero: a re-run must not accumulate privileges.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM medveris_assistant;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM medveris_assistant;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM medveris_assistant;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM medveris_assistant;
REVOKE ALL ON FUNCTION app.security_event_summary(integer) FROM medveris_assistant;
REVOKE ALL ON FUNCTION app.outbox_backlog() FROM medveris_assistant;
REVOKE ALL ON SCHEMA app FROM medveris_assistant;

-- Schema USAGE only, on both schemas. This is deliberate: without USAGE on
-- `public` an unqualified clinical table name fails to resolve at all and the
-- refusal reads "relation does not exist", which hides which boundary was hit.
-- With USAGE but no table privilege the refusal is the honest
-- "permission denied for table <name>".
GRANT USAGE ON SCHEMA public TO medveris_assistant;
GRANT USAGE ON SCHEMA app TO medveris_assistant;

-- Count-only observability helpers. Both are SECURITY DEFINER and gate on
-- app.is_platform_operator() internally, so a caller without the operator GUC
-- gets an empty result rather than rows.
GRANT EXECUTE ON FUNCTION app.security_event_summary(integer) TO medveris_assistant;
GRANT EXECUTE ON FUNCTION app.outbox_backlog() TO medveris_assistant;

-- Deliberately NOT granted (clinical domain, and audit metadata that can
-- carry identifiers): clinical_entries, clinical_entry_versions, observations,
-- encounters, prescriptions, patients, appointments, documents, audit_events,
-- platform_roles, users, memberships. Reads on all of these fail with
-- "permission denied for table ...".

-- The role comment is set by the bootstrap, where a role-owning superuser is
-- connected; COMMENT ON ROLE is not available to a NOCREATEROLE migrator.

COMMIT;
