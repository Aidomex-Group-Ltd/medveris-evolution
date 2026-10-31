-- Retail pharmacy point of sale on top of the departmental inventory ledger.
--
-- Products, batches, balances and stock movements stay in inventory_items /
-- inventory_lots / inventory_balances / inventory_movements. This migration adds
-- the retail-facing catalogue attributes, prescriptions, and the immutable sale
-- records that allocate FEFO lots and reference the existing stock ledger.

BEGIN;

-- ---------------------------------------------------------------- catalogue attributes

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS generic_name text,
  ADD COLUMN IF NOT EXISTS brand_name text,
  ADD COLUMN IF NOT EXISTS strength text,
  ADD COLUMN IF NOT EXISTS form text,
  ADD COLUMN IF NOT EXISTS selling_price numeric(18,4) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  ADD COLUMN IF NOT EXISTS tax_rate numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  ADD COLUMN IF NOT EXISTS prescription_only boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reorder_threshold numeric(18,4) CHECK (reorder_threshold IS NULL OR reorder_threshold >= 0);

-- A supplier invoice is unique per supplier inside a workspace so a goods-received
-- note cannot be posted twice. Receipts that legitimately reconcile a duplicate
-- must supply a distinct invoice reference.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS supplier_invoice_number text;
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_supplier_invoice
  ON purchase_orders(tenant_id, supplier_id, supplier_invoice_number)
  WHERE supplier_invoice_number IS NOT NULL;

-- ---------------------------------------------------------------- prescriptions

CREATE TABLE pharmacy_prescriptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid REFERENCES encounters(id),
  prescriber_id uuid NOT NULL REFERENCES users(id),
  reference text NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN (
    'issued','partially-dispensed','dispensed','cancelled','expired'
  )),
  issued_on date NOT NULL DEFAULT current_date,
  expires_on date,
  notes text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference),
  CHECK (expires_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX pharmacy_prescriptions_patient_idx
  ON pharmacy_prescriptions(tenant_id, patient_id, issued_on DESC);

CREATE TABLE pharmacy_prescription_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  prescription_id uuid NOT NULL REFERENCES pharmacy_prescriptions(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  dose_text text NOT NULL,
  route text NOT NULL,
  frequency text NOT NULL,
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  repeats_allowed integer NOT NULL DEFAULT 0 CHECK (repeats_allowed BETWEEN 0 AND 24),
  repeats_used integer NOT NULL DEFAULT 0 CHECK (repeats_used >= 0),
  directions text,
  prescription_only boolean NOT NULL DEFAULT true,
  dispensed_quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (dispensed_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prescription_id, item_id)
);
CREATE INDEX pharmacy_prescription_items_prescription_idx
  ON pharmacy_prescription_items(prescription_id);

-- ---------------------------------------------------------------- sales

CREATE TABLE pharmacy_sales (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES inventory_locations(id),
  sale_number text NOT NULL,
  patient_id uuid REFERENCES patients(id),
  prescription_id uuid REFERENCES pharmacy_prescriptions(id),
  cashier_id uuid NOT NULL REFERENCES users(id),
  currency text NOT NULL DEFAULT 'UGX' CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal numeric(18,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount numeric(18,4) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax numeric(18,4) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total numeric(18,4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  payment_method text NOT NULL CHECK (payment_method IN ('cash','mobile-money','bank-transfer','card','manual')),
  payment_reference text,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
  idempotency_key text,
  voided_by uuid REFERENCES users(id),
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sale_number),
  CHECK (status <> 'voided' OR (voided_by IS NOT NULL AND voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE UNIQUE INDEX pharmacy_sales_idempotency
  ON pharmacy_sales(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX pharmacy_sales_tenant_created_idx
  ON pharmacy_sales(tenant_id, created_at DESC);
CREATE INDEX pharmacy_sales_patient_idx
  ON pharmacy_sales(tenant_id, patient_id, created_at DESC);

CREATE TABLE pharmacy_sale_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_id uuid NOT NULL REFERENCES pharmacy_sales(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  prescription_item_id uuid REFERENCES pharmacy_prescription_items(id),
  description text NOT NULL,
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  discount numeric(18,4) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax numeric(18,4) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  line_total numeric(18,4) NOT NULL CHECK (line_total >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pharmacy_sale_lines_sale_idx ON pharmacy_sale_lines(sale_id);
CREATE INDEX pharmacy_sale_lines_item_idx ON pharmacy_sale_lines(tenant_id, item_id, created_at DESC);

CREATE TABLE pharmacy_sale_allocations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_line_id uuid NOT NULL REFERENCES pharmacy_sale_lines(id) ON DELETE CASCADE,
  lot_id uuid NOT NULL REFERENCES inventory_lots(id),
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  expires_on date,
  unit_cost numeric(18,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pharmacy_sale_allocations_line_idx ON pharmacy_sale_allocations(sale_line_id);
CREATE INDEX pharmacy_sale_allocations_lot_idx ON pharmacy_sale_allocations(tenant_id, lot_id);

-- ---------------------------------------------------------------- RLS and grants

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'pharmacy_prescriptions','pharmacy_prescription_items',
    'pharmacy_sales','pharmacy_sale_lines','pharmacy_sale_allocations'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant() AND app.is_inventory_staff()) WITH CHECK (tenant_id = app.current_tenant() AND app.is_inventory_staff())', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON pharmacy_prescriptions, pharmacy_prescription_items TO medveris_runtime;
GRANT SELECT, INSERT, UPDATE ON pharmacy_sales TO medveris_runtime;
GRANT SELECT, INSERT ON pharmacy_sale_lines, pharmacy_sale_allocations TO medveris_runtime;

-- Sale lines and batch allocations are the evidence of what was sold from which
-- batch; they may never be edited or deleted. Voids are compensating movements.
REVOKE UPDATE, DELETE ON pharmacy_sale_lines, pharmacy_sale_allocations FROM medveris_runtime;

COMMIT;
