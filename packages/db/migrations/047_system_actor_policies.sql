-- Migration 047: Allow the billing-system actor to read integration and sponsored data
BEGIN;

ALTER TABLE integration_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_clients FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integration_clients_read ON integration_clients;
CREATE POLICY integration_clients_read ON integration_clients FOR SELECT USING (
  app.is_platform_operator()
  OR tenant_id = app.current_tenant()
  OR (app.actor_kind() = 'system' AND app.is_platform_operator() = false)
);

DROP POLICY IF EXISTS integration_clients_platform ON integration_clients;
CREATE POLICY integration_clients_platform ON integration_clients FOR INSERT WITH CHECK (app.actor_kind() = 'system');
CREATE POLICY integration_clients_platform_update ON integration_clients FOR UPDATE USING (
  app.is_platform_operator()
  OR (app.actor_kind() = 'system' AND tenant_id = app.current_tenant())
);

DROP POLICY IF EXISTS sponsored_payments_read ON sponsored_payments;
CREATE POLICY sponsored_payments_read ON sponsored_payments FOR SELECT USING (
  app.is_platform_operator()
  OR app.actor_kind() = 'system'
  OR EXISTS (SELECT 1 FROM sponsored_campaigns c WHERE c.id = campaign_id AND EXISTS (
    SELECT 1 FROM directory_facilities f WHERE f.id = c.facility_id AND f.claimed_tenant_id = app.current_tenant()
  ))
);

DROP POLICY IF EXISTS sponsored_payments_platform_update ON sponsored_payments;
CREATE POLICY sponsored_payments_platform_update ON sponsored_payments FOR UPDATE USING (
  app.is_platform_operator() OR app.actor_kind() = 'system'
);

DROP POLICY IF EXISTS sponsored_payments_provider_insert ON sponsored_payments;
CREATE POLICY sponsored_payments_provider_insert ON sponsored_payments FOR INSERT WITH CHECK (
  app.is_platform_operator()
  OR (app.actor_kind() = 'system' AND EXISTS (
    SELECT 1 FROM sponsored_campaigns c WHERE c.id = campaign_id AND c.created_by = app.current_user()
  ))
);

DROP POLICY IF EXISTS sponsored_campaigns_read ON sponsored_campaigns;
CREATE POLICY sponsored_campaigns_read ON sponsored_campaigns FOR SELECT USING (
  app.is_platform_operator()
  OR app.actor_kind() = 'system'
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant())
  OR (status = 'active' AND payment_status = 'paid' AND editorial_status = 'approved'
      AND starts_on <= current_date AND ends_on >= current_date)
);

DROP POLICY IF EXISTS sponsored_campaigns_provider_write ON sponsored_campaigns;
CREATE POLICY sponsored_campaigns_provider_write_insert ON sponsored_campaigns FOR INSERT WITH CHECK (
  app.is_platform_operator()
  OR app.actor_kind() = 'system'
  OR (created_by = app.current_user() AND EXISTS (
    SELECT 1 FROM directory_facilities f where f.id = facility_id AND f.claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin'])
  ))
);
CREATE POLICY sponsored_campaigns_provider_write_update ON sponsored_campaigns FOR UPDATE USING (
  app.is_platform_operator()
  OR app.actor_kind() = 'system'
  OR (created_by = app.current_user() AND EXISTS (
    SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin'])
  ))
);

COMMIT;
