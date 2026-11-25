-- 139_memberships_rls_hardening.sql
--
-- Replace the permissive memberships INSERT/UPDATE/DELETE/ALL policies with an
-- explicit, narrow set. Policies are OR'd per command, so every existing write
-- policy (including ALL) is removed first; only the policies below remain.
--
-- The bootstrap NOT EXISTS check is routed through a SECURITY DEFINER helper so
-- it sees every membership in the tenant, not just rows visible to the
-- registration actor under RLS. The helper is owned by medveris_exchange
-- (BYPASSRLS), matching the existing app helper pattern.
--
-- Rollback: packages/db/rollbacks/139_memberships_rls_hardening_rollback.sql

BEGIN;

-- 1. Remove every policy that can grant INSERT, UPDATE or DELETE (ALL included).
DO $migration$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'memberships'
      AND cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE')
    ORDER BY policyname
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.memberships', policy_row.policyname);
  END LOOP;
END
$migration$;

-- 2. Helpers used by the policies and triggers.
CREATE OR REPLACE FUNCTION app.memberships_tenant_has_any(p_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = p_tenant);
$function$;
ALTER FUNCTION app.memberships_tenant_has_any(uuid) OWNER TO medveris_exchange;

CREATE OR REPLACE FUNCTION app.memberships_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF app.is_platform_operator() OR app.actor_kind() = 'system' THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'memberships: user_id and tenant_id are immutable'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.id = app.current_membership_id()
     AND OLD.user_id = app.current_user()
     AND (NEW.roles IS DISTINCT FROM OLD.roles OR NEW.status IS DISTINCT FROM OLD.status)
  THEN
    RAISE EXCEPTION 'memberships: owners cannot change their own roles or status'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$function$;
ALTER FUNCTION app.memberships_guard() OWNER TO medveris_exchange;

CREATE OR REPLACE FUNCTION app.memberships_last_admin_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  remaining integer;
BEGIN
  IF NOT (OLD.status = 'active' AND 'facility_admin' = ANY(OLD.roles)) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.status = 'active'
     AND 'facility_admin' = ANY(NEW.roles)
  THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO remaining
  FROM public.memberships m
  WHERE m.tenant_id = OLD.tenant_id
    AND m.id <> OLD.id
    AND m.status = 'active'
    AND 'facility_admin' = ANY(m.roles);

  IF remaining = 0 THEN
    RAISE EXCEPTION 'memberships: a tenant must retain at least one active facility_admin'
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION app.memberships_last_admin_guard() OWNER TO medveris_exchange;

DROP TRIGGER IF EXISTS memberships_guard ON public.memberships;
CREATE TRIGGER memberships_guard
  BEFORE UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION app.memberships_guard();

DROP TRIGGER IF EXISTS memberships_last_admin_guard ON public.memberships;
CREATE TRIGGER memberships_last_admin_guard
  BEFORE UPDATE OR DELETE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION app.memberships_last_admin_guard();

-- 3. SELECT semantics (tenant members, own rows, jobs role).
DROP POLICY IF EXISTS memberships_read ON public.memberships;
CREATE POLICY memberships_read ON public.memberships
  FOR SELECT
  USING (
    tenant_id = app.current_tenant()
    OR user_id = app.current_user()
    OR app.current_membership_id() = id
  );

DROP POLICY IF EXISTS memberships_jobs_usage ON public.memberships;
CREATE POLICY memberships_jobs_usage ON public.memberships
  FOR SELECT TO medveris_jobs
  USING (true);

-- 4. The only INSERT paths.
CREATE POLICY memberships_insert_operator ON public.memberships
  FOR INSERT
  WITH CHECK (app.is_platform_operator());

CREATE POLICY memberships_insert_registration ON public.memberships
  FOR INSERT
  WITH CHECK (
    app.actor_kind() IN ('registration', 'system')
    AND tenant_id = app.current_tenant()
  );

