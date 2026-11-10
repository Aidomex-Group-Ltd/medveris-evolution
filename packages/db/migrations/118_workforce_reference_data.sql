-- Workforce reference data: global canonical tables, facility extensions and staff payroll/qualification records.
-- Recovered migration so fresh environments reproduce the live schema.

BEGIN;

CREATE OR REPLACE FUNCTION public.reference_data_version_increment()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.version := COALESCE((SELECT version FROM reference_data_changelog
    WHERE table_name = TG_TABLE_NAME AND record_id = NEW.id ORDER BY changed_at DESC LIMIT 1), 0) + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE TABLE IF NOT EXISTS reference_cadres (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  regulator_codes TEXT[] NOT NULL DEFAULT '{}',
  requires_registration BOOLEAN NOT NULL DEFAULT false,
  isco08_code TEXT CHECK (isco08_code IS NULL OR (length(isco08_code) >= 1 AND length(isco08_code) <= 8)),
  isco08_reviewed BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_job_titles (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  cadre_code TEXT NOT NULL REFERENCES reference_cadres(code),
  seniority TEXT NOT NULL CHECK (seniority = ANY (ARRAY['entry'::text, 'standard'::text, 'senior'::text, 'lead'::text, 'consultant'::text])),
  description TEXT,
  department_codes TEXT[] NOT NULL DEFAULT '{}',
  requires_credential BOOLEAN NOT NULL DEFAULT false,
  privilege_codes TEXT[] NOT NULL DEFAULT '{}',
  suggested_system_roles TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_specialties (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  cadre_codes TEXT[] NOT NULL DEFAULT '{}',
  department_codes TEXT[] NOT NULL DEFAULT '{}',
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_departments (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_regulators (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  regulator_type TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'UG',
  verification_mode TEXT NOT NULL CHECK (verification_mode = ANY (ARRAY['manual'::text, 'official-api'::text])),
  website TEXT,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_capabilities (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category = ANY (ARRAY['vital-signs'::text, 'triage'::text, 'clinical-history'::text, 'physical-examination'::text, 'diagnosis'::text, 'differential-diagnosis'::text, 'lab-ordering'::text, 'imaging-ordering'::text, 'lab-validation'::text, 'imaging-interpretation'::text, 'prescribing'::text, 'dispensing'::text, 'medication-admin'::text, 'clinical-procedures'::text, 'suturing'::text, 'wound-care'::text, 'vaccination'::text, 'antenatal-care'::text, 'delivery-maternity'::text, 'neonatal-resuscitation'::text, 'anaesthesia'::text, 'sedation'::text, 'surgery'::text, 'dental-procedures'::text, 'ophthalmic-procedures'::text, 'mental-health-assessment'::text, 'counselling'::text, 'psychotherapy'::text, 'physiotherapy'::text, 'occupational-therapy'::text, 'speech-therapy'::text, 'clinical-referrals'::text, 'discharge-authorization'::text, 'clinical-note-signing'::text, 'clinical-note-amendment'::text, 'other'::text])),
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_payroll_grades (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  grade_level INTEGER NOT NULL,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_data_changelog (
  id UUID PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id UUID NOT NULL,
  record_code TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = ANY (ARRAY['create'::text, 'update'::text, 'retire'::text, 'reactivate'::text])),
  previous_value JSONB,
  new_value JSONB,
  changed_by UUID NOT NULL REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS facility_reference_extensions (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reference_table TEXT NOT NULL CHECK (reference_table = ANY (ARRAY['cadre'::text, 'job_title'::text, 'specialty'::text, 'department'::text, 'capability'::text])),
  reference_code TEXT NOT NULL,
  extension_type TEXT NOT NULL CHECK (extension_type = ANY (ARRAY['local-cadre'::text, 'local-specialty'::text, 'local-department'::text, 'local-title'::text, 'local-capability'::text])),
  name TEXT NOT NULL,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference_table, reference_code)
);

CREATE TABLE IF NOT EXISTS facility_payroll_grades (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  grade_code TEXT NOT NULL REFERENCES reference_payroll_grades(code),
  facility_salary_scale TEXT NOT NULL,
  basic_salary NUMERIC(18,2) NOT NULL CHECK (basic_salary >= 0),
  currency TEXT NOT NULL DEFAULT 'UGX' CHECK (length(currency) = 3),
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (tenant_id, grade_code, facility_salary_scale, effective_from)
);

CREATE TABLE IF NOT EXISTS staff_payroll_assignments (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  engagement_id UUID NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  payroll_grade_id UUID NOT NULL REFERENCES facility_payroll_grades(id),
  salary_step INTEGER NOT NULL DEFAULT 1 CHECK (salary_step >= 1),
  basic_salary NUMERIC(18,2) NOT NULL CHECK (basic_salary >= 0),
  professional_allowance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (professional_allowance >= 0),
  responsibility_allowance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (responsibility_allowance >= 0),
  housing_allowance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (housing_allowance >= 0),
  transport_allowance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (transport_allowance >= 0),
  shift_allowance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (shift_allowance >= 0),
  on_call_allowance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (on_call_allowance >= 0),
  overtime_rate NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (overtime_rate >= 0),
  hardship_allowance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (hardship_allowance >= 0),
  risk_allowance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (risk_allowance >= 0),
  payment_frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (payment_frequency = ANY (ARRAY['weekly'::text, 'fortnightly'::text, 'monthly'::text, 'annual'::text])),
  statutory_deductions JSONB DEFAULT '{}',
  authorized_deductions JSONB DEFAULT '{}',
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (tenant_id, engagement_id, effective_from)
);

CREATE TABLE IF NOT EXISTS staff_qualifications (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_person_id UUID NOT NULL REFERENCES staff_persons(id) ON DELETE CASCADE,
  qualification_type TEXT NOT NULL CHECK (qualification_type = ANY (ARRAY['degree'::text, 'diploma'::text, 'certificate'::text, 'licence'::text, 'registration'::text, 'specialization'::text, 'other'::text])),
  name TEXT NOT NULL,
  awarding_institution TEXT NOT NULL,
  country_of_qualification TEXT NOT NULL DEFAULT 'Uganda',
  graduation_year INTEGER CHECK (graduation_year >= 1900 AND graduation_year <= EXTRACT(year FROM now()) + 5),
  registration_body TEXT,
  registration_number TEXT,
  licence_number TEXT,
  licence_issue_date DATE,
  licence_expiry_date DATE,
  credential_status TEXT NOT NULL DEFAULT 'not-provided' CHECK (credential_status = ANY (ARRAY['not-provided'::text, 'pending-verification'::text, 'verified-active'::text, 'expired'::text, 'suspended'::text, 'restricted'::text, 'rejected'::text, 'not-applicable'::text])),
  evidence_upload_id UUID REFERENCES uploads(id),
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  verification_notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (licence_expiry_date IS NULL OR licence_expiry_date >= licence_issue_date)
);

CREATE INDEX IF NOT EXISTS reference_cadres_active_idx ON reference_cadres(active);
CREATE INDEX IF NOT EXISTS reference_cadres_category_idx ON reference_cadres(category, active);
CREATE INDEX IF NOT EXISTS reference_capabilities_active_idx ON reference_capabilities(active);
CREATE INDEX IF NOT EXISTS reference_capabilities_category_idx ON reference_capabilities(category, active);
CREATE INDEX IF NOT EXISTS reference_changelog_changed_at_idx ON reference_data_changelog(changed_at DESC);
CREATE INDEX IF NOT EXISTS reference_changelog_table_idx ON reference_data_changelog(table_name, record_code);
CREATE INDEX IF NOT EXISTS reference_departments_sort_idx ON reference_departments(sort_order, active);
CREATE INDEX IF NOT EXISTS reference_job_titles_active_idx ON reference_job_titles(active);
CREATE INDEX IF NOT EXISTS reference_job_titles_cadre_idx ON reference_job_titles(cadre_code, active);
CREATE INDEX IF NOT EXISTS reference_payroll_grades_active_idx ON reference_payroll_grades(active);
CREATE INDEX IF NOT EXISTS reference_regulators_active_idx ON reference_regulators(active);
CREATE INDEX IF NOT EXISTS reference_specialties_active_idx ON reference_specialties(active);
CREATE INDEX IF NOT EXISTS facility_payroll_grades_tenant_idx ON facility_payroll_grades(tenant_id, grade_code);
CREATE INDEX IF NOT EXISTS facility_ref_ext_tenant_idx ON facility_reference_extensions(tenant_id, reference_table, active);
CREATE INDEX IF NOT EXISTS staff_payroll_assignments_engagement_idx ON staff_payroll_assignments(tenant_id, engagement_id);
CREATE INDEX IF NOT EXISTS staff_qualifications_staff_idx ON staff_qualifications(staff_person_id);
CREATE INDEX IF NOT EXISTS staff_qualifications_status_idx ON staff_qualifications(credential_status);

ALTER TABLE reference_cadres ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_job_titles ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_specialties ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_regulators ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_payroll_grades ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_data_changelog ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_reference_extensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_payroll_grades ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_payroll_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_qualifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reference_cadres_read ON reference_cadres;
CREATE POLICY reference_cadres_read ON reference_cadres FOR SELECT USING (true);
DROP POLICY IF EXISTS reference_cadres_write ON reference_cadres;
CREATE POLICY reference_cadres_write ON reference_cadres USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());

DROP POLICY IF EXISTS reference_job_titles_read ON reference_job_titles;
CREATE POLICY reference_job_titles_read ON reference_job_titles FOR SELECT USING (true);
DROP POLICY IF EXISTS reference_job_titles_write ON reference_job_titles;
CREATE POLICY reference_job_titles_write ON reference_job_titles USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());

DROP POLICY IF EXISTS reference_specialties_read ON reference_specialties;
CREATE POLICY reference_specialties_read ON reference_specialties FOR SELECT USING ((active OR true));
DROP POLICY IF EXISTS reference_specialties_write ON reference_specialties;
CREATE POLICY reference_specialties_write ON reference_specialties USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());

DROP POLICY IF EXISTS reference_departments_read ON reference_departments;
CREATE POLICY reference_departments_read ON reference_departments FOR SELECT USING (true);
DROP POLICY IF EXISTS reference_departments_write ON reference_departments;
CREATE POLICY reference_departments_write ON reference_departments USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());

DROP POLICY IF EXISTS reference_regulators_read ON reference_regulators;
CREATE POLICY reference_regulators_read ON reference_regulators FOR SELECT USING (true);
DROP POLICY IF EXISTS reference_regulators_write ON reference_regulators;
CREATE POLICY reference_regulators_write ON reference_regulators USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());

