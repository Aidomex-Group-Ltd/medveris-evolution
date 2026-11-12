-- Patient record access privacy (Phase 11.2). Additive only: no existing column/constraint changed.
-- Adds: restriction fields on clinical_entries (default unrestricted), and the tenant-scoped
-- consent_grants table for patient-authorized provider-to-provider sharing.
-- Raw consent tokens are never stored; only a SHA-256 hash is kept, enabling single-use
-- redemption and fast revocation. Patient data never leaves Medveris to ERPNext.

BEGIN;

ALTER TABLE clinical_entries ADD COLUMN IF NOT EXISTS restricted_access boolean NOT NULL DEFAULT false;
ALTER TABLE clinical_entries ADD COLUMN IF NOT EXISTS restricted_reason_code text;
ALTER TABLE clinical_entries ADD CONSTRAINT clinical_entries_restricted_reason_chk
  CHECK (
    (restricted_access = false AND restricted_reason_code IS NULL)
    OR (restricted_access = true AND restricted_reason_code IN (
      'third_party_confidentiality',
      'therapeutic_privilege',
      'psychotherapy_process_notes',
      'peer_review_qa',
      'litigation_prep',
      'unverified_draft'
    ))
  );

CREATE TABLE IF NOT EXISTS consent_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  granted_to_tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  granted_to_user_id uuid REFERENCES users(id),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  purpose text,
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  token_hash char(64) NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_grants_patient_idx ON consent_grants(tenant_id, patient_id, expires_at);
CREATE INDEX consent_grants_token_idx ON consent_grants(token_hash) WHERE revoked_at IS NULL;

ALTER TABLE clinical_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_entries FORCE ROW LEVEL SECURITY;
-- Existing tenant policy is untouched; the restriction fields are enforced at the service layer
-- (redaction of restricted notes is applied on patient-facing reads), not by widening RLS.

ALTER TABLE consent_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consent_grants_access ON consent_grants;
CREATE POLICY consent_grants_access ON consent_grants USING (
  tenant_id = app.current_tenant()
  AND (
    app.has_any_role(ARRAY['facility_admin','records','privacy_officer'])
    OR app.current_patient() = patient_id
  )
) WITH CHECK (
  tenant_id = app.current_tenant()
  AND (
    app.has_any_role(ARRAY['facility_admin','records','privacy_officer'])
    OR app.current_patient() = patient_id
  )
);

GRANT SELECT, INSERT, UPDATE ON consent_grants TO medveris_runtime;

COMMIT;
