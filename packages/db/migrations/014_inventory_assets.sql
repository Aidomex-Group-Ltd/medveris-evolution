-- Departmental inventory, auditable stock ledger, transfers, counts, recalls
-- and a connected fixed-asset register.
--
-- Quantity is always expressed in the item's base unit in the ledger. The
-- entered unit and conversion factor are retained for traceability. Balances
-- are projections and may only move through posted ledger entries.

BEGIN;

CREATE OR REPLACE FUNCTION app.is_inventory_staff() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.actor_kind() = 'staff' AND app.has_any_role(ARRAY[
    'facility_admin','pharmacist','biomedical','housekeeping','laboratory','radiology',
    'cssd','theatre','nurse','midwife','clinician','specialist_clinician','department_lead',
    'finance','auditor','hr','records','quality','porter','mortuary','it_admin','receptionist'
  ])
$$;

CREATE TABLE inventory_locations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES inventory_locations(id),
  code text NOT NULL,
  name text NOT NULL,
  location_type text NOT NULL CHECK (location_type IN (
    'central-store','department-store','unit-store','ward-store','room','cabinet','bin','equipment-location'
  )),
  department_id uuid REFERENCES departments(id),
  unit_id uuid REFERENCES units(id),
  physical_location_id uuid REFERENCES locations(id),
  custodian_user_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','closed')),
  description text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX inventory_locations_tenant_idx ON inventory_locations(tenant_id, location_type, status);
CREATE INDEX inventory_locations_department_idx ON inventory_locations(tenant_id, department_id);

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_code text NOT NULL,
  name text NOT NULL,
  description text,
  category text NOT NULL,
  subcategory text,
  classification text NOT NULL CHECK (classification IN (
    'consumable','medicine','asset','reusable','returnable'
  )),
  base_unit text NOT NULL,
  medicine_id uuid REFERENCES medicines(id),
  manufacturer text,
  supplier_name text,
  barcode text,
  lot_tracked boolean NOT NULL DEFAULT false,
  serial_tracked boolean NOT NULL DEFAULT false,
  expiry_tracked boolean NOT NULL DEFAULT false,
  storage_requirements text,
  criticality text NOT NULL DEFAULT 'standard' CHECK (criticality IN ('standard','medium','high','critical')),
  unit_cost numeric(18,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  currency text NOT NULL DEFAULT 'UGX' CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','discontinued')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, item_code),
  CHECK (classification <> 'medicine' OR medicine_id IS NOT NULL)
);
CREATE INDEX inventory_items_tenant_idx ON inventory_items(tenant_id, classification, status, name);

CREATE TABLE inventory_item_units (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  unit text NOT NULL,
  conversion_factor numeric(18,6) NOT NULL CHECK (conversion_factor > 0),
  is_base boolean NOT NULL DEFAULT false,
  purchasing_unit boolean NOT NULL DEFAULT false,
  issuing_unit boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, unit)
);
CREATE UNIQUE INDEX inventory_item_one_base_unit ON inventory_item_units(item_id) WHERE is_base;

CREATE TABLE inventory_location_policies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  minimum_quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (minimum_quantity >= 0),
  maximum_quantity numeric(18,4) CHECK (maximum_quantity IS NULL OR maximum_quantity >= 0),
  reorder_quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (reorder_quantity >= 0),
  criticality text NOT NULL DEFAULT 'standard' CHECK (criticality IN ('standard','medium','high','critical')),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, item_id),
  CHECK (maximum_quantity IS NULL OR maximum_quantity >= minimum_quantity)
);

CREATE TABLE inventory_lots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  lot_number text NOT NULL DEFAULT '',
  manufacture_on date,
  expires_on date,
  supplier text,
  receipt_reference text,
  status text NOT NULL DEFAULT 'available' CHECK (status IN (
    'available','quarantine','expired','recalled','damaged'
  )),
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, item_id, lot_number),
  CHECK (expires_on IS NULL OR manufacture_on IS NULL OR expires_on >= manufacture_on)
);
CREATE INDEX inventory_lots_expiry_idx ON inventory_lots(tenant_id, expires_on, status);

CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  lot_id uuid REFERENCES inventory_lots(id),
  serial_number text,
  source_location_id uuid REFERENCES inventory_locations(id),
  destination_location_id uuid REFERENCES inventory_locations(id),
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  conversion_factor numeric(18,6) NOT NULL DEFAULT 1 CHECK (conversion_factor > 0),
  base_quantity numeric(18,4) GENERATED ALWAYS AS (round(quantity * conversion_factor, 4)) STORED,
  movement_type text NOT NULL CHECK (movement_type IN (
    'opening','receipt','issue','transfer-out','transfer-in','consumption','return',
    'adjustment','count-adjustment','quarantine','recall','write-off','reversal'
  )),
  reference_type text,
  reference_id text,
  occurred_at timestamptz NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid NOT NULL REFERENCES users(id),
  approver_id uuid REFERENCES users(id),
  reason text NOT NULL,
  idempotency_key text,
  reverses_movement_id uuid REFERENCES inventory_movements(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_location_id IS NOT NULL OR destination_location_id IS NOT NULL),
  CHECK (source_location_id IS DISTINCT FROM destination_location_id),
  CHECK (movement_type <> 'reversal' OR reverses_movement_id IS NOT NULL),
  CHECK (movement_type <> 'issue' OR source_location_id IS NOT NULL)
);
CREATE UNIQUE INDEX inventory_movements_idempotency ON inventory_movements(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX inventory_movements_reversal ON inventory_movements(reverses_movement_id)
  WHERE reverses_movement_id IS NOT NULL;
CREATE INDEX inventory_movements_item_idx ON inventory_movements(tenant_id, item_id, occurred_at DESC);
CREATE INDEX inventory_movements_location_idx ON inventory_movements(tenant_id, source_location_id, destination_location_id, posted_at DESC);

CREATE TABLE inventory_balances (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES inventory_locations(id),
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  lot_id uuid REFERENCES inventory_lots(id),
  on_hand numeric(18,4) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved numeric(18,4) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  quarantined numeric(18,4) NOT NULL DEFAULT 0 CHECK (quarantined >= 0),
  in_transit numeric(18,4) NOT NULL DEFAULT 0 CHECK (in_transit >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, location_id, item_id, lot_id)
);
CREATE INDEX inventory_balances_lookup_idx ON inventory_balances(tenant_id, location_id, item_id);
CREATE INDEX inventory_balances_item_idx ON inventory_balances(tenant_id, item_id);

CREATE TABLE stock_reservations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES inventory_locations(id),
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  lot_id uuid REFERENCES inventory_lots(id),
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  source_type text NOT NULL,
  source_id text,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','fulfilled','cancelled','expired')),
  expires_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX stock_reservations_active_idx ON stock_reservations(tenant_id, location_id, item_id, status, expires_at);

CREATE TABLE inventory_requisitions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_number text NOT NULL,
  requesting_department_id uuid REFERENCES departments(id),
  requesting_location_id uuid REFERENCES inventory_locations(id),
  fulfilling_location_id uuid NOT NULL REFERENCES inventory_locations(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','submitted','approved','rejected','partially-issued','issued','cancelled'
  )),
  reason text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_number),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE INDEX inventory_requisitions_status_idx ON inventory_requisitions(tenant_id, status, created_at);

CREATE TABLE inventory_requisition_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requisition_id uuid NOT NULL REFERENCES inventory_requisitions(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  requested_quantity numeric(18,4) NOT NULL CHECK (requested_quantity > 0),
  approved_quantity numeric(18,4) CHECK (approved_quantity IS NULL OR approved_quantity >= 0),
  issued_quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (issued_quantity >= 0),
  unit text NOT NULL,
  notes text,
  CHECK (approved_quantity IS NULL OR approved_quantity <= requested_quantity),
  CHECK (issued_quantity <= coalesce(approved_quantity, requested_quantity))
);

CREATE TABLE inventory_transfers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transfer_number text NOT NULL,
  source_location_id uuid NOT NULL REFERENCES inventory_locations(id),
  destination_location_id uuid NOT NULL REFERENCES inventory_locations(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','dispatched','in-transit','partially-received','received','cancelled'
  )),
  dispatched_by uuid REFERENCES users(id),
  received_by uuid REFERENCES users(id),
  dispatched_at timestamptz,
  received_at timestamptz,
  discrepancy_note text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, transfer_number),
  CHECK (source_location_id <> destination_location_id)
);
CREATE INDEX inventory_transfers_status_idx ON inventory_transfers(tenant_id, status, created_at);

CREATE TABLE inventory_transfer_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL REFERENCES inventory_transfers(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  lot_id uuid REFERENCES inventory_lots(id),
  dispatched_quantity numeric(18,4) NOT NULL CHECK (dispatched_quantity > 0),
  received_quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  rejected_quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  unit text NOT NULL,
  discrepancy_reason text,
  CHECK (received_quantity + rejected_quantity <= dispatched_quantity)
);

CREATE TABLE inventory_counts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  count_number text NOT NULL,
  location_id uuid NOT NULL REFERENCES inventory_locations(id),
  scope text NOT NULL DEFAULT 'location' CHECK (scope IN ('location','category','item')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','counting','submitted','approved','rejected','posted'
  )),
  blind boolean NOT NULL DEFAULT false,
  counted_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  posted_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, count_number),
  CHECK (approved_by IS NULL OR approved_by <> counted_by)
);
CREATE INDEX inventory_counts_status_idx ON inventory_counts(tenant_id, status, created_at);

