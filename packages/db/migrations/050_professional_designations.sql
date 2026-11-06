-- Professional designation snapshots for signed clinical documents.
--
-- Signed clinical records must preserve provider identity, professional title
-- and relevant speciality at signing time. A provider may later change their
-- title or speciality, but historical signed documents must not be rewritten.
-- This migration adds an immutable snapshot table and stores the designation
-- in a dedicated column on clinical_entry_versions so the signed record keeps
-- the title and speciality it carried when it was signed.
--
-- Safety analysis:
--   - Immutable snapshot: once a designation row links to a signed version it is
--     never updated, only a new row is added on the next amendment.
--   - Tenant scoped: one row per tenant so a cross-tenant designation cannot
--     masquerade as another tenant's provider.
--   - RLS: tenant-scoped policies only; the snapshot is readable by the same
--     actor group that reads the clinical record it belongs to.
--   - Backward compatible: the new column on clinical_entry_versions is nullable;
--     existing signed records do not require rewriting.

BEGIN;

CREATE TABLE professional_designations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  practitioner_staff_person_id uuid NOT NULL REFERENCES staff_persons(id) ON DELETE CASCADE,
  practitioner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encounter_id uuid NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  version integer NOT NULL,
  designation_code text NOT NULL,
  designation_name text NOT NULL,
  category text NOT NULL,
  specialty_codes text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, encounter_id, version)
);

COMMENT ON TABLE professional_designations IS 'Immutable snapshot of a practitioner''s professional title and speciality at the time a clinical document was signed.';

CREATE INDEX professional_designations_encounter_idx
  ON professional_designations (tenant_id, encounter_id, version);

CREATE INDEX professional_designations_staff_idx
  ON professional_designations (practitioner_staff_person_id);

-- Persist the designation alongside the signed version.
ALTER TABLE clinical_entry_versions
  ADD COLUMN designation_code text;

COMMENT ON COLUMN clinical_entry_versions.designation_code IS 'Professional designation code at signing time. Mirrors the value in professional_designations for audit and historical consistency.';

-- RLS for the new snapshot table.
ALTER TABLE professional_designations ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_designations FORCE ROW LEVEL SECURITY;

CREATE POLICY professional_designations_tenant_isolation
  ON professional_designations
  FOR ALL
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

CREATE POLICY professional_designations_system_access
  ON professional_designations
  FOR ALL
  USING (app.actor_kind() = 'system')
  WITH CHECK (app.actor_kind() = 'system');

CREATE POLICY professional_designations_clinical_read
  ON professional_designations
  FOR SELECT
  USING (
    tenant_id = app.current_tenant()
    AND
    (
      app.has_any_role(ARRAY['clinician', 'specialist_clinician', 'nurse', 'nursing'])
      OR
      app.is_platform_operator()
    )
  );

COMMIT;
