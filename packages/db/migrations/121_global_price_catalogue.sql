-- Global price catalogue tables for Medveris
-- Provides master price lists that facilities can adopt and customize

BEGIN;

-- ============================================================================
-- MASTER PRICES - Global canonical service/item prices
-- ============================================================================
CREATE TABLE IF NOT EXISTS master_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(50) NOT NULL,
  subcategory VARCHAR(100),
  unit_type VARCHAR(50) NOT NULL DEFAULT 'clinical',
  is_service BOOLEAN NOT NULL DEFAULT true,
  base_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'UGX',
  effective_from DATE NOT NULL DEFAULT current_date,
  effective_to DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ
);

ALTER TABLE master_prices ENABLE ROW LEVEL SECURITY;

-- Only platform operators can manage master prices
CREATE POLICY master_prices_platform_operator ON master_prices
  FOR ALL
  USING (app.is_platform_operator())
  WITH CHECK (app.is_platform_operator());

-- Everyone can read active master prices
CREATE POLICY master_prices_read ON master_prices
  FOR SELECT
  USING (active = true OR app.current_user() IS NOT NULL);

CREATE INDEX IF NOT EXISTS master_prices_code_idx ON master_prices(code);
CREATE INDEX IF NOT EXISTS master_prices_category_idx ON master_prices(category);
CREATE INDEX IF NOT EXISTS master_prices_active_idx ON master_prices(active) WHERE active = true;
CREATE INDEX IF NOT EXISTS master_prices_effective_idx ON master_prices(effective_from, effective_to) WHERE active = true;

-- ============================================================================
-- PRICE LISTS - Facility-adopted price lists
-- ============================================================================
CREATE TABLE IF NOT EXISTS price_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  facility_id UUID,
  tenant_id UUID,
  source_type VARCHAR(50) NOT NULL DEFAULT 'manual',
  source_reference VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  effective_from DATE NOT NULL,
  effective_to DATE,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ
);

ALTER TABLE price_lists ENABLE ROW LEVEL SECURITY;

-- Facility users can see their own price lists
CREATE POLICY price_lists_facility_read ON price_lists
  FOR SELECT
  USING (
    facility_id IS NULL OR
    facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active') OR
    tenant_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active')
  );

-- Platform operators can manage all price lists
CREATE POLICY price_lists_platform_operator ON price_lists
  FOR ALL
  USING (app.is_platform_operator())
  WITH CHECK (app.is_platform_operator());

-- Facility admins can manage their own price lists
CREATE POLICY price_lists_facility_write ON price_lists
  FOR ALL
  USING (
    facility_id IS NOT NULL AND
    facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active' AND m.roles && ARRAY['facility_admin'::text, 'finance'::text])
  )
  WITH CHECK (
    facility_id IS NOT NULL AND
    facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active' AND m.roles && ARRAY['facility_admin'::text, 'finance'::text])
  );

CREATE INDEX IF NOT EXISTS price_lists_code_idx ON price_lists(code);
CREATE INDEX IF NOT EXISTS price_lists_facility_idx ON price_lists(facility_id) WHERE facility_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS price_lists_status_idx ON price_lists(status);
CREATE INDEX IF NOT EXISTS price_lists_active_idx ON price_lists(active) WHERE active = true;

-- ============================================================================
-- PRICE LIST PRICES - Individual prices within a price list
-- ============================================================================
CREATE TABLE IF NOT EXISTS price_list_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_id UUID NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  master_price_code VARCHAR(50),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(50) NOT NULL,
  unit_type VARCHAR(50) NOT NULL DEFAULT 'clinical',
  is_service BOOLEAN NOT NULL DEFAULT true,
  price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'UGX',
  cost NUMERIC(12, 2),
  markup_percent NUMERIC(6, 2),
  is_active BOOLEAN NOT NULL DEFAULT true,
  requires_approval BOOLEAN NOT NULL DEFAULT true,
  approval_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  effective_from DATE NOT NULL DEFAULT current_date,
  effective_to DATE,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ
);

ALTER TABLE price_list_prices ENABLE ROW LEVEL SECURITY;

-- Read access: own facility's prices or platform
CREATE POLICY price_list_prices_read ON price_list_prices
  FOR SELECT
  USING (
    price_list_id IN (
      SELECT pl.id FROM price_lists pl WHERE
        pl.facility_id IS NULL OR
        pl.facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active') OR
        pl.tenant_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active')
    )
  );

-- Write access: platform operators or facility finance/admin
CREATE POLICY price_list_prices_write ON price_list_prices
  FOR ALL
  USING (
    price_list_id IN (
      SELECT pl.id FROM price_lists pl
      WHERE pl.facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active' AND m.roles && ARRAY['facility_admin'::text, 'finance'::text])
    )
  )
  WITH CHECK (
    price_list_id IN (
      SELECT pl.id FROM price_lists pl
      WHERE pl.facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active' AND m.roles && ARRAY['facility_admin'::text, 'finance'::text])
    )
  );

