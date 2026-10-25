-- Organisation hierarchy and workforce onboarding.
--
-- The hierarchy is organisation -> facility (tenant) -> department -> unit ->
-- location. Staff people have a global Medveris identity; engagement,
-- assignment and privilege records are facility-scoped. Job title, cadre,
-- appointment and clinical privilege remain separate concepts.

BEGIN;

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  legal_name text,
  registration_ref text,
  country text NOT NULL DEFAULT 'Uganda',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ADD COLUMN organization_id uuid REFERENCES organizations(id);
CREATE INDEX tenants_organization_idx ON tenants(organization_id);

CREATE TABLE departments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  department_type text NOT NULL CHECK (department_type IN (
    'governance','patient-access','outpatient','emergency','inpatient','maternity',
    'pediatrics','critical-care','theatre','laboratory','blood-bank','radiology',
    'pharmacy','renal','mental-health','rehabilitation','nutrition','dental',
    'eye-ent','primary-community','palliative','ipc-quality','cssd','mortuary',
    'housekeeping','portering','engineering','catering','security','finance',
    'hr','procurement','digital-health','other'
  )),
  parent_department_id uuid REFERENCES departments(id),
  description text,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX departments_tenant_type_idx ON departments(tenant_id, department_type, enabled);

CREATE TABLE units (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  unit_type text NOT NULL DEFAULT 'general',
  description text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, department_id, code)
);

CREATE TABLE locations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  location_type text NOT NULL CHECK (location_type IN (
    'ward','room','bed-space','theatre','laboratory-bench','storage','office',
    'reception','vehicle','other'
  )),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','out-of-service')),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, unit_id, code)
);

CREATE TABLE cadres (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  isco08_code text,
  isco08_reviewed boolean NOT NULL DEFAULT false,
  description text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK (isco08_code IS NULL OR length(isco08_code) BETWEEN 1 AND 8)
);

CREATE TABLE job_titles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  cadre_id uuid REFERENCES cadres(id),
  grade text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- Global staff identity. Sensitive employment and health data live in the
-- facility-scoped tables below; this table holds directory detail only.
CREATE TABLE staff_persons (
  id uuid PRIMARY KEY,
  staff_ref text NOT NULL UNIQUE,
  user_id uuid UNIQUE REFERENCES users(id),
  given_name text NOT NULL,
  family_name text NOT NULL,
  preferred_name text,
  professional_display_name text,
  phone text,
  email text,
  preferred_language text NOT NULL DEFAULT 'en',
  photo_upload_id uuid REFERENCES uploads(id),
  identity_verification_method text,
  identity_verified_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_persons_name_idx ON staff_persons(family_name, given_name);

CREATE TABLE engagements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_person_id uuid NOT NULL REFERENCES staff_persons(id),
  employee_number text,
  engagement_type text NOT NULL CHECK (engagement_type IN (
    'employee','contractor','student','intern','trainee','volunteer','locum','visiting-practitioner'
  )),
  employer text,
  start_date date NOT NULL,
  end_date date,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','active','suspended','ended','withdrawn'
  )),
  job_title_id uuid REFERENCES job_titles(id),
  grade text,
  primary_manager_staff_id uuid REFERENCES staff_persons(id),
  work_location text,
  roster_eligible boolean NOT NULL DEFAULT false,
  supervision_required boolean NOT NULL DEFAULT false,
  supervisor_staff_id uuid REFERENCES staff_persons(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (status <> 'active' OR approved_by IS NOT NULL),
  UNIQUE (tenant_id, employee_number)
);
CREATE INDEX engagements_tenant_status_idx ON engagements(tenant_id, status, start_date);
CREATE UNIQUE INDEX engagements_active_person_tenant ON engagements(tenant_id, staff_person_id)
  WHERE status IN ('pending','active','suspended');

CREATE TABLE department_assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id),
  unit_id uuid REFERENCES units(id),
  location_id uuid REFERENCES locations(id),
  is_primary boolean NOT NULL DEFAULT false,
  appointment_title text,
  reporting_manager_staff_id uuid REFERENCES staff_persons(id),
  on_call_eligible boolean NOT NULL DEFAULT false,
  starts_on date NOT NULL,
  ends_on date,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX assignments_tenant_department_idx ON department_assignments(tenant_id, department_id, ends_on);
CREATE UNIQUE INDEX assignments_one_primary ON department_assignments(engagement_id)
  WHERE is_primary AND ends_on IS NULL;

CREATE TABLE privilege_catalog (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN (
    'clinical','prescribing','diagnostic','theatre','maternity','critical-care',
    'pharmacy','mortuary','administrative','technical','other'
  )),
  requires_credential boolean NOT NULL DEFAULT false,
  description text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE privilege_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  privilege_id uuid NOT NULL REFERENCES privilege_catalog(id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested','approved','rejected','revoked','expired'
  )),
  scope text,
  patient_scope text NOT NULL DEFAULT 'facility',
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  decision_reason text,
  effective_from date,
  expires_on date,
  revoked_at timestamptz,
  revocation_reason text,
  CHECK (status <> 'approved' OR (reviewed_by IS NOT NULL AND effective_from IS NOT NULL)),
  CHECK (status <> 'rejected' OR (reviewed_by IS NOT NULL AND decision_reason IS NOT NULL)),
  CHECK (expires_on IS NULL OR effective_from IS NULL OR expires_on >= effective_from)
);
CREATE INDEX privilege_grants_tenant_status_idx ON privilege_grants(tenant_id, status, requested_at);
CREATE UNIQUE INDEX privilege_grants_active ON privilege_grants(engagement_id, privilege_id)
  WHERE status IN ('requested','approved');

