-- Operational notification inbox.
--
-- Facility staff receive one durable inbox row per recipient for operational events that would
-- otherwise be pull-only: low stock and lots nearing expiry. Rows are addressed to a single user
-- (RLS is per recipient) and carry a stable dedupe key so the periodic scan cannot create
-- duplicates. Acknowledgement is recorded on the row and audited by the API.
--
-- The scan runs from the jobs cron. It is a SECURITY DEFINER function owned by medveris_exchange
-- (BYPASSRLS) so it can read inventory state and write one row per eligible recipient without
-- granting the jobs role broad table access, mirroring app.record_billing_notification.
--
-- Additive: no existing table, policy or grant is changed.

BEGIN;

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('low-stock', 'near-expiry', 'critical-result', 'clarification')),
  title text NOT NULL,
  body text NOT NULL,
  resource_type text,
  resource_id uuid,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  read_by uuid REFERENCES users(id)
);

CREATE UNIQUE INDEX notifications_dedupe_unique ON notifications(recipient_user_id, dedupe_key);
CREATE INDEX notifications_inbox_idx ON notifications(recipient_user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications(recipient_user_id) WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY notifications_recipient_read ON notifications FOR SELECT
  USING (recipient_user_id = app.current_user());
CREATE POLICY notifications_recipient_update ON notifications FOR UPDATE
  USING (recipient_user_id = app.current_user())
  WITH CHECK (recipient_user_id = app.current_user());

GRANT SELECT, UPDATE ON notifications TO medveris_runtime;
GRANT SELECT, INSERT ON notifications TO medveris_exchange;

-- The scan runs as medveris_exchange; it needs read access to the inventory state it summarizes.
GRANT SELECT ON memberships, inventory_location_policies, inventory_locations, inventory_items,
  inventory_balances, inventory_lots TO medveris_exchange;

CREATE OR REPLACE FUNCTION app.enqueue_inventory_notifications()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inserted integer := 0;
BEGIN
  WITH recipients AS (
    SELECT m.tenant_id, m.user_id
      FROM memberships m
     WHERE m.status = 'active'
       AND m.roles && ARRAY['facility_admin', 'pharmacist']::text[]
  ),
  low AS (
    SELECT p.tenant_id,
           p.id AS policy_id,
           l.name AS location_name,
           i.item_code,
           i.name AS item_name,
           i.base_unit,
           p.minimum_quantity,
           p.reorder_quantity,
           coalesce(sum(b.on_hand - b.reserved - b.quarantined), 0)::float8 AS available
      FROM inventory_location_policies p
      JOIN inventory_locations l ON l.id = p.location_id
      JOIN inventory_items i ON i.id = p.item_id
      LEFT JOIN inventory_balances b ON b.tenant_id = p.tenant_id AND b.location_id = p.location_id AND b.item_id = p.item_id
     GROUP BY p.tenant_id, p.id, l.name, i.item_code, i.name, i.base_unit, p.minimum_quantity, p.reorder_quantity
    HAVING coalesce(sum(b.on_hand - b.reserved - b.quarantined), 0) <
           greatest(p.minimum_quantity, CASE WHEN p.reorder_quantity > 0 THEN p.reorder_quantity ELSE p.minimum_quantity END)
  ),
  low_rows AS (
    INSERT INTO notifications (tenant_id, recipient_user_id, kind, title, body, resource_type, resource_id, dedupe_key)
    SELECT low.tenant_id, r.user_id, 'low-stock',
           'Low stock: ' || low.item_name,
           low.item_name || ' (' || low.item_code || ') at ' || low.location_name || ' is at ' ||
             round(low.available::numeric, 2) || ' ' || low.base_unit || ', below the minimum of ' ||
             round(low.minimum_quantity::numeric, 2) || '.',
           'inventory-location-policy', low.policy_id,
           'low-stock:' || low.policy_id::text || ':' || current_date::text
      FROM low JOIN recipients r ON r.tenant_id = low.tenant_id
    ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING
    RETURNING 1
  ),
  expiring AS (
    SELECT lt.tenant_id,
           lt.id AS lot_id,
           lt.lot_number,
           lt.expires_on,
           i.item_code,
           i.name AS item_name,
           (lt.expires_on - current_date) AS days_to_expiry
      FROM inventory_lots lt
      JOIN inventory_items i ON i.id = lt.item_id
     WHERE lt.expires_on IS NOT NULL
       AND lt.status IN ('available', 'quarantine')
       AND lt.expires_on <= current_date + 30
       AND EXISTS (
         SELECT 1 FROM inventory_balances b
          WHERE b.tenant_id = lt.tenant_id AND b.lot_id = lt.id AND (b.on_hand - b.reserved - b.quarantined) > 0
       )
  ),
  expiry_rows AS (
    INSERT INTO notifications (tenant_id, recipient_user_id, kind, title, body, resource_type, resource_id, dedupe_key)
    SELECT expiring.tenant_id, r.user_id, 'near-expiry',
           'Near expiry: ' || expiring.item_name,
           'Lot ' || expiring.lot_number || ' of ' || expiring.item_name || ' (' || expiring.item_code || ') expires on ' ||
             expiring.expires_on::text || ' (' || expiring.days_to_expiry || ' day(s)).',
           'inventory-lot', expiring.lot_id,
           'near-expiry:' || expiring.lot_id::text || ':' || current_date::text
      FROM expiring JOIN recipients r ON r.tenant_id = expiring.tenant_id
    ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM low_rows) + (SELECT count(*) FROM expiry_rows) INTO inserted;

  RETURN inserted;
END;
$$;

ALTER FUNCTION app.enqueue_inventory_notifications() OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.enqueue_inventory_notifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enqueue_inventory_notifications() TO medveris_jobs;
GRANT EXECUTE ON FUNCTION app.enqueue_inventory_notifications() TO medveris_runtime;

COMMIT;