DROP POLICY IF EXISTS reference_capabilities_read ON reference_capabilities;
CREATE POLICY reference_capabilities_read ON reference_capabilities FOR SELECT USING (true);
DROP POLICY IF EXISTS reference_capabilities_write ON reference_capabilities;
CREATE POLICY reference_capabilities_write ON reference_capabilities USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());

DROP POLICY IF EXISTS reference_payroll_grades_read ON reference_payroll_grades;
CREATE POLICY reference_payroll_grades_read ON reference_payroll_grades FOR SELECT USING (active);
DROP POLICY IF EXISTS reference_payroll_grades_write ON reference_payroll_grades;
CREATE POLICY reference_payroll_grades_write ON reference_payroll_grades USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());

DROP POLICY IF EXISTS reference_changelog_read ON reference_data_changelog;
CREATE POLICY reference_changelog_read ON reference_data_changelog FOR SELECT USING ((app.is_platform_operator() OR app.has_any_role(ARRAY['auditor'::text])));
DROP POLICY IF EXISTS reference_changelog_write ON reference_data_changelog;
CREATE POLICY reference_changelog_write ON reference_data_changelog FOR INSERT WITH CHECK (app.is_platform_operator());

DROP POLICY IF EXISTS facility_ref_ext_read ON facility_reference_extensions;
CREATE POLICY facility_ref_ext_read ON facility_reference_extensions FOR SELECT USING ((tenant_id = app.current_tenant()));
DROP POLICY IF EXISTS facility_ref_ext_write ON facility_reference_extensions;
CREATE POLICY facility_ref_ext_write ON facility_reference_extensions USING (((tenant_id = app.current_tenant()) AND app.has_any_role(ARRAY['facility_admin'::text, 'hr'::text])));

