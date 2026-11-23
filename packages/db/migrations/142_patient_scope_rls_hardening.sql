-- RLS hardening migration 142: scope staff patient and patient-account reads to the active tenant.
-- Tenant membership via tenant_patient_links, created_tenant_id, or an active exchange grant is required; broad staff reads are removed.
-- A minimal SECURITY DEFINER lookup function is added for the grant-gated cross-facility exchange route; callers must audit its use in application code.

BEGIN;

DROP POLICY IF EXISTS patients_staff_read ON public.patients;
CREATE POLICY patients_staff_read ON public.patients
FOR SELECT TO public
USING (
  app.actor_kind() = 'staff'
  AND app.current_user() IS NOT NULL
  AND (
    EXISTS (
      SELECT 1
      FROM public.tenant_patient_links l
      WHERE l.patient_id = patients.id
        AND l.tenant_id = app.current_tenant()
    )
    OR patients.created_tenant_id = app.current_tenant()
    OR EXISTS (
      SELECT 1
      FROM public.exchange_grants g
      WHERE g.patient_id = patients.id
        AND g.recipient_tenant_id = app.current_tenant()
        AND g.revoked_at IS NULL
        AND g.starts_at <= now()
        AND g.expires_at > now()
    )
  )
);

DROP POLICY IF EXISTS patient_accounts_staff ON public.patient_accounts;
CREATE POLICY patient_accounts_staff ON public.patient_accounts
FOR SELECT TO public
USING (
  app.actor_kind() = 'staff'
  AND app.current_user() IS NOT NULL
  AND (
    EXISTS (
      SELECT 1
      FROM public.tenant_patient_links l
      WHERE l.patient_id = patient_accounts.patient_id
        AND l.tenant_id = app.current_tenant()
    )
    OR EXISTS (
      SELECT 1
      FROM public.patients p
      WHERE p.id = patient_accounts.patient_id
        AND p.created_tenant_id = app.current_tenant()
    )
    OR EXISTS (
      SELECT 1
      FROM public.exchange_grants g
      WHERE g.patient_id = patient_accounts.patient_id
        AND g.recipient_tenant_id = app.current_tenant()
        AND g.revoked_at IS NULL
        AND g.starts_at <= now()
        AND g.expires_at > now()
    )
  )
);

CREATE OR REPLACE FUNCTION app.patient_exchange_lookup(p_public_id text)
RETURNS TABLE (id uuid, public_id text, given_name text, family_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.public_id, p.given_name, p.family_name
  FROM public.patients p
  WHERE p.public_id = p_public_id
    AND p.merged_into IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.exchange_grants g
      WHERE g.patient_id = p.id
        AND g.recipient_tenant_id = app.current_tenant()
        AND g.revoked_at IS NULL
        AND g.starts_at <= now()
        AND g.expires_at > now()
    )
$$;

ALTER FUNCTION app.patient_exchange_lookup(text) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.patient_exchange_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.patient_exchange_lookup(text) TO medveris_runtime;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medveris_app') THEN
    GRANT EXECUTE ON FUNCTION app.patient_exchange_lookup(text) TO medveris_app;
  END IF;
END
$$;

ALTER TABLE public.patients FORCE ROW LEVEL SECURITY;
ALTER TABLE public.patient_accounts FORCE ROW LEVEL SECURITY;

COMMIT;