CREATE INDEX IF NOT EXISTS price_list_prices_list_idx ON price_list_prices(price_list_id);
CREATE INDEX IF NOT EXISTS price_list_prices_master_idx ON price_list_prices(master_price_code);
CREATE INDEX IF NOT EXISTS price_list_prices_active_idx ON price_list_prices(is_active) WHERE is_active = true;

-- ============================================================================
-- FACILITY PRICE OVERRIDES - Facility-specific price adjustments
-- ============================================================================
CREATE TABLE IF NOT EXISTS facility_price_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL,
  price_list_price_id UUID NOT NULL REFERENCES price_list_prices(id),
  original_price NUMERIC(12, 2) NOT NULL,
  override_price NUMERIC(12, 2) NOT NULL,
  reason VARCHAR(500),
  effective_from DATE NOT NULL DEFAULT current_date,
  effective_to DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ
);

ALTER TABLE facility_price_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY facility_price_overrides_read ON facility_price_overrides
  FOR SELECT
  USING (facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active'));

CREATE POLICY facility_price_overrides_write ON facility_price_overrides
  FOR ALL
  USING (
    facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active' AND m.roles && ARRAY['facility_admin'::text, 'finance'::text])
  )
  WITH CHECK (
    facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active' AND m.roles && ARRAY['facility_admin'::text, 'finance'::text])
  );

CREATE INDEX IF NOT EXISTS facility_price_overrides_facility_idx ON facility_price_overrides(facility_id);
CREATE INDEX IF NOT EXISTS facility_price_overrides_price_idx ON facility_price_overrides(price_list_price_id);

-- ============================================================================
-- DEPARTMENT PRICE OVERRIDES - Department-specific price adjustments
-- ============================================================================
CREATE TABLE IF NOT EXISTS department_price_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL,
  department_id UUID NOT NULL,
  price_list_price_id UUID NOT NULL REFERENCES price_list_prices(id),
  original_price NUMERIC(12, 2) NOT NULL,
  override_price NUMERIC(12, 2) NOT NULL,
  reason VARCHAR(500),
  effective_from DATE NOT NULL DEFAULT current_date,
  effective_to DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ
);

ALTER TABLE department_price_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY department_price_overrides_read ON department_price_overrides
  FOR SELECT
  USING (
    facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active') AND
    department_id IN (SELECT d.id FROM departments d WHERE d.tenant_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active'))
  );

CREATE POLICY department_price_overrides_write ON department_price_overrides
  FOR ALL
  USING (
    facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active' AND m.roles && ARRAY['facility_admin'::text, 'finance'::text])
  )
  WITH CHECK (
    facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active' AND m.roles && ARRAY['facility_admin'::text, 'finance'::text])
  );

CREATE INDEX IF NOT EXISTS department_price_overrides_facility_idx ON department_price_overrides(facility_id);
CREATE INDEX IF NOT EXISTS department_price_overrides_department_idx ON department_price_overrides(department_id);

-- ============================================================================
-- PRICE HISTORY - Audit trail for price changes
-- ============================================================================
CREATE TABLE IF NOT EXISTS price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_price_id UUID NOT NULL REFERENCES price_list_prices(id),
  change_type VARCHAR(20) NOT NULL,
  previous_price NUMERIC(12, 2),
  new_price NUMERIC(12, 2) NOT NULL,
  changed_by UUID NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason VARCHAR(500),
  approval_status_before VARCHAR(20),
  approval_status_after VARCHAR(20)
);

ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY price_history_read ON price_history
  FOR SELECT
  USING (
    price_list_price_id IN (
      SELECT plp.id FROM price_list_prices plp
      JOIN price_lists pl ON pl.id = plp.price_list_id
      WHERE pl.facility_id IS NULL OR
        pl.facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active') OR
        pl.tenant_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active')
    )
  );

CREATE INDEX IF NOT EXISTS price_history_price_idx ON price_history(price_list_price_id);
CREATE INDEX IF NOT EXISTS price_history_changed_at_idx ON price_history(changed_at DESC);

-- ============================================================================
-- FACILITY ITEM AVAILABILITY - Track which items/services facilities offer
-- ============================================================================
CREATE TABLE IF NOT EXISTS facility_item_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL,
  price_list_price_id UUID REFERENCES price_list_prices(id),
  master_price_code VARCHAR(50),
  item_name VARCHAR(255) NOT NULL,
  category VARCHAR(50) NOT NULL,
  is_available BOOLEAN NOT NULL DEFAULT true,
  is_billable BOOLEAN NOT NULL DEFAULT true,
  min_quantity INTEGER NOT NULL DEFAULT 1,
  max_quantity INTEGER,
  default_quantity INTEGER NOT NULL DEFAULT 1,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  effective_from DATE NOT NULL DEFAULT current_date,
  effective_to DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ
);

ALTER TABLE facility_item_availability ENABLE ROW LEVEL SECURITY;

