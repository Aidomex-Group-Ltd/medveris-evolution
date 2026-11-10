-- Allow reception/registration workflows to create the system-generated initial registration charge.
-- Scope remains tenant-bound and staff-only; finance/facility_admin retain full invoice/item mutation rights.

BEGIN;

DROP POLICY IF EXISTS invoices_tenant ON invoices;
CREATE POLICY invoices_tenant ON invoices USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin','receptionist'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin','receptionist']));

DROP POLICY IF EXISTS invoice_items_tenant ON invoice_items;
CREATE POLICY invoice_items_tenant ON invoice_items USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin','receptionist'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin','receptionist']));

COMMIT;
