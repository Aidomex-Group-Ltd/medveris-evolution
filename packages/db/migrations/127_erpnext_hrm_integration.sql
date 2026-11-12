-- ERPNext/Frappe HRMS integration — additive schema (Medveris side only).
-- Local mapping records: which Medveris tenant maps to which ERPNext Company, and which
-- staff person maps to which ERPNext Employee. No patient data. No secrets stored here.
-- Secrets live in ERPNEXT_API_KEY / ERPNEXT_API_SECRET env vars, never in the database.

BEGIN;

CREATE TABLE integration_erpnext_connection (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  company_name text,
  branch_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

CREATE TABLE staff_erpnext_link (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_person_id uuid NOT NULL REFERENCES staff_persons(id) ON DELETE CASCADE,
  erpnext_employee_id text,
  erpnext_company text,
  sync_status text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending','linked','failed','revoked')),
  sync_error text,
  linked_at timestamptz,
  linked_by uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, staff_person_id)
);
CREATE INDEX staff_erpnext_link_tenant_status_idx ON staff_erpnext_link(tenant_id, sync_status);

ALTER TABLE integration_erpnext_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_erpnext_connection FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_erpnext_connection_access ON integration_erpnext_connection USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin'])
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin'])
);

ALTER TABLE staff_erpnext_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_erpnext_link FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_erpnext_link_access ON staff_erpnext_link USING (
  tenant_id = app.current_tenant() AND (
    app.has_any_role(ARRAY['hr','facility_admin'])
    OR EXISTS (SELECT 1 FROM staff_persons s WHERE s.id = staff_erpnext_link.staff_person_id AND s.user_id = app.current_user())
  )
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin'])
);

GRANT SELECT, INSERT, UPDATE ON integration_erpnext_connection, staff_erpnext_link TO medveris_runtime;

COMMIT;