DROP POLICY IF EXISTS facility_payroll_grades_read ON facility_payroll_grades;
CREATE POLICY facility_payroll_grades_read ON facility_payroll_grades FOR SELECT USING (((tenant_id = app.current_tenant()) AND app.has_any_role(ARRAY['finance'::text, 'hr'::text, 'facility_admin'::text])));
DROP POLICY IF EXISTS facility_payroll_grades_write ON facility_payroll_grades;
CREATE POLICY facility_payroll_grades_write ON facility_payroll_grades USING (((tenant_id = app.current_tenant()) AND app.has_any_role(ARRAY['facility_admin'::text, 'hr'::text])));

DROP POLICY IF EXISTS staff_payroll_read ON staff_payroll_assignments;
CREATE POLICY staff_payroll_read ON staff_payroll_assignments FOR SELECT USING (((tenant_id = app.current_tenant()) AND app.has_any_role(ARRAY['finance'::text, 'hr'::text, 'facility_admin'::text])));
DROP POLICY IF EXISTS staff_payroll_write ON staff_payroll_assignments;
CREATE POLICY staff_payroll_write ON staff_payroll_assignments USING (((tenant_id = app.current_tenant()) AND app.has_any_role(ARRAY['facility_admin'::text, 'hr'::text])));

DROP POLICY IF EXISTS staff_qualifications_read ON staff_qualifications;
CREATE POLICY staff_qualifications_read ON staff_qualifications FOR SELECT USING (((tenant_id = app.current_tenant()) AND (app.has_any_role(ARRAY['hr'::text, 'credentialing'::text, 'facility_admin'::text]) OR (staff_person_id IN (SELECT s.id FROM staff_persons s WHERE (s.user_id = app."current_user"()))))));
DROP POLICY IF EXISTS staff_qualifications_write ON staff_qualifications;
CREATE POLICY staff_qualifications_write ON staff_qualifications USING (((tenant_id = app.current_tenant()) AND app.has_any_role(ARRAY['hr'::text, 'credentialing'::text, 'facility_admin'::text])));