CREATE TABLE onboarding_cases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_person_id uuid NOT NULL REFERENCES staff_persons(id),
  engagement_id uuid REFERENCES engagements(id),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN (
    'invited','identity','employment','professional','assignments','credentials',
    'privileges','review','access','induction','active','rejected','withdrawn'
  )),
  current_step integer NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 20),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  assigned_reviewer_id uuid REFERENCES users(id),
  submitted_by uuid REFERENCES users(id),
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  decision_reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX onboarding_tenant_status_idx ON onboarding_cases(tenant_id, status, created_at);

CREATE TABLE training_records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  training_type text NOT NULL,
  completed_on date,
  expires_on date,
  evidence_upload_id uuid REFERENCES uploads(id),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR completed_on IS NULL OR expires_on >= completed_on)
);
CREATE INDEX training_tenant_expiry_idx ON training_records(tenant_id, expires_on);

-- Directory visibility is limited to authenticated facility staff and the
-- staff person themself. Detailed onboarding data is further role restricted.
ALTER TABLE staff_persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_persons FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_persons_directory ON staff_persons USING (
  user_id = app.current_user() OR (app.current_tenant() IS NOT NULL AND app.actor_kind() = 'staff')
) WITH CHECK (
  app.current_tenant() IS NOT NULL AND app.has_any_role(ARRAY['hr','facility_admin'])
);

DO $$
DECLARE t text;
DECLARE tables text[] := ARRAY[
  'organizations','departments','units','locations','cadres','job_titles','engagements',
  'department_assignments','privilege_catalog','privilege_grants','onboarding_cases','training_records'
];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

CREATE POLICY organizations_read ON organizations USING (true)
  WITH CHECK (app.has_any_role(ARRAY['facility_admin']));
GRANT SELECT, INSERT, UPDATE ON organizations TO medveris_runtime;

CREATE POLICY departments_read ON departments USING (
  tenant_id = app.current_tenant() AND (
    app.has_any_role(ARRAY['hr','facility_admin','clinician','nurse','records','theatre','housekeeping','porter','mortuary','cssd','biomedical','quality','it_admin'])
  )
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin'])
);
CREATE POLICY units_read ON units USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin','clinician','nurse','records','theatre','housekeeping','porter','mortuary','cssd','biomedical','quality','it_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin']));
CREATE POLICY locations_read ON locations USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin','clinician','nurse','records','theatre','housekeeping','porter','mortuary','cssd','biomedical','quality','it_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin','housekeeping','porter','biomedical']));
CREATE POLICY cadres_read ON cadres USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin','clinician','nurse','quality'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin']));
CREATE POLICY job_titles_read ON job_titles USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin','clinician','nurse','quality'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin']));

CREATE POLICY engagements_access ON engagements USING (
  tenant_id = app.current_tenant() AND (
    app.has_any_role(ARRAY['hr','facility_admin'])
    OR EXISTS (SELECT 1 FROM staff_persons s WHERE s.id = engagements.staff_person_id AND s.user_id = app.current_user())
  )
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin'])
);

CREATE POLICY assignments_access ON department_assignments USING (
  tenant_id = app.current_tenant() AND (
    app.has_any_role(ARRAY['hr','facility_admin','clinician','nurse','quality'])
    OR EXISTS (
      SELECT 1 FROM engagements e JOIN staff_persons s ON s.id = e.staff_person_id
       WHERE e.id = department_assignments.engagement_id AND s.user_id = app.current_user()
    )
  )
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin']));

CREATE POLICY privilege_catalog_read ON privilege_catalog USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin','clinician','nurse','quality'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','clinician']));

CREATE POLICY privilege_grants_read ON privilege_grants USING (
  tenant_id = app.current_tenant() AND (
    app.has_any_role(ARRAY['hr','facility_admin','clinician','quality','auditor'])
    OR EXISTS (
      SELECT 1 FROM engagements e JOIN staff_persons s ON s.id = e.staff_person_id
       WHERE e.id = privilege_grants.engagement_id AND s.user_id = app.current_user()
    )
  )
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin','clinician'])
);

CREATE POLICY onboarding_access ON onboarding_cases USING (
  tenant_id = app.current_tenant() AND (
    app.has_any_role(ARRAY['hr','facility_admin','clinician'])
    OR EXISTS (
      SELECT 1 FROM staff_persons s WHERE s.id = onboarding_cases.staff_person_id AND s.user_id = app.current_user()
    )
  )
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin']));

CREATE POLICY training_access ON training_records USING (
  tenant_id = app.current_tenant() AND (
    app.has_any_role(ARRAY['hr','facility_admin','clinician','quality'])
    OR EXISTS (
      SELECT 1 FROM engagements e JOIN staff_persons s ON s.id = e.staff_person_id
       WHERE e.id = training_records.engagement_id AND s.user_id = app.current_user()
    )
  )
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin']));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  departments, units, locations, cadres, job_titles, staff_persons, engagements,
  department_assignments, privilege_catalog, privilege_grants, onboarding_cases, training_records
TO medveris_runtime;

COMMIT;
