-- Scope duplicate review to the facility that registered the patient. The
-- original table was staff-readable without a tenant predicate, which exposed
-- candidate identities across facilities. Existing candidates inherit the
-- primary patient's first facility link; candidates with no facility link are
-- removed because they cannot be reviewed under a tenant context.

BEGIN;

ALTER TABLE patient_duplicate_candidates
  ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;

UPDATE patient_duplicate_candidates d
   SET tenant_id = scoped.tenant_id
  FROM (
    SELECT DISTINCT ON (candidate.id) candidate.id, link.tenant_id
      FROM patient_duplicate_candidates candidate
      JOIN tenant_patient_links link ON link.patient_id = candidate.primary_patient_id
     ORDER BY candidate.id, link.created_at, link.tenant_id
  ) scoped
 WHERE d.id = scoped.id;

UPDATE patient_duplicate_candidates d
   SET tenant_id = scoped.tenant_id
  FROM (
    SELECT DISTINCT ON (candidate.id) candidate.id, link.tenant_id
      FROM patient_duplicate_candidates candidate
      JOIN tenant_patient_links link ON link.patient_id = candidate.candidate_patient_id
     WHERE candidate.tenant_id IS NULL
     ORDER BY candidate.id, link.created_at, link.tenant_id
  ) scoped
 WHERE d.id = scoped.id AND d.tenant_id IS NULL;

DELETE FROM patient_duplicate_candidates WHERE tenant_id IS NULL;

ALTER TABLE patient_duplicate_candidates ALTER COLUMN tenant_id SET NOT NULL;

DROP POLICY duplicates_staff ON patient_duplicate_candidates;
CREATE POLICY duplicates_tenant ON patient_duplicate_candidates
  USING (tenant_id = app.current_tenant() AND app.actor_kind() = 'staff')
  WITH CHECK (tenant_id = app.current_tenant() AND app.actor_kind() = 'staff');

CREATE INDEX duplicate_candidates_tenant_status_idx
  ON patient_duplicate_candidates(tenant_id, status, created_at);

COMMIT;