CREATE TABLE inventory_count_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  count_id uuid NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  lot_id uuid REFERENCES inventory_lots(id),
  snapshot_quantity numeric(18,4) NOT NULL CHECK (snapshot_quantity >= 0),
  counted_quantity numeric(18,4) CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
  variance numeric(18,4),
  reason_code text,
  adjustment_movement_id uuid REFERENCES inventory_movements(id),
  UNIQUE (count_id, item_id, lot_id)
);

CREATE TABLE inventory_adjustments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  adjustment_number text NOT NULL,
  location_id uuid NOT NULL REFERENCES inventory_locations(id),
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  lot_id uuid REFERENCES inventory_lots(id),
  quantity_delta numeric(18,4) NOT NULL CHECK (quantity_delta <> 0),
  unit text NOT NULL,
  reason_code text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','posted')),
  requested_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  movement_id uuid REFERENCES inventory_movements(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, adjustment_number),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

CREATE TABLE inventory_recalls (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recall_number text NOT NULL,
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  lot_id uuid REFERENCES inventory_lots(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','closed')),
  initiated_by uuid NOT NULL REFERENCES users(id),
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, recall_number)
);

CREATE TABLE inventory_assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id uuid REFERENCES inventory_items(id),
  asset_tag text NOT NULL,
  name text NOT NULL,
  manufacturer text,
  model text,
  serial_number text,
  location_id uuid REFERENCES inventory_locations(id),
  department_id uuid REFERENCES departments(id),
  custodian_user_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending-commissioning' CHECK (status IN (
    'pending-commissioning','in-service','reserved','under-maintenance','out-of-service','retired'
  )),
  custody_status text NOT NULL DEFAULT 'in-store' CHECK (custody_status IN (
    'in-store','assigned','in-use','in-transit','maintenance','retired'
  )),
  acquisition_date date,
  acquisition_cost numeric(18,2) CHECK (acquisition_cost IS NULL OR acquisition_cost >= 0),
  currency text NOT NULL DEFAULT 'UGX' CHECK (currency ~ '^[A-Z]{3}$'),
  warranty_ends_on date,
  service_agreement text,
  maintenance_interval_days integer CHECK (maintenance_interval_days IS NULL OR maintenance_interval_days > 0),
  next_maintenance_on date,
  next_calibration_on date,
  commissioned_at timestamptz,
  commissioned_by uuid REFERENCES users(id),
  retired_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, asset_tag),
  CHECK (status <> 'in-service' OR commissioned_at IS NOT NULL)
);
CREATE INDEX inventory_assets_status_idx ON inventory_assets(tenant_id, status, department_id);
CREATE UNIQUE INDEX inventory_assets_serial_unique ON inventory_assets(tenant_id, serial_number)
  WHERE serial_number IS NOT NULL;

CREATE TABLE inventory_asset_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES inventory_assets(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'commission','assignment','transfer','loan','maintenance','calibration','fault','service-release','retirement'
  )),
  from_status text,
  to_status text NOT NULL,
  from_custody text,
  to_custody text,
  note text NOT NULL,
  performed_by uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_asset_events_idx ON inventory_asset_events(asset_id, occurred_at);

CREATE OR REPLACE FUNCTION app.reject_inventory_movement_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_inventory_movement' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER inventory_movements_immutable BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION app.reject_inventory_movement_mutation();
CREATE TRIGGER inventory_asset_events_immutable BEFORE UPDATE OR DELETE ON inventory_asset_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_inventory_movement_mutation();

-- RLS -----------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'inventory_locations','inventory_items','inventory_item_units','inventory_location_policies',
    'inventory_lots','inventory_movements','inventory_balances','stock_reservations',
    'inventory_requisitions','inventory_requisition_lines','inventory_transfers',
    'inventory_transfer_lines','inventory_counts','inventory_count_lines',
    'inventory_adjustments','inventory_recalls','inventory_assets','inventory_asset_events'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant() AND app.is_inventory_staff()) WITH CHECK (tenant_id = app.current_tenant() AND app.is_inventory_staff())', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  inventory_locations, inventory_items, inventory_item_units, inventory_location_policies,
  inventory_lots, inventory_movements, inventory_balances, stock_reservations,
  inventory_requisitions, inventory_requisition_lines, inventory_transfers,
  inventory_transfer_lines, inventory_counts, inventory_count_lines,
  inventory_adjustments, inventory_recalls, inventory_assets, inventory_asset_events
TO medveris_runtime;

REVOKE UPDATE, DELETE ON inventory_movements FROM medveris_runtime;
REVOKE UPDATE, DELETE ON inventory_asset_events FROM medveris_runtime;

COMMIT;
