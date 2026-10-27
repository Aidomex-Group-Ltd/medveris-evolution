-- Facility finance and administrator roles may settle the campaign record that
-- belongs to a payment they are allowed to confirm.
BEGIN;

CREATE POLICY sponsored_campaigns_finance_update ON sponsored_campaigns FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM directory_facilities f
     WHERE f.id = facility_id
       AND f.claimed_tenant_id = app.current_tenant()
       AND app.has_any_role(ARRAY['facility_admin','finance'])
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM directory_facilities f
     WHERE f.id = facility_id
       AND f.claimed_tenant_id = app.current_tenant()
       AND app.has_any_role(ARRAY['facility_admin','finance'])
  )
);

COMMIT;