CREATE POLICY memberships_insert_bootstrap ON public.memberships
  FOR INSERT
  WITH CHECK (
    app.actor_kind() = 'registration'
    AND tenant_id = app.current_tenant()
    AND user_id = app.current_user()
    AND roles <@ ARRAY['owner', 'facility_admin']::text[]
    AND NOT app.memberships_tenant_has_any(tenant_id)
  );

CREATE POLICY memberships_insert_admin ON public.memberships
  FOR INSERT
  WITH CHECK (
    tenant_id = app.current_tenant()
    AND app.has_any_role(ARRAY['facility_admin'])
    AND NOT EXISTS (
      SELECT 1 FROM unnest(roles) AS r(role) WHERE r.role LIKE 'platform_%'
    )
  );

CREATE POLICY memberships_insert_invitation ON public.memberships
  FOR INSERT
  WITH CHECK (
    tenant_id = app.current_tenant()
    AND user_id = app.current_user()
    AND EXISTS (
      SELECT 1
      FROM public.invitations i
      WHERE i.tenant_id = memberships.tenant_id
        AND i.token_hash = app.invitation_token_hash()
        AND i.roles = memberships.roles
        AND i.accepted_at IS NULL
        AND i.revoked_at IS NULL
        AND i.declined_at IS NULL
        AND i.expires_at > now()
    )
  );

-- 5. UPDATE: admin may change others; self may change only non-role/status columns
--    (enforced by app.memberships_guard). A valid, unaccepted invitation may reactivate
--    the invitee's own soft-removed membership.
CREATE POLICY memberships_update_admin ON public.memberships
  FOR UPDATE
  USING (
    tenant_id = app.current_tenant()
    AND app.has_any_role(ARRAY['facility_admin'])
    AND id <> app.current_membership_id()
  )
  WITH CHECK (
    tenant_id = app.current_tenant()
    AND app.has_any_role(ARRAY['facility_admin'])
    AND id <> app.current_membership_id()
  );

CREATE POLICY memberships_update_self ON public.memberships
  FOR UPDATE
  USING (
    id = app.current_membership_id()
    AND tenant_id = app.current_tenant()
  )
  WITH CHECK (
    id = app.current_membership_id()
    AND tenant_id = app.current_tenant()
  );

CREATE POLICY memberships_update_invitation ON public.memberships
  FOR UPDATE
  USING (
    app.actor_kind() = 'registration'
    AND tenant_id = app.current_tenant()
    AND user_id = app.current_user()
    AND EXISTS (
      SELECT 1
      FROM public.invitations i
      WHERE i.tenant_id = memberships.tenant_id
        AND i.token_hash = app.invitation_token_hash()
        AND i.accepted_at IS NULL
        AND i.revoked_at IS NULL
        AND i.declined_at IS NULL
        AND i.expires_at > now()
    )
  )
  WITH CHECK (
    app.actor_kind() = 'registration'
    AND tenant_id = app.current_tenant()
    AND user_id = app.current_user()
    AND status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(roles) AS r(role) WHERE r.role LIKE 'platform_%'
    )
    AND EXISTS (
      SELECT 1
      FROM public.invitations i
      WHERE i.tenant_id = memberships.tenant_id
        AND i.token_hash = app.invitation_token_hash()
        AND i.accepted_at IS NULL
        AND i.revoked_at IS NULL
        AND i.declined_at IS NULL
        AND i.expires_at > now()
    )
  );

-- 6. DELETE: admin-only, never self. There is no application hard-delete flow.
CREATE POLICY memberships_delete_admin ON public.memberships
  FOR DELETE
  USING (
    tenant_id = app.current_tenant()
    AND app.has_any_role(ARRAY['facility_admin'])
    AND id <> app.current_membership_id()
  );

ALTER TABLE public.memberships
  ENABLE ROW LEVEL SECURITY,
  FORCE ROW LEVEL SECURITY;

COMMIT;
