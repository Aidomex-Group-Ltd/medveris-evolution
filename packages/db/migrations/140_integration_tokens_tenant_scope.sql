-- 140_integration_tokens_tenant_scope.sql
--
-- Replace integration_tokens_all (ALL, USING true, WITH CHECK true) with
-- tenant-scoped read/write policies. Real system flows (OAuth token issue,
-- token authentication/last_used_at) and platform-operator revocation are
-- preserved; arbitrary tenant users no longer see or write tokens.
--
-- tenant_id is denormalized from integration_clients.tenant_id and kept in
-- sync by a SECURITY DEFINER trigger, so policies can trust the trigger-populated
-- value without giving runtime roles read access to integration_clients.
--
-- Rollback: packages/db/rollbacks/140_integration_tokens_tenant_scope_rollback.sql

BEGIN;

ALTER TABLE public.integration_tokens
  ADD COLUMN IF NOT EXISTS tenant_id uuid;

UPDATE public.integration_tokens t
SET tenant_id = c.tenant_id
FROM public.integration_clients c
WHERE t.client_id = c.id
  AND t.tenant_id IS DISTINCT FROM c.tenant_id;

CREATE INDEX IF NOT EXISTS integration_tokens_tenant_id_idx
  ON public.integration_tokens (tenant_id);

CREATE OR REPLACE FUNCTION app.integration_tokens_tenant_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    SELECT c.tenant_id INTO NEW.tenant_id
    FROM public.integration_clients c
    WHERE c.id = NEW.client_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'integration_tokens: unknown client_id %', NEW.client_id
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION app.integration_tokens_tenant_sync() OWNER TO medveris_exchange;
GRANT SELECT ON public.integration_clients TO medveris_exchange;

DROP TRIGGER IF EXISTS integration_tokens_tenant_sync ON public.integration_tokens;
CREATE TRIGGER integration_tokens_tenant_sync
  BEFORE INSERT OR UPDATE OF client_id ON public.integration_tokens
  FOR EACH ROW EXECUTE FUNCTION app.integration_tokens_tenant_sync();

DO $migration$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT policyname FROM pg_policies
    WHERE schemaname='public' AND tablename='integration_tokens'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.integration_tokens', policy_row.policyname);
  END LOOP;
END
$migration$;

CREATE POLICY integration_tokens_read ON public.integration_tokens
  FOR SELECT
  USING (
    app.actor_kind() = 'system'
    OR app.is_platform_operator()
    OR (
      tenant_id = app.current_tenant()
      AND app.actor_kind() = 'staff'
      AND app.has_any_role(ARRAY['facility_admin', 'it_admin'])
    )
  );

CREATE POLICY integration_tokens_insert ON public.integration_tokens
  FOR INSERT
  WITH CHECK (
    app.actor_kind() = 'system'
    OR app.is_platform_operator()
    OR (
      tenant_id = app.current_tenant()
      AND app.actor_kind() = 'staff'
      AND app.has_any_role(ARRAY['facility_admin', 'it_admin'])
    )
  );

CREATE POLICY integration_tokens_update ON public.integration_tokens
  FOR UPDATE
  USING (
    app.actor_kind() = 'system'
    OR app.is_platform_operator()
    OR (
      tenant_id = app.current_tenant()
      AND app.actor_kind() = 'staff'
      AND app.has_any_role(ARRAY['facility_admin', 'it_admin'])
    )
  )
  WITH CHECK (
    app.actor_kind() = 'system'
    OR app.is_platform_operator()
    OR (
      tenant_id = app.current_tenant()
      AND app.actor_kind() = 'staff'
      AND app.has_any_role(ARRAY['facility_admin', 'it_admin'])
    )
  );

REVOKE DELETE ON public.integration_tokens FROM medveris_runtime;
DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='medveris_app') THEN
    EXECUTE 'REVOKE DELETE ON public.integration_tokens FROM medveris_app';
  END IF;
END
$roles$;

ALTER TABLE public.integration_tokens
  ENABLE ROW LEVEL SECURITY,
  FORCE ROW LEVEL SECURITY;

COMMIT;
