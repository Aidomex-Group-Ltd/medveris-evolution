-- Versioned document/template registry used by departmental documentation,
-- consultation notes and operational forms. Signed versions are immutable;
-- draft edits create new version rows so every revision remains auditable.

BEGIN;

CREATE TABLE document_templates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_key text NOT NULL,
  name text NOT NULL,
  description text,
  department_id uuid REFERENCES departments(id),
  context text NOT NULL DEFAULT 'clinical' CHECK (context IN (
    'clinical','nursing','maternity','theatre','diagnostic','pharmacy','administrative',
    'operational','hr','mortuary','housekeeping','portering','technical'
  )),
  purpose text,
  sensitivity text NOT NULL DEFAULT 'standard' CHECK (sensitivity IN (
    'standard','sensitive','restricted'
  )),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, template_key)
);
CREATE INDEX templates_tenant_status_idx ON document_templates(tenant_id, status, context);

CREATE TABLE document_template_versions (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  fields jsonb NOT NULL,
  author_roles text[] NOT NULL DEFAULT ARRAY['clinician','nurse']::text[],
  reviewer_roles text[] NOT NULL DEFAULT ARRAY['clinician']::text[],
  signing_required boolean NOT NULL DEFAULT true,
  countersign_required boolean NOT NULL DEFAULT false,
  amendment_rules text,
  retention_class text NOT NULL DEFAULT 'clinical-standard',
  effective_from date,
  effective_to date,
  published_at timestamptz,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  CHECK (published_at IS NULL OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX template_versions_template_idx ON document_template_versions(template_id, version);

CREATE TABLE documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES document_templates(id),
  template_version_id uuid NOT NULL REFERENCES document_template_versions(id),
  department_id uuid REFERENCES departments(id),
  unit_id uuid REFERENCES units(id),
  subject_type text NOT NULL DEFAULT 'patient' CHECK (subject_type IN ('patient','staff','operational')),
  patient_id uuid REFERENCES patients(id),
  encounter_id uuid REFERENCES encounters(id),
  staff_subject_id uuid REFERENCES staff_persons(id),
  title text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed','amended','entered-in-error')),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  author_user_id uuid NOT NULL REFERENCES users(id),
  sensitivity text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (subject_type <> 'patient' OR patient_id IS NOT NULL),
  CHECK (subject_type <> 'staff' OR staff_subject_id IS NOT NULL),
  CHECK (subject_type <> 'operational' OR (patient_id IS NULL AND staff_subject_id IS NULL))
);
CREATE INDEX documents_tenant_status_idx ON documents(tenant_id, status, recorded_at);
CREATE INDEX documents_patient_idx ON documents(patient_id, occurred_at);
CREATE INDEX documents_department_idx ON documents(tenant_id, department_id, recorded_at);

CREATE TABLE document_versions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  previous_version_id uuid REFERENCES document_versions(id),
  status text NOT NULL CHECK (status IN ('draft','signed','amended','entered-in-error')),
  content jsonb NOT NULL,
  content_digest text NOT NULL,
  change_note text NOT NULL CHECK (length(change_note) >= 5),
  author_user_id uuid NOT NULL REFERENCES users(id),
  signed_at timestamptz,
  signature text,
  signature_key_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version),
  CHECK (version = 1 AND previous_version_id IS NULL OR version > 1 AND previous_version_id IS NOT NULL),
  CHECK (status = 'draft' OR signed_at IS NOT NULL)
);
CREATE INDEX document_versions_tenant_idx ON document_versions(tenant_id, created_at);

CREATE OR REPLACE FUNCTION app.reject_document_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_document_version' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER document_versions_immutable BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_document_version_mutation();

ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE document_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_template_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY templates_read ON document_templates USING (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'staff'
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin','hr','quality'])
);
CREATE POLICY template_versions_read ON document_template_versions USING (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'staff'
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin','hr','quality'])
);

CREATE POLICY documents_access ON documents USING (
  tenant_id = app.current_tenant() AND (
    (subject_type = 'patient' AND app.has_any_role(ARRAY['clinician','nurse','records','facility_admin','laboratory','radiology','theatre']))
    OR (subject_type = 'staff' AND (app.has_any_role(ARRAY['hr','facility_admin']) OR staff_subject_id IN (
      SELECT s.id FROM staff_persons s WHERE s.user_id = app.current_user()
    )))
    OR (subject_type = 'operational' AND app.has_any_role(ARRAY[
      'clinician','nurse','facility_admin','hr','records','theatre','housekeeping','porter',
      'mortuary','cssd','biomedical','quality','finance','it_admin'
    ]))
  )
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'staff' AND app.has_any_role(ARRAY[
    'clinician','nurse','facility_admin','hr','records','theatre','housekeeping','porter',
    'mortuary','cssd','biomedical','quality','finance','it_admin'
  ])
);

CREATE POLICY document_versions_access ON document_versions USING (
  tenant_id = app.current_tenant() AND EXISTS (
    SELECT 1 FROM documents d WHERE d.id = document_versions.document_id AND d.tenant_id = app.current_tenant()
  )
) WITH CHECK (
  tenant_id = app.current_tenant() AND EXISTS (
    SELECT 1 FROM documents d WHERE d.id = document_versions.document_id AND d.tenant_id = app.current_tenant()
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  document_templates, document_template_versions, documents, document_versions
TO medveris_runtime;
REVOKE UPDATE, DELETE ON document_versions FROM medveris_runtime;

-- Diagnostic reporting workspace metadata.
ALTER TABLE service_orders
  ADD COLUMN assigned_reporter_id uuid REFERENCES users(id),
  ADD COLUMN reported_at timestamptz;
ALTER TABLE lab_results
  ADD COLUMN reported_at timestamptz,
  ADD COLUMN release_note text;
ALTER TABLE diagnostic_reports
  ADD COLUMN reported_at timestamptz,
  ADD COLUMN release_note text;
ALTER TABLE critical_communications
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN acknowledged_by uuid REFERENCES users(id),
  ADD COLUMN acknowledgement_note text;

CREATE INDEX service_orders_reporter_idx ON service_orders(tenant_id, assigned_reporter_id, status);

COMMIT;
