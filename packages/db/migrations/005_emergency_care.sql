-- Emergency care board. Emergency clinical documentation reuses the signed
-- encounter, triage and observation records; this migration adds the arrival,
-- handoff and disposition metadata needed for the emergency workflow.

BEGIN;

CREATE TABLE emergency_cases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  encounter_id uuid NOT NULL UNIQUE REFERENCES encounters(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  arrival_mode text NOT NULL DEFAULT 'walk-in'
    CHECK (arrival_mode IN ('walk-in','ambulance','referral','police','other')),
  location text,
  assigned_user_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  disposition text CHECK (disposition IN ('admitted','discharged','transferred','deceased','left-without-seen','cancelled')),
  disposition_note text,
  closed_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'closed' OR (disposition IS NOT NULL AND disposition_note IS NOT NULL AND closed_at IS NOT NULL))
);
CREATE INDEX emergency_cases_active_idx ON emergency_cases(tenant_id, status, created_at);
CREATE INDEX emergency_cases_patient_idx ON emergency_cases(patient_id, created_at);

CREATE TABLE emergency_handoffs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES emergency_cases(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES users(id),
  to_user_id uuid NOT NULL REFERENCES users(id),
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX emergency_handoffs_case_idx ON emergency_handoffs(case_id, created_at);

ALTER TABLE emergency_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE emergency_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_handoffs FORCE ROW LEVEL SECURITY;

CREATE POLICY emergency_cases_tenant ON emergency_cases USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
);
CREATE POLICY emergency_handoffs_tenant ON emergency_handoffs USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
);

GRANT SELECT, INSERT, UPDATE, DELETE ON emergency_cases, emergency_handoffs TO medveris_runtime;

COMMIT;