CREATE POLICY facility_item_availability_read ON facility_item_availability
  FOR SELECT
  USING (facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active'));

CREATE POLICY facility_item_availability_write ON facility_item_availability
  FOR ALL
  USING (
    facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active' AND m.roles && ARRAY['facility_admin'::text, 'finance'::text, 'clinical'::text])
  )
  WITH CHECK (
    facility_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user() AND m.status = 'active' AND m.roles && ARRAY['facility_admin'::text, 'finance'::text, 'clinical'::text])
  );

CREATE INDEX IF NOT EXISTS facility_item_availability_facility_idx ON facility_item_availability(facility_id);
CREATE INDEX IF NOT EXISTS facility_item_availability_price_idx ON facility_item_availability(price_list_price_id);

-- ============================================================================
-- TRIGGERS FOR AUDIT AND VERSION TRACKING
-- ============================================================================

-- Updated_at trigger for master_prices
CREATE OR REPLACE FUNCTION update_master_prices_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_master_prices_updated_at ON master_prices;
CREATE TRIGGER trigger_master_prices_updated_at
  BEFORE UPDATE ON master_prices
  FOR EACH ROW
  EXECUTE FUNCTION update_master_prices_updated_at();

-- Updated_at trigger for price_lists
CREATE OR REPLACE FUNCTION update_price_lists_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_price_lists_updated_at ON price_lists;
CREATE TRIGGER trigger_price_lists_updated_at
  BEFORE UPDATE ON price_lists
  FOR EACH ROW
  EXECUTE FUNCTION update_price_lists_updated_at();

-- Updated_at trigger for price_list_prices
CREATE OR REPLACE FUNCTION update_price_list_prices_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_price_list_prices_updated_at ON price_list_prices;
CREATE TRIGGER trigger_price_list_prices_updated_at
  BEFORE UPDATE ON price_list_prices
  FOR EACH ROW
  EXECUTE FUNCTION update_price_list_prices_updated_at();

-- Auto-record price history on price_list_prices changes
CREATE OR REPLACE FUNCTION record_price_history()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO price_history (price_list_price_id, change_type, new_price, changed_by, reason, approval_status_after)
    VALUES (NEW.id, 'create', NEW.price, NEW.created_by, 'Initial price entry', NEW.approval_status);
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    INSERT INTO price_history (price_list_price_id, change_type, previous_price, new_price, changed_by, reason, approval_status_before, approval_status_after)
    VALUES (
      NEW.id,
      CASE
        WHEN NEW.approval_status != OLD.approval_status THEN 'approve'
        WHEN NEW.price != OLD.price THEN 'update'
        ELSE 'update'
      END,
      OLD.price,
      NEW.price,
      NEW.updated_by,
      CASE WHEN NEW.price != OLD.price THEN 'Price adjusted' ELSE NULL END,
      OLD.approval_status,
      NEW.approval_status
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO price_history (price_list_price_id, change_type, previous_price, new_price, changed_by, reason)
    VALUES (OLD.id, 'revoke', OLD.price, 0, OLD.updated_by, 'Price entry removed');
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_record_price_history ON price_list_prices;
CREATE TRIGGER trigger_record_price_history
  AFTER INSERT OR UPDATE OR DELETE ON price_list_prices
  FOR EACH ROW
  EXECUTE FUNCTION record_price_history();

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT SELECT ON master_prices TO medveris_runtime;
GRANT SELECT ON price_lists TO medveris_runtime;
GRANT SELECT ON price_list_prices TO medveris_runtime;
GRANT SELECT ON facility_price_overrides TO medveris_runtime;
GRANT SELECT ON department_price_overrides TO medveris_runtime;
GRANT SELECT ON price_history TO medveris_runtime;
GRANT SELECT ON facility_item_availability TO medveris_runtime;

GRANT REFERENCES ON master_prices TO medveris_runtime;
GRANT REFERENCES ON price_lists TO medveris_runtime;
GRANT REFERENCES ON price_list_prices TO medveris_runtime;

-- ============================================================================
-- FORCE ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE master_prices FORCE ROW LEVEL SECURITY;
ALTER TABLE price_lists FORCE ROW LEVEL SECURITY;
ALTER TABLE price_list_prices FORCE ROW LEVEL SECURITY;
ALTER TABLE facility_price_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE department_price_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE price_history FORCE ROW LEVEL SECURITY;
ALTER TABLE facility_item_availability FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- COMMENT
-- ============================================================================

COMMENT ON TABLE master_prices IS 'Global canonical price catalogue - managed by platform operators';
COMMENT ON TABLE price_lists IS 'Facility or regional price lists that adopt from master catalogue';
COMMENT ON TABLE price_list_prices IS 'Individual prices within a price list';
COMMENT ON TABLE facility_price_overrides IS 'Facility-specific price adjustments';
COMMENT ON TABLE department_price_overrides IS 'Department-specific price adjustments';
COMMENT ON TABLE price_history IS 'Audit trail for all price changes';
COMMENT ON TABLE facility_item_availability IS 'Tracks which items/services each facility offers';

COMMIT;
