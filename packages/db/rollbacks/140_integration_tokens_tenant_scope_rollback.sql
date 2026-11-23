-- Rollback for 140_integration_tokens_tenant_scope.sql
-- Restores the original integration_tokens_all (ALL, true/true) policy and the
-- tenant_id-less schema. Applying this intentionally re-opens all token access.

BEGIN;

DO $rollback$
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
$rollback$;

DROP TRIGGER IF EXISTS integration_tokens_tenant_sync ON public.integration_tokens;
DROP FUNCTION IF EXISTS app.integration_tokens_tenant_sync();

ALTER TABLE public.integration_tokens DROP COLUMN IF EXISTS tenant_id;

CREATE POLICY integration_tokens_all ON public.integration_tokens
  USING (true) WITH CHECK (true);

GRANT DELETE ON public.integration_tokens TO medveris_runtime;
DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='medveris_app') THEN
    EXECUTE 'GRANT DELETE ON public.integration_tokens TO medveris_app';
  END IF;
END
$roles$;

COMMIT;
