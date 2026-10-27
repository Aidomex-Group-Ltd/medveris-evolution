-- Uganda-focused onboarding catalogue, role-based onboarding paths and
-- patient/caregiver proxy requests.
--
-- The catalogue is editable governance metadata, not a legal register. It is
-- versioned and only one version per country may be published at a time. A
-- catalogue entry never grants a clinical privilege or a system role by itself:
-- role grants and privilege grants remain separate, reviewed decisions.

BEGIN;

CREATE TABLE onboarding_catalogues (
  id uuid PRIMARY KEY,
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  notice text NOT NULL,
  content jsonb NOT NULL,
  content_digest text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES users(id),
  published_at timestamptz,
  retired_by uuid REFERENCES users(id),
  retired_at timestamptz,
  UNIQUE (country_code, version),
  CHECK (status <> 'published' OR (published_by IS NOT NULL AND published_at IS NOT NULL)),
  CHECK (status <> 'retired' OR (retired_by IS NOT NULL AND retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX onboarding_catalogues_one_published
  ON onboarding_catalogues(country_code) WHERE status = 'published';
CREATE INDEX onboarding_catalogues_status_idx ON onboarding_catalogues(country_code, status, version);

ALTER TABLE onboarding_catalogues ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_catalogues FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_catalogues_read ON onboarding_catalogues FOR SELECT USING (
  app.is_platform_operator()
  OR (status = 'published' AND app.current_user() IS NOT NULL)
);
CREATE POLICY onboarding_catalogues_write ON onboarding_catalogues FOR ALL USING (
  app.is_platform_operator()
) WITH CHECK (
  app.is_platform_operator()
);
GRANT SELECT, INSERT, UPDATE ON onboarding_catalogues TO medveris_runtime;

-- Catalogue wiring on the tenant-owned editable catalogue. Existing rows keep
-- working because every new column is nullable or defaulted.
ALTER TABLE departments ADD COLUMN catalogue_code text;
ALTER TABLE cadres
  ADD COLUMN catalogue_code text,
  ADD COLUMN regulator_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN requires_registration boolean NOT NULL DEFAULT false;
ALTER TABLE job_titles
  ADD COLUMN code text,
  ADD COLUMN catalogue_code text,
  ADD COLUMN seniority text CHECK (
    seniority IS NULL OR seniority IN ('entry','standard','senior','lead','consultant')
  ),
  ADD COLUMN requires_credential boolean NOT NULL DEFAULT false,
  ADD COLUMN privilege_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN suggested_system_roles text[] NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX job_titles_tenant_code_unique
  ON job_titles(tenant_id, code) WHERE code IS NOT NULL;

-- A single onboarding case may follow a staff, trainee or facility-admin path.
-- The catalogue values are a snapshot at submission time: editing a later
-- catalogue version must not silently change an in-flight decision.
ALTER TABLE onboarding_cases
  ADD COLUMN path text NOT NULL DEFAULT 'administrative' CHECK (path IN (
    'patient','proxy','clinician','nurse','allied_health','support',
    'administrative','trainee','facility_admin'
  )),
  ADD COLUMN catalogue_country_code text,
  ADD COLUMN catalogue_version integer,
  ADD COLUMN catalogue_title_code text,
  ADD COLUMN catalogue_cadre_code text,
  ADD COLUMN regulator_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN credential_required boolean NOT NULL DEFAULT false,
  ADD COLUMN requested_system_roles text[] NOT NULL DEFAULT '{}',
  ADD COLUMN approved_system_roles text[] NOT NULL DEFAULT '{}';

-- Proxy access is requested first and only becomes active after the patient or
-- an authorised facility reviewer approves it. Expiry is always explicit.
ALTER TABLE patient_proxies DROP CONSTRAINT IF EXISTS patient_proxies_status_check;
ALTER TABLE patient_proxies ADD CONSTRAINT patient_proxies_status_check CHECK (
  status IN ('requested','active','rejected','revoked','expired')
);
ALTER TABLE patient_proxies ALTER COLUMN granted_by DROP NOT NULL;
ALTER TABLE patient_proxies
  ADD COLUMN requested_by uuid REFERENCES users(id),
  ADD COLUMN reviewed_by uuid REFERENCES users(id),
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN decision_reason text;
ALTER TABLE patient_proxies ADD CONSTRAINT patient_proxies_active_granter CHECK (
  status <> 'active' OR granted_by IS NOT NULL
);
ALTER TABLE patient_proxies ADD CONSTRAINT patient_proxies_requested_by CHECK (
  status <> 'requested' OR requested_by IS NOT NULL
);
ALTER TABLE patient_proxies ADD CONSTRAINT patient_proxies_rejected_reason CHECK (
  status <> 'rejected' OR decision_reason IS NOT NULL
);

DROP POLICY IF EXISTS patient_proxies_access ON patient_proxies;
CREATE POLICY patient_proxies_access ON patient_proxies USING (
  proxy_user_id = app.current_user()
  OR patient_id = app.current_patient()
  OR (
    app.current_tenant() IS NOT NULL
    AND app.has_any_role(ARRAY['facility_admin','records','auditor'])
    AND EXISTS (
      SELECT 1 FROM tenant_patient_links l
       WHERE l.patient_id = patient_proxies.patient_id
         AND l.tenant_id = app.current_tenant()
    )
  )
) WITH CHECK (
  patient_id = app.current_patient()
  OR (
    app.current_tenant() IS NOT NULL
    AND app.has_any_role(ARRAY['facility_admin','records'])
    AND EXISTS (
      SELECT 1 FROM tenant_patient_links l
       WHERE l.patient_id = patient_proxies.patient_id
         AND l.tenant_id = app.current_tenant()
    )
  )
  OR (proxy_user_id = app.current_user() AND status = 'requested')
);

-- Credential evidence may be attached to a workforce onboarding case. The
-- independent reviewer decision stays in the existing credentials workflow.
ALTER TABLE credentials
  ADD COLUMN onboarding_case_id uuid REFERENCES onboarding_cases(id),
  ADD COLUMN staff_person_id uuid REFERENCES staff_persons(id),
  ADD COLUMN regulator_code text;
CREATE INDEX credentials_onboarding_idx ON credentials(onboarding_case_id);
CREATE INDEX credentials_staff_person_idx ON credentials(staff_person_id);

COMMIT;
