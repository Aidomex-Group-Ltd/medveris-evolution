-- Structured radiology reporting.
--
-- Templates are facility copies of the versioned catalogue in @medveris/domain and
-- can be used only after a radiologist approves them. A report is a structured
-- draft until a radiologist signs it; each signature appends an immutable
-- version with a content hash, so a signed report is never overwritten.
-- Corrections append a new signed version with a reason and addenda append
-- text; both keep the original. Critical findings record who was told, how,
-- and when it was acknowledged or escalated. No image data is stored: PACS is
-- unavailable and studies carry metadata only. Additive only.

BEGIN;

ALTER TABLE imaging_studies
  ADD COLUMN acquisition_status text NOT NULL DEFAULT 'registered'
    CHECK (acquisition_status IN ('scheduled', 'registered', 'acquired', 'incomplete', 'cancelled')),
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN acquired_at timestamptz,
  ADD COLUMN protocol text,
  ADD COLUMN preparation_notes text,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX imaging_studies_accession ON imaging_studies(tenant_id, accession) WHERE accession IS NOT NULL;

CREATE TABLE radiology_templates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  catalogue_version integer NOT NULL CHECK (catalogue_version > 0),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  modality text NOT NULL,
  body_region text NOT NULL,
  definition jsonb NOT NULL,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'retired')),
  approved_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  approval_note text NOT NULL,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, version)
);
CREATE UNIQUE INDEX radiology_templates_one_approved ON radiology_templates(tenant_id, code) WHERE status = 'approved';

CREATE TABLE radiology_reports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  order_id uuid NOT NULL REFERENCES service_orders(id),
  order_item_id uuid NOT NULL REFERENCES service_order_items(id),
  study_id uuid NOT NULL REFERENCES imaging_studies(id),
  template_id uuid NOT NULL REFERENCES radiology_templates(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'preliminary', 'final', 'corrected', 'cancelled')),
  urgency text NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine', 'urgent', 'critical')),
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  draft_version integer NOT NULL DEFAULT 1 CHECK (draft_version > 0),
  signed_version integer NOT NULL DEFAULT 0 CHECK (signed_version >= 0),
  reporting_radiologist_id uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  last_edited_by uuid NOT NULL REFERENCES users(id),
  preliminary_at timestamptz,
  signed_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('draft', 'cancelled') OR reporting_radiologist_id IS NOT NULL),
  CHECK (status NOT IN ('final', 'corrected') OR (signed_at IS NOT NULL AND signed_version > 0))
);
CREATE UNIQUE INDEX radiology_reports_one_per_study ON radiology_reports(study_id) WHERE status <> 'cancelled';
CREATE INDEX radiology_reports_worklist_idx ON radiology_reports(tenant_id, status, created_at);

CREATE TABLE radiology_report_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES radiology_reports(id),
  version integer NOT NULL CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('preliminary', 'final', 'correction')),
  template_id uuid NOT NULL REFERENCES radiology_templates(id),
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  urgency text NOT NULL,
  change_reason text,
  signed_by uuid NOT NULL REFERENCES users(id),
  signed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, version),
  CHECK (kind <> 'correction' OR change_reason IS NOT NULL)
);

CREATE TABLE radiology_report_addenda (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES radiology_reports(id),
  applies_to_version integer NOT NULL CHECK (applies_to_version > 0),
  text text NOT NULL,
  reason text NOT NULL,
  content_hash text NOT NULL,
  signed_by uuid NOT NULL REFERENCES users(id),
  signed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE radiology_critical_communications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES radiology_reports(id),
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  method text NOT NULL CHECK (method IN ('phone', 'in-person', 'secure-message')),
  finding_summary text NOT NULL,
  communicated_by uuid NOT NULL REFERENCES users(id),
  communicated_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id),
  acknowledgement_note text,
  escalated_at timestamptz,
  escalated_to uuid REFERENCES users(id),
  escalated_by uuid REFERENCES users(id),
  escalation_note text,
  CHECK (acknowledged_at IS NULL OR acknowledged_by IS NOT NULL),
  CHECK (escalated_at IS NULL OR (escalated_to IS NOT NULL AND escalated_by IS NOT NULL))
);
CREATE INDEX radiology_critical_open_idx ON radiology_critical_communications(tenant_id, acknowledged_at, communicated_at);

CREATE TRIGGER radiology_report_versions_immutable BEFORE UPDATE OR DELETE ON radiology_report_versions
FOR EACH ROW EXECUTE FUNCTION app.reject_append_only_mutation();
CREATE TRIGGER radiology_report_addenda_immutable BEFORE UPDATE OR DELETE ON radiology_report_addenda
FOR EACH ROW EXECUTE FUNCTION app.reject_append_only_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['radiology_templates', 'radiology_reports', 'radiology_report_versions',
                           'radiology_report_addenda', 'radiology_critical_communications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Specialised roles (radiographer, radiologist) reach these policies through the
-- implied `radiology` role added when the session loads.
CREATE POLICY radiology_templates_tenant ON radiology_templates USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician', 'nurse', 'radiology', 'facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['radiology']));
CREATE POLICY radiology_reports_tenant ON radiology_reports USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician', 'nurse', 'radiology'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['radiology']));
CREATE POLICY radiology_report_versions_tenant ON radiology_report_versions USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician', 'nurse', 'radiology'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['radiology']));
CREATE POLICY radiology_report_addenda_tenant ON radiology_report_addenda USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician', 'nurse', 'radiology'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['radiology']));
CREATE POLICY radiology_critical_tenant ON radiology_critical_communications USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician', 'nurse', 'radiology'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician', 'nurse', 'radiology']));

GRANT SELECT, INSERT, UPDATE ON radiology_templates, radiology_reports, radiology_critical_communications TO medveris_runtime;
GRANT SELECT, INSERT ON radiology_report_versions, radiology_report_addenda TO medveris_runtime;

COMMIT;
