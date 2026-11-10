-- Additive: optional facility-configured default registration/initial consultation charge.
-- Null means no automatic charge on registration (preserves existing behavior).

ALTER TABLE facility_billing_settings
  ADD COLUMN IF NOT EXISTS registration_charge_catalog_id uuid REFERENCES service_catalog(id),
  ADD COLUMN IF NOT EXISTS registration_charge_enabled boolean NOT NULL DEFAULT false;

-- Traceable, idempotent registration billing marker (no duplicate initial charge per patient/facility).
CREATE TABLE IF NOT EXISTS patient_registration_billing (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  invoice_item_id uuid NOT NULL REFERENCES invoice_items(id),
  catalog_item_id uuid REFERENCES service_catalog(id),
  amount numeric NOT NULL CHECK (amount >= 0),
  currency text NOT NULL CHECK (length(currency) = 3),
  status text NOT NULL DEFAULT 'billed' CHECK (status IN ('billed','exempt','skipped')),
  reason text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, patient_id)
);

CREATE INDEX IF NOT EXISTS patient_registration_billing_invoice_idx ON patient_registration_billing(tenant_id, invoice_id);

ALTER TABLE patient_registration_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_registration_billing FORCE ROW LEVEL SECURITY;

-- Finance/admin/auditor can read traceability; runtime inserts as part of registration workflow under staff context.
CREATE POLICY patient_registration_billing_read ON patient_registration_billing FOR SELECT USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin','auditor','receptionist','nurse','clinician'])
);
CREATE POLICY patient_registration_billing_insert ON patient_registration_billing FOR INSERT WITH CHECK (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'staff'
);
GRANT SELECT, INSERT ON patient_registration_billing TO medveris_runtime;