DROP TRIGGER IF EXISTS reference_cadres_version ON reference_cadres;
CREATE TRIGGER reference_cadres_version BEFORE UPDATE ON reference_cadres FOR EACH ROW EXECUTE FUNCTION reference_data_version_increment();
DROP TRIGGER IF EXISTS reference_capabilities_version ON reference_capabilities;
CREATE TRIGGER reference_capabilities_version BEFORE UPDATE ON reference_capabilities FOR EACH ROW EXECUTE FUNCTION reference_data_version_increment();
DROP TRIGGER IF EXISTS reference_departments_version ON reference_departments;
CREATE TRIGGER reference_departments_version BEFORE UPDATE ON reference_departments FOR EACH ROW EXECUTE FUNCTION reference_data_version_increment();
DROP TRIGGER IF EXISTS reference_job_titles_version ON reference_job_titles;
CREATE TRIGGER reference_job_titles_version BEFORE UPDATE ON reference_job_titles FOR EACH ROW EXECUTE FUNCTION reference_data_version_increment();
DROP TRIGGER IF EXISTS reference_payroll_grades_version ON reference_payroll_grades;
CREATE TRIGGER reference_payroll_grades_version BEFORE UPDATE ON reference_payroll_grades FOR EACH ROW EXECUTE FUNCTION reference_data_version_increment();
DROP TRIGGER IF EXISTS reference_regulators_version ON reference_regulators;
CREATE TRIGGER reference_regulators_version BEFORE UPDATE ON reference_regulators FOR EACH ROW EXECUTE FUNCTION reference_data_version_increment();
DROP TRIGGER IF EXISTS reference_specialties_version ON reference_specialties;
CREATE TRIGGER reference_specialties_version BEFORE UPDATE ON reference_specialties FOR EACH ROW EXECUTE FUNCTION reference_data_version_increment();

ALTER TABLE reference_cadres FORCE ROW LEVEL SECURITY;
ALTER TABLE reference_job_titles FORCE ROW LEVEL SECURITY;
ALTER TABLE reference_specialties FORCE ROW LEVEL SECURITY;
ALTER TABLE reference_departments FORCE ROW LEVEL SECURITY;
ALTER TABLE reference_regulators FORCE ROW LEVEL SECURITY;
ALTER TABLE reference_capabilities FORCE ROW LEVEL SECURITY;
ALTER TABLE reference_payroll_grades FORCE ROW LEVEL SECURITY;
ALTER TABLE reference_data_changelog FORCE ROW LEVEL SECURITY;
ALTER TABLE facility_reference_extensions FORCE ROW LEVEL SECURITY;
ALTER TABLE facility_payroll_grades FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_payroll_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_qualifications FORCE ROW LEVEL SECURITY;

COMMIT;
