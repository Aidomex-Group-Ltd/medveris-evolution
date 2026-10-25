-- Inventory hardening: balance identity for non-lot stock and export audit.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS inventory_balances_identity
  ON inventory_balances (tenant_id, location_id, item_id, COALESCE(lot_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS inventory_export_audit (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  report_key text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE inventory_export_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_export_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_export_audit_tenant ON inventory_export_audit
  USING (tenant_id = app.current_tenant() AND app.is_inventory_staff())
  WITH CHECK (tenant_id = app.current_tenant() AND app.is_inventory_staff());
GRANT SELECT, INSERT ON inventory_export_audit TO medveris_runtime;

COMMIT;
