-- Fix two policies introduced by 047 that broke the provider and platform-operator flows.
--
-- 047 made sponsored payment inserts and integration-client inserts depend on the billing-system
-- actor only. The API writes those rows through the signed-in facility administrator (staff actor)
-- and, for platform operators, through the operator's staff actor with a platform role. Allow both
-- the original tenant-owner paths and the system actor, without granting DELETE.

BEGIN;

DROP POLICY IF EXISTS sponsored_payments_provider_insert ON sponsored_payments;
CREATE POLICY sponsored_payments_provider_insert ON sponsored_payments FOR INSERT WITH CHECK (
  app.is_platform_operator()
  OR (app.actor_kind() = 'system' AND EXISTS (
    SELECT 1 FROM sponsored_campaigns c WHERE c.id = campaign_id AND c.created_by = app.current_user()
  ))
  OR EXISTS (
    SELECT 1 FROM sponsored_campaigns c
     WHERE c.id = campaign_id
       AND c.created_by = app.current_user()
       AND EXISTS (
         SELECT 1 FROM directory_facilities f
          WHERE f.id = c.facility_id AND f.claimed_tenant_id = app.current_tenant()
       )
  )
);

DROP POLICY IF EXISTS integration_clients_platform ON integration_clients;
CREATE POLICY integration_clients_platform ON integration_clients FOR INSERT WITH CHECK (
  app.is_platform_operator() OR app.actor_kind() = 'system'
);

-- Webhook inserts return the new event id, so the caller also needs to read the row it just
-- wrote. 047 granted the system actor read access to payments and campaigns but not events.
DROP POLICY IF EXISTS sponsored_payment_events_read ON sponsored_payment_events;
CREATE POLICY sponsored_payment_events_read ON sponsored_payment_events FOR SELECT USING (
  app.is_platform_operator()
  OR app.actor_kind() = 'system'
  OR EXISTS (
    SELECT 1 FROM sponsored_payments p
     WHERE p.id = payment_id
       AND EXISTS (
         SELECT 1 FROM sponsored_campaigns c
          WHERE c.id = p.campaign_id
            AND EXISTS (
              SELECT 1 FROM directory_facilities f
               WHERE f.id = c.facility_id AND f.claimed_tenant_id = app.current_tenant()
            )
       )
  )
);

COMMIT;
