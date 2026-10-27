-- Facility finance and administrator roles may confirm or reconcile payments
-- for campaigns owned by their facility. All other payment mutations remain
-- platform-operator only.
BEGIN;

CREATE POLICY sponsored_payments_tenant_update ON sponsored_payments FOR UPDATE USING (
  app.is_platform_operator()
  OR (
    app.has_any_role(ARRAY['facility_admin','finance'])
    AND EXISTS (
      SELECT 1 FROM sponsored_campaigns c
        JOIN directory_facilities f ON f.id = c.facility_id
       WHERE c.id = campaign_id AND f.claimed_tenant_id = app.current_tenant()
    )
  )
) WITH CHECK (
  app.is_platform_operator()
  OR (
    app.has_any_role(ARRAY['facility_admin','finance'])
    AND EXISTS (
      SELECT 1 FROM sponsored_campaigns c
        JOIN directory_facilities f ON f.id = c.facility_id
       WHERE c.id = campaign_id AND f.claimed_tenant_id = app.current_tenant()
    )
  )
);

COMMIT;
