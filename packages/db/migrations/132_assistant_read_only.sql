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
-- Prepared, NOT applied to staging or production. Applying it is an operator
-- action: see docs/observability/SECRETS-RUNBOOK.md and the migration runbook.
--
-- Rollback:
--   DROP ROLE medveris_assistant;   -- takes effect immediately; grants die with it
--
BEGIN;

-- Idempotent: safe to re-run if the role was created out of band.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medveris_assistant') THEN
    CREATE ROLE medveris_assistant LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  ELSE
    ALTER ROLE medveris_assistant NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Start from zero: a re-run must not accumulate privileges.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM medveris_assistant;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM medveris_assistant;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM medveris_assistant;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM medveris_assistant;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM medveris_assistant;
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

COMMENT ON ROLE medveris_assistant IS
  'Read-only assistant surface: EXECUTE on count-only app helpers, no table privileges, no BYPASSRLS.';

COMMIT;
