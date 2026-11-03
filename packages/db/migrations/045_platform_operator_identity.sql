-- Identity-bound platform operator check and row level security on platform_roles.
--
-- Before this migration app.is_platform_operator() answered "does any active operator
-- exist?" rather than "is the current user an active operator?". Since the synthetic
-- seed creates one permanent operator, every policy built on the helper (pricing tables,
-- onboarding catalogue, sponsored payment webhooks, EHMI reporting and the platform role
-- request table itself) was satisfied for every authenticated runtime session, and
-- platform_roles had RLS disabled entirely. A session with no user context also got true.
--
-- After this migration the helper only looks at the current user, and platform_roles
-- itself is protected with FORCE RLS so its owner cannot read it either.
--
-- The helper must be able to read platform_roles while that table enforces RLS against
-- its own owner, so it is SECURITY DEFINER and owned by the NOLOGIN BYPASSRLS role
-- medveris_exchange, matching the existing app.exchange_project / app.organization_role
-- pattern. Reading as the caller would either recurse through the SELECT policy or be
-- blocked by it.
--
-- The very first operator cannot be approved by an operator, so a bootstrap path exists:
-- scripts/platform-operator.ts (connecting as the migration role) sets the session
-- variable app.platform_roles_bootstrap for the duration of its transaction. No API
-- route sets that variable, so runtime sessions can still only write grants through the
-- four-eyes service layer in apps/api/src/lib/platform-roles.ts.

BEGIN;

CREATE OR REPLACE FUNCTION app.is_platform_operator()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.current_user() IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM platform_roles
        WHERE user_id = app.current_user()
          AND role = 'platform_operator'
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
     );
$$;

-- Owner holds BYPASSRLS (NOLOGIN), so the lookup is not subject to the policies it feeds.
ALTER FUNCTION app.is_platform_operator() OWNER TO medveris_exchange;
GRANT SELECT ON platform_roles TO medveris_exchange;

REVOKE ALL ON FUNCTION app.is_platform_operator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_platform_operator() TO medveris_runtime, medveris_jobs;

-- True only inside a break-glass CLI transaction (scripts/platform-operator.ts).
CREATE OR REPLACE FUNCTION app.platform_roles_bootstrap()
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.platform_roles_bootstrap', true), 'false') = 'true';
$$;

REVOKE ALL ON FUNCTION app.platform_roles_bootstrap() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_roles_bootstrap() TO medveris_runtime, medveris_jobs;

ALTER TABLE platform_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_roles FORCE ROW LEVEL SECURITY;

-- A user always sees their own grant rows; operators see every row; system jobs (the
-- expiry sweep) and the break-glass CLI need the full table.
DROP POLICY IF EXISTS platform_roles_self_read ON platform_roles;
CREATE POLICY platform_roles_self_read ON platform_roles FOR SELECT
  USING (
    user_id = app.current_user()
    OR app.is_platform_operator()
    OR app.actor_kind() = 'system'
    OR app.platform_roles_bootstrap()
  );

-- Four-eyes: an operator may create a grant for somebody else, never for themselves.
-- The bootstrap CLI is the only way to create the very first grant.
DROP POLICY IF EXISTS platform_roles_operator_insert ON platform_roles;
CREATE POLICY platform_roles_operator_insert ON platform_roles FOR INSERT
  WITH CHECK (
    (app.is_platform_operator() AND user_id <> app.current_user())
    OR app.platform_roles_bootstrap()
  );

-- Operators revoke; the expiry sweep updates expired rows as the system actor.
DROP POLICY IF EXISTS platform_roles_operator_update ON platform_roles;
CREATE POLICY platform_roles_operator_update ON platform_roles FOR UPDATE
  USING (app.is_platform_operator() OR app.actor_kind() = 'system' OR app.platform_roles_bootstrap())
  WITH CHECK (app.is_platform_operator() OR app.actor_kind() = 'system' OR app.platform_roles_bootstrap());

DROP POLICY IF EXISTS platform_roles_operator_delete ON platform_roles;
CREATE POLICY platform_roles_operator_delete ON platform_roles FOR DELETE
  USING (
    (app.is_platform_operator() AND user_id <> app.current_user())
    OR app.platform_roles_bootstrap()
  );

GRANT SELECT, UPDATE ON platform_roles TO medveris_jobs;

-- The previous revocation check made the scheduled expiry sweep impossible: it revoked
-- expired rows without a revoked_by user, which the old constraint rejected, so the
-- sweep threw instead of expiring stale permanent access. System expiry is now an
-- explicit reason, and the timestamp comparison falls back to created_at for legacy
-- grants that predate granted_at.
ALTER TABLE platform_roles DROP CONSTRAINT IF EXISTS platform_roles_revocation_check;
ALTER TABLE platform_roles ADD CONSTRAINT platform_roles_revocation_check CHECK (
  revoked_at IS NULL
  OR (
    revoked_at >= COALESCE(granted_at, created_at)
    AND (revoked_by IS NOT NULL OR revoked_reason = 'grant-expired')
  )
);

COMMIT;
