-- RLS hardening migration 142: scope staff patient and patient-account reads to the active tenant.
-- Tenant membership via tenant_patient_links, created_tenant_id, or a grant the recipient tenant may read is required; broad staff reads are removed.
-- Minimal SECURITY DEFINER lookup functions are added for the grant-gated exchange route and exact-identity enrolment lookup; callers must audit their use in application code.

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

CREATE OR REPLACE FUNCTION app.patient_enrollment_lookup(p_public_id text, p_family_name text, p_date_of_birth date)
RETURNS TABLE (
  id uuid, public_id text, merged_into uuid, survivor_id uuid, survivor_public_id text,
  survivor_given_name text, survivor_family_name text, survivor_date_of_birth text,
  survivor_sex text, survivor_identity_confidence text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.public_id, p.merged_into,
         CASE WHEN p.merged_into IS NULL THEN p.id ELSE p.merged_into END AS survivor_id,
         COALESCE(s.public_id, p.public_id) AS survivor_public_id,
         COALESCE(s.given_name, p.given_name) AS survivor_given_name,
         COALESCE(s.family_name, p.family_name) AS survivor_family_name,
         to_char(COALESCE(s.date_of_birth, p.date_of_birth), 'YYYY-MM-DD') AS survivor_date_of_birth,
         COALESCE(s.sex, p.sex) AS survivor_sex,
         COALESCE(s.identity_confidence, p.identity_confidence) AS survivor_identity_confidence
  FROM public.patients p
  LEFT JOIN public.patients s ON s.id = p.merged_into AND s.merged_into IS NULL
  WHERE app.actor_kind() = 'staff'
    AND app.current_user() IS NOT NULL
    AND app.current_tenant() IS NOT NULL
    AND p.public_id = p_public_id
    AND lower(p.family_name) = lower(p_family_name)
    AND p.date_of_birth = p_date_of_birth
    AND (
      -- Tenant linkage: patient was created in this tenant, or is linked to it, or has an active grant the recipient tenant may read.
      p.created_tenant_id = app.current_tenant()
      OR EXISTS (
        SELECT 1
        FROM public.tenant_patient_links l
        WHERE l.patient_id = p.id
          AND l.tenant_id = app.current_tenant()
      )
      OR EXISTS (
        SELECT 1
        FROM public.exchange_grants g
        WHERE g.patient_id = p.id
          AND g.recipient_tenant_id = app.current_tenant()
          AND g.revoked_at IS NULL
          AND g.starts_at <= now()
          AND g.expires_at > now()
      )
    )
    AND (p.merged_into IS NULL OR s.id IS NOT NULL)
  LIMIT 1
$$;

ALTER FUNCTION app.patient_enrollment_lookup(text, text, date) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.patient_enrollment_lookup(text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.patient_enrollment_lookup(text, text, date) TO medveris_runtime;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medveris_app') THEN
    GRANT EXECUTE ON FUNCTION app.patient_enrollment_lookup(text, text, date) TO medveris_app;
  END IF;
END
$$;

ALTER TABLE public.patients FORCE ROW LEVEL SECURITY;
ALTER TABLE public.patient_accounts FORCE ROW LEVEL SECURITY;

COMMIT;
