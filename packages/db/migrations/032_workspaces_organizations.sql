-- Autonomous workspaces, optional parent organizations, scoped roles, procurement and
-- inter-site stock transfers.
--
-- A tenant is a workspace: a facility, a department or a service unit that can operate on its own.
-- The parent organization stays optional. Linking a workspace to an organization never moves or
-- copies records: every row keeps its tenant_id, so transaction, inventory, report, user and audit
-- history stays with the workspace. Organization staff see linked sites only through aggregate,
-- security-definer roll-ups, and only from the link's visible_from date unless the workspace
-- administrator explicitly grants earlier history. Patient-level records are never exposed to a
-- parent through a link.
--
-- Category, official level and Medveris equivalent are separate columns; an equivalent never
-- overwrites an official value. Additive only: every new column is nullable or defaulted, and the
-- replaced policies and functions accept every row and role the previous versions accepted.

BEGIN;

-- ---------------------------------------------------------------- organization role helper

CREATE TABLE organization_memberships (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('organization_owner','organization_admin','organization_reporting')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
  invited_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX organization_memberships_user_idx ON organization_memberships(user_id, status);

GRANT SELECT ON organization_memberships TO medveris_exchange;

-- The caller's active organization role, read without RLS so policies on the organization tables can use it.
CREATE FUNCTION app.organization_role(p_org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.role FROM organization_memberships m
   WHERE m.organization_id = p_org AND m.user_id = app.current_user() AND m.status = 'active'
   LIMIT 1
$$;
ALTER FUNCTION app.organization_role(uuid) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.organization_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.organization_role(uuid) TO medveris_runtime;

CREATE FUNCTION app.is_organization_admin(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(app.organization_role(p_org) IN ('organization_owner','organization_admin'), false)
$$;

-- ---------------------------------------------------------------- organizations

ALTER TABLE organizations
  ADD COLUMN kind text NOT NULL DEFAULT 'facility-group' CHECK (kind IN ('hospital','health-system','facility-group','faith-based-network','other')),
  ADD COLUMN ownership text CHECK (ownership IS NULL OR ownership IN ('private-for-profit','private-not-for-profit','public','other')),
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  ADD COLUMN contact_email text,
  ADD COLUMN created_by uuid REFERENCES users(id);

DROP POLICY organizations_read ON organizations;
CREATE POLICY organizations_read ON organizations FOR SELECT USING (true);
CREATE POLICY organizations_create ON organizations FOR INSERT
  WITH CHECK (app.current_user() IS NOT NULL OR app.actor_kind() = 'registration');
CREATE POLICY organizations_manage ON organizations FOR UPDATE
  USING (app.is_organization_admin(id)) WITH CHECK (app.is_organization_admin(id));

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_memberships_read ON organization_memberships FOR SELECT USING (
  user_id = app.current_user() OR app.organization_role(organization_id) IS NOT NULL
);
CREATE POLICY organization_memberships_write ON organization_memberships FOR INSERT WITH CHECK (
  app.is_organization_admin(organization_id)
  -- The creator of a new organization becomes its first owner.
  OR (role = 'organization_owner' AND user_id = app.current_user()
      AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = organization_id AND o.created_by IS DISTINCT FROM app.current_user()))
);
CREATE POLICY organization_memberships_update ON organization_memberships FOR UPDATE
  USING (app.is_organization_admin(organization_id)) WITH CHECK (app.is_organization_admin(organization_id));
GRANT SELECT, INSERT, UPDATE ON organization_memberships TO medveris_runtime;

-- Organization-level staff invitations (organization admins and reporting users).
CREATE TABLE organization_invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('organization_admin','organization_reporting')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_invitations_admin ON organization_invitations
  USING (app.is_organization_admin(organization_id)) WITH CHECK (app.is_organization_admin(organization_id));
CREATE POLICY organization_invitations_token_read ON organization_invitations FOR SELECT
  USING (token_hash = app.invitation_token_hash());
CREATE POLICY organization_invitations_token_update ON organization_invitations FOR UPDATE
  USING (token_hash = app.invitation_token_hash()) WITH CHECK (token_hash = app.invitation_token_hash());
GRANT SELECT, INSERT, UPDATE ON organization_invitations TO medveris_runtime;

-- The accepting user becomes a member through the invitation they hold.
CREATE POLICY organization_memberships_invited ON organization_memberships FOR INSERT WITH CHECK (
  user_id = app.current_user() AND EXISTS (
    SELECT 1 FROM organization_invitations i
     WHERE i.organization_id = organization_memberships.organization_id
       AND i.token_hash = app.invitation_token_hash() AND i.role = organization_memberships.role
  )
);

-- ---------------------------------------------------------------- workspace classification

ALTER TABLE tenants
  ADD COLUMN workspace_kind text NOT NULL DEFAULT 'facility' CHECK (workspace_kind IN ('facility','department','service-unit')),
  ADD COLUMN service_category text CHECK (service_category IS NULL OR service_category ~ '^[a-z][a-z-]{1,39}$'),
  ADD COLUMN service_subtype text CHECK (service_subtype IS NULL OR service_subtype ~ '^[a-z][a-z-]{1,39}$'),
  ADD COLUMN ownership text CHECK (ownership IS NULL OR ownership IN ('private-for-profit','private-not-for-profit','public','other')),
  ADD COLUMN level_status text NOT NULL DEFAULT 'not-yet-assigned'
    CHECK (level_status IN ('official','medveris-equivalent','not-applicable','not-yet-assigned')),
  ADD COLUMN official_level text CHECK (official_level IS NULL OR official_level IN
    ('hc1','hc2','hc3','hc4','general-hospital','regional-referral','national-referral')),
  ADD COLUMN official_level_source text CHECK (official_level_source IS NULL OR official_level_source IN
    ('nhfr','moh-registration','moh-licence','other-official')),
  ADD COLUMN official_level_reference text CHECK (official_level_reference IS NULL OR length(official_level_reference) BETWEEN 2 AND 200),
  ADD COLUMN equivalent_level text CHECK (equivalent_level IS NULL OR equivalent_level IN
    ('hc1','hc2','hc3','hc4','general-hospital','regional-referral','national-referral')),
  ADD COLUMN equivalent_justification text,
  ADD COLUMN level_updated_by uuid REFERENCES users(id),
  ADD COLUMN level_updated_at timestamptz,
  ADD COLUMN district text,
  ADD COLUMN region text,
  ADD COLUMN address text,
  -- A department or service unit that operates as its own workspace inside a registered host facility.
  ADD COLUMN host_tenant_id uuid REFERENCES tenants(id),
  ADD COLUMN enabled_modules text[] NOT NULL DEFAULT '{}',
  ADD COLUMN created_by uuid REFERENCES users(id),
  ADD CONSTRAINT tenants_official_level_complete CHECK (
    level_status <> 'official' OR (official_level IS NOT NULL AND official_level_source IS NOT NULL AND official_level_reference IS NOT NULL)
  ),
  ADD CONSTRAINT tenants_equivalent_level_complete CHECK (level_status <> 'medveris-equivalent' OR equivalent_level IS NOT NULL),
  ADD CONSTRAINT tenants_host_not_self CHECK (host_tenant_id IS NULL OR host_tenant_id <> id);

UPDATE tenants SET service_category = CASE
    WHEN facility_type ILIKE '%hospital%' THEN 'hospital'
    WHEN facility_type ILIKE '%pharm%' THEN 'pharmacy'
    WHEN facility_type ILIKE '%drug%' THEN 'drug-shop'
    WHEN facility_type ILIKE '%lab%' THEN 'laboratory'
    WHEN facility_type ILIKE '%dental%' THEN 'dental'
    WHEN facility_type ILIKE '%imaging%' OR facility_type ILIKE '%radiol%' THEN 'imaging'
    WHEN facility_type ILIKE '%eye%' OR facility_type ILIKE '%ophthal%' THEN 'ophthalmology'
    ELSE 'clinic'
  END
 WHERE service_category IS NULL;
UPDATE tenants SET level_status = 'not-applicable'
 WHERE service_category IN ('pharmacy','drug-shop','laboratory','dental','imaging','ophthalmology','specialty-service');

-- Every level value ever recorded, with who recorded it and why.
CREATE TABLE tenant_level_history (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_category text NOT NULL,
  service_subtype text,
  level_status text NOT NULL,
  official_level text,
  official_level_source text,
  official_level_reference text,
  equivalent_level text,
  equivalent_justification text,
  reason text,
  recorded_by uuid REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_level_history_idx ON tenant_level_history(tenant_id, recorded_at DESC);

-- Regulator and registry identifiers, kept separate from the care level.
CREATE TABLE facility_registrations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z-]{1,39}$'),
  issuer text,
  identifier text NOT NULL CHECK (length(identifier) BETWEEN 1 AND 120),
  valid_from date,
  valid_until date,
  status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','verified','expired','withdrawn')),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  recorded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX facility_registrations_tenant_idx ON facility_registrations(tenant_id, kind);
-- One live workspace per NHFR ID, so a facility cannot be onboarded twice by accident.
CREATE UNIQUE INDEX facility_registrations_nhfr_unique ON facility_registrations(lower(identifier))
  WHERE kind = 'nhfr-id' AND status <> 'withdrawn';

ALTER TABLE departments ADD COLUMN service_category text CHECK (service_category IS NULL OR service_category ~ '^[a-z][a-z-]{1,39}$');
ALTER TABLE units ADD COLUMN service_category text CHECK (service_category IS NULL OR service_category ~ '^[a-z][a-z-]{1,39}$');

-- ---------------------------------------------------------------- scoped memberships

ALTER TABLE memberships
  ADD COLUMN scope_department_id uuid REFERENCES departments(id),
  ADD COLUMN scope_unit_id uuid REFERENCES units(id);
ALTER TABLE invitations
  ADD COLUMN scope_department_id uuid REFERENCES departments(id),
  ADD COLUMN scope_unit_id uuid REFERENCES units(id);

-- ---------------------------------------------------------------- organization links

CREATE TABLE organization_links (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','withdrawn','ended')),
  origin text NOT NULL CHECK (origin IN ('created-by-organization','join-request','backfill')),
  join_code_id uuid,
  requested_by uuid REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  duplicate_findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  duplicate_resolution text,
  -- Aggregate roll-ups include this site's activity from visible_from; NULL means full history was granted.
  history_visibility text NOT NULL DEFAULT 'from-link-date' CHECK (history_visibility IN ('from-link-date','full-history')),
  history_granted_by uuid REFERENCES users(id),
  history_granted_at timestamptz,
  visible_from timestamptz,
  inventory_mode text NOT NULL DEFAULT 'independent' CHECK (inventory_mode IN ('independent','shared-supply')),
  inventory_mode_proposed text CHECK (inventory_mode_proposed IS NULL OR inventory_mode_proposed IN ('independent','shared-supply')),
  inventory_mode_proposed_by uuid REFERENCES users(id),
  inventory_mode_accepted_by uuid REFERENCES users(id),
  inventory_mode_changed_at timestamptz,
  ended_by uuid REFERENCES users(id),
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR decided_at IS NOT NULL),
  CHECK (status <> 'ended' OR ended_at IS NOT NULL),
  CHECK (history_visibility <> 'full-history' OR visible_from IS NULL)
);
CREATE UNIQUE INDEX organization_links_one_live ON organization_links(tenant_id) WHERE status IN ('pending','active');
CREATE INDEX organization_links_org_idx ON organization_links(organization_id, status);

CREATE TABLE organization_link_events (
  id uuid PRIMARY KEY,
  link_id uuid NOT NULL REFERENCES organization_links(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN (
    'requested','approved','rejected','withdrawn','history-granted','inventory-mode-proposed',
    'inventory-mode-accepted','inventory-mode-declined','ended','site-created'
  )),
  actor_user_id uuid REFERENCES users(id),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_link_events_idx ON organization_link_events(organization_id, occurred_at DESC);
CREATE TRIGGER organization_link_events_append_only BEFORE UPDATE OR DELETE ON organization_link_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_append_only_mutation();

-- Join codes that an organization gives to an independent workspace; one use by default.
CREATE TABLE organization_join_codes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  label text NOT NULL CHECK (length(label) BETWEEN 2 AND 200),
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 100),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (uses <= max_uses)
);
ALTER TABLE organization_links ADD CONSTRAINT organization_links_join_code_fk FOREIGN KEY (join_code_id) REFERENCES organization_join_codes(id);

INSERT INTO organization_links (id, organization_id, tenant_id, status, origin, decided_at, history_visibility, visible_from, decision_note)
SELECT gen_random_uuid(), t.organization_id, t.id, 'active', 'backfill', now(), 'full-history', NULL,
       'Existing organization assignment recorded before workspace linking existed'
  FROM tenants t WHERE t.organization_id IS NOT NULL;

ALTER TABLE organization_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_links FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_links_read ON organization_links FOR SELECT USING (
  (tenant_id = app.current_tenant() AND app.actor_kind() = 'staff') OR app.organization_role(organization_id) IS NOT NULL
);
CREATE POLICY organization_links_insert ON organization_links FOR INSERT WITH CHECK (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin'])) OR app.is_organization_admin(organization_id)
);
CREATE POLICY organization_links_update ON organization_links FOR UPDATE USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin'])) OR app.is_organization_admin(organization_id)
) WITH CHECK (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin'])) OR app.is_organization_admin(organization_id)
);
GRANT SELECT, INSERT, UPDATE ON organization_links TO medveris_runtime;
GRANT SELECT ON organization_links TO medveris_exchange;

ALTER TABLE organization_link_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_link_events FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_link_events_read ON organization_link_events FOR SELECT USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','auditor'])) OR app.organization_role(organization_id) IS NOT NULL
);
CREATE POLICY organization_link_events_insert ON organization_link_events FOR INSERT WITH CHECK (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin'])) OR app.is_organization_admin(organization_id)
);
GRANT SELECT, INSERT ON organization_link_events TO medveris_runtime;

ALTER TABLE organization_join_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_join_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_join_codes_admin ON organization_join_codes
  USING (app.is_organization_admin(organization_id)) WITH CHECK (app.is_organization_admin(organization_id));
-- A workspace administrator presenting the code sees and consumes exactly that code.
CREATE POLICY organization_join_codes_holder_read ON organization_join_codes FOR SELECT
  USING (code_hash = app.invitation_token_hash());
CREATE POLICY organization_join_codes_holder_use ON organization_join_codes FOR UPDATE
  USING (code_hash = app.invitation_token_hash()) WITH CHECK (code_hash = app.invitation_token_hash());
GRANT SELECT, INSERT, UPDATE ON organization_join_codes TO medveris_runtime;

-- Sites of an organization, for any organization member; no patient or transaction data.
CREATE FUNCTION app.organization_sites(p_org uuid)
RETURNS TABLE (
  link_id uuid, tenant_id uuid, name text, workspace_kind text, service_category text, service_subtype text,
  ownership text, level_status text, official_level text, official_level_source text, official_level_reference text,
  equivalent_level text, city text, district text, host_tenant_id uuid, status text, origin text,
  history_visibility text, visible_from timestamptz, inventory_mode text, inventory_mode_proposed text,
  duplicate_findings jsonb, requested_at timestamptz, decided_at timestamptz, registrations jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id, t.id, t.name, t.workspace_kind, t.service_category, t.service_subtype, t.ownership, t.level_status,
         t.official_level, t.official_level_source, t.official_level_reference, t.equivalent_level, t.city, t.district,
         t.host_tenant_id, l.status, l.origin, l.history_visibility, l.visible_from, l.inventory_mode,
         l.inventory_mode_proposed, l.duplicate_findings, l.requested_at, l.decided_at,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', r.kind, 'identifier', r.identifier, 'status', r.status) ORDER BY r.kind)
                     FROM facility_registrations r WHERE r.tenant_id = t.id AND r.status <> 'withdrawn'), '[]'::jsonb)
    FROM organization_links l JOIN tenants t ON t.id = l.tenant_id
   WHERE l.organization_id = p_org AND l.status IN ('pending','active')
     AND app.organization_role(p_org) IS NOT NULL
   ORDER BY t.name
$$;

-- Existing sites of an organization that may be the same place as a joining workspace: the same
-- normalised name, or a shared registry/licence identifier. Names only; used to stop accidental duplicates.
CREATE FUNCTION app.organization_duplicate_candidates(p_org uuid, p_tenant uuid)
RETURNS TABLE (tenant_id uuid, name text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH allowed AS (
    SELECT 1 WHERE (p_tenant = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin'])) OR app.organization_role(p_org) IS NOT NULL
  ),
  me AS (SELECT lower(regexp_replace(t.name, '[^a-zA-Z0-9]+', '', 'g')) AS norm FROM tenants t, allowed WHERE t.id = p_tenant),
  sites AS (
    SELECT t.id, t.name, lower(regexp_replace(t.name, '[^a-zA-Z0-9]+', '', 'g')) AS norm
      FROM organization_links l JOIN tenants t ON t.id = l.tenant_id
     WHERE l.organization_id = p_org AND l.status IN ('pending','active') AND l.tenant_id <> p_tenant
  )
  SELECT s.id, s.name, 'same name' FROM sites s JOIN me ON me.norm = s.norm
  UNION
  SELECT s.id, s.name, 'shared ' || r.kind || ' identifier'
    FROM sites s
    JOIN facility_registrations r ON r.tenant_id = s.id AND r.status <> 'withdrawn'
    JOIN facility_registrations mine ON mine.tenant_id = p_tenant AND mine.status <> 'withdrawn'
         AND mine.kind = r.kind AND lower(mine.identifier) = lower(r.identifier)
    JOIN allowed ON true
$$;

-- ---------------------------------------------------------------- department attribution

ALTER TABLE invoices
  ADD COLUMN department_id uuid REFERENCES departments(id),
  ADD COLUMN unit_id uuid REFERENCES units(id);
CREATE INDEX invoices_department_idx ON invoices(tenant_id, department_id, created_at);
ALTER TABLE encounters
  ADD COLUMN department_id uuid REFERENCES departments(id),
  ADD COLUMN unit_id uuid REFERENCES units(id);
CREATE INDEX encounters_department_idx ON encounters(tenant_id, department_id, opened_at);

-- ---------------------------------------------------------------- procurement

CREATE TABLE suppliers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  contact_name text,
  phone text,
  email text,
  address text,
  tax_id text,
  licence_reference text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  po_number text NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  department_id uuid REFERENCES departments(id),
  unit_id uuid REFERENCES units(id),
  destination_location_id uuid NOT NULL REFERENCES inventory_locations(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','partially-received','received','cancelled')),
  currency text NOT NULL DEFAULT 'UGX' CHECK (currency ~ '^[A-Z]{3}$'),
  expected_on date,
  notes text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  submitted_by uuid REFERENCES users(id),
  submitted_at timestamptz,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  cancelled_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, po_number),
  CHECK (status NOT IN ('approved','partially-received','received') OR approved_by IS NOT NULL),
  CHECK (status <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE INDEX purchase_orders_tenant_status_idx ON purchase_orders(tenant_id, status, created_at DESC);

CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  unit text NOT NULL,
  quantity_ordered numeric(18,4) NOT NULL CHECK (quantity_ordered > 0),
  unit_price numeric(18,4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  quantity_received numeric(18,4) NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (quantity_received <= quantity_ordered)
);
CREATE INDEX purchase_order_lines_po_idx ON purchase_order_lines(purchase_order_id);

-- ---------------------------------------------------------------- inter-site stock transfers

-- Stock leaves the source site's books on dispatch (transfer-out) and enters the destination site's
-- books on receipt (transfer-in); each site posts only to its own ledger. Allowed only between sites
-- whose links to the same organization are both in shared-supply mode.
CREATE TABLE organization_stock_transfers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  transfer_number text NOT NULL UNIQUE,
  source_tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_location_id uuid NOT NULL REFERENCES inventory_locations(id),
  source_item_id uuid NOT NULL REFERENCES inventory_items(id),
  destination_tenant_id uuid NOT NULL REFERENCES tenants(id),
  destination_location_id uuid REFERENCES inventory_locations(id),
  destination_item_id uuid REFERENCES inventory_items(id),
  item_code text NOT NULL,
  item_name text NOT NULL,
  lot_number text,
  expires_on date,
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  base_quantity numeric(18,4) NOT NULL CHECK (base_quantity > 0),
  status text NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched','received','cancelled')),
  reason text NOT NULL,
  dispatched_by uuid NOT NULL REFERENCES users(id),
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  dispatch_movement_id uuid NOT NULL REFERENCES inventory_movements(id),
  received_by uuid REFERENCES users(id),
  received_at timestamptz,
  received_quantity numeric(18,4),
  receipt_movement_id uuid REFERENCES inventory_movements(id),
  discrepancy_note text,
  CHECK (source_tenant_id <> destination_tenant_id),
  CHECK (status <> 'received' OR (received_by IS NOT NULL AND receipt_movement_id IS NOT NULL AND destination_location_id IS NOT NULL))
);
CREATE INDEX organization_stock_transfers_source_idx ON organization_stock_transfers(source_tenant_id, status);
CREATE INDEX organization_stock_transfers_destination_idx ON organization_stock_transfers(destination_tenant_id, status);

GRANT SELECT ON tenants TO medveris_exchange;

-- Organization that both sites belong to in shared-supply mode, or NULL.
CREATE FUNCTION app.shared_supply_organization(p_source uuid, p_destination uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.organization_id FROM organization_links a JOIN organization_links b ON b.organization_id = a.organization_id
   WHERE a.tenant_id = p_source AND b.tenant_id = p_destination
     AND a.status = 'active' AND b.status = 'active'
     AND a.inventory_mode = 'shared-supply' AND b.inventory_mode = 'shared-supply'
     AND p_source = app.current_tenant()
   LIMIT 1
$$;

-- Other shared-supply sites the active site can dispatch to.
CREATE FUNCTION app.shared_supply_sites(p_tenant uuid)
RETURNS TABLE (tenant_id uuid, name text, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.tenant_id, t.name, a.organization_id
    FROM organization_links a
    JOIN organization_links b ON b.organization_id = a.organization_id AND b.tenant_id <> a.tenant_id
    JOIN tenants t ON t.id = b.tenant_id
   WHERE a.tenant_id = p_tenant AND p_tenant = app.current_tenant()
     AND a.status = 'active' AND b.status = 'active' AND t.status = 'active'
     AND a.inventory_mode = 'shared-supply' AND b.inventory_mode = 'shared-supply'
   ORDER BY t.name
$$;

-- ---------------------------------------------------------------- new scoped roles in RLS

CREATE OR REPLACE FUNCTION app.is_inventory_staff() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.actor_kind() = 'staff' AND app.has_any_role(ARRAY[
    'facility_admin','pharmacist','biomedical','housekeeping','laboratory','radiology',
    'cssd','theatre','nurse','midwife','clinician','specialist_clinician','department_lead',
    'finance','auditor','hr','records','quality','porter','mortuary','it_admin','receptionist',
    'owner','department_admin','unit_lead','staff','report_viewer'
  ])
$$;

DROP POLICY departments_read ON departments;
CREATE POLICY departments_read ON departments USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin','clinician','nurse','records','theatre','housekeeping','porter','mortuary','cssd','biomedical','quality','it_admin',
    'owner','department_admin','unit_lead','staff','report_viewer','auditor','pharmacist','laboratory','radiology','finance','receptionist'])
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin'])
);
DROP POLICY units_read ON units;
CREATE POLICY units_read ON units USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin','clinician','nurse','records','theatre','housekeeping','porter','mortuary','cssd','biomedical','quality','it_admin',
    'owner','department_admin','unit_lead','staff','report_viewer','auditor','pharmacist','laboratory','radiology','finance','receptionist'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['hr','facility_admin','department_admin']));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers','purchase_orders','purchase_order_lines','tenant_level_history','facility_registrations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['suppliers','purchase_orders','purchase_order_lines'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant() AND app.is_inventory_staff()) WITH CHECK (tenant_id = app.current_tenant() AND app.is_inventory_staff())', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON suppliers, purchase_orders, purchase_order_lines TO medveris_runtime;

CREATE POLICY tenant_level_history_read ON tenant_level_history FOR SELECT
  USING (tenant_id = app.current_tenant() AND app.actor_kind() = 'staff');
CREATE POLICY tenant_level_history_insert ON tenant_level_history FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant() AND (app.has_any_role(ARRAY['facility_admin']) OR app.actor_kind() = 'registration'));
CREATE TRIGGER tenant_level_history_append_only BEFORE UPDATE OR DELETE ON tenant_level_history
  FOR EACH ROW EXECUTE FUNCTION app.reject_append_only_mutation();
GRANT SELECT, INSERT ON tenant_level_history TO medveris_runtime;

CREATE POLICY facility_registrations_read ON facility_registrations FOR SELECT
  USING (tenant_id = app.current_tenant() AND app.actor_kind() = 'staff');
CREATE POLICY facility_registrations_write ON facility_registrations FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant() AND (app.has_any_role(ARRAY['facility_admin']) OR app.actor_kind() = 'registration'));
CREATE POLICY facility_registrations_update ON facility_registrations FOR UPDATE
  USING (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin']))
  WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin']));
GRANT SELECT, INSERT, UPDATE ON facility_registrations TO medveris_runtime;
GRANT SELECT ON facility_registrations TO medveris_exchange;

ALTER TABLE organization_stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_stock_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_stock_transfers_read ON organization_stock_transfers FOR SELECT USING (
  (source_tenant_id = app.current_tenant() OR destination_tenant_id = app.current_tenant()) AND app.is_inventory_staff()
);
CREATE POLICY organization_stock_transfers_dispatch ON organization_stock_transfers FOR INSERT WITH CHECK (
  source_tenant_id = app.current_tenant() AND app.is_inventory_staff()
  AND app.shared_supply_organization(source_tenant_id, destination_tenant_id) = organization_id
);
CREATE POLICY organization_stock_transfers_update ON organization_stock_transfers FOR UPDATE USING (
  (source_tenant_id = app.current_tenant() OR destination_tenant_id = app.current_tenant()) AND app.is_inventory_staff()
) WITH CHECK (
  (source_tenant_id = app.current_tenant() OR destination_tenant_id = app.current_tenant()) AND app.is_inventory_staff()
);
GRANT SELECT, INSERT, UPDATE ON organization_stock_transfers TO medveris_runtime;

-- ---------------------------------------------------------------- consolidated roll-ups

-- Aggregate activity of an organization's active sites for any organization member. Counts and amounts
-- only; never patient-level rows. Activity before a site's visible_from date is excluded unless the
-- site administrator granted full history.
CREATE FUNCTION app.organization_site_metrics(p_org uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (tenant_id uuid, department_id uuid, department_name text, metric text, value numeric, visible_from timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH sites AS (
    SELECT l.tenant_id, l.visible_from, GREATEST(p_from, COALESCE(l.visible_from, '-infinity'::timestamptz)) AS from_at
      FROM organization_links l
     WHERE l.organization_id = p_org AND l.status = 'active' AND app.organization_role(p_org) IS NOT NULL
  ),
  metrics (tenant_id, department_id, metric, value, visible_from) AS (
    SELECT s.tenant_id, NULL::uuid, 'registrations', count(x.*)::numeric, s.visible_from
      FROM sites s LEFT JOIN tenant_patient_links x ON x.tenant_id = s.tenant_id AND x.created_at >= s.from_at AND x.created_at < p_to
     GROUP BY s.tenant_id, s.visible_from
    UNION ALL
    SELECT s.tenant_id, e.department_id, 'encounters-opened', count(e.id)::numeric, s.visible_from
      FROM sites s JOIN encounters e ON e.tenant_id = s.tenant_id AND e.opened_at >= s.from_at AND e.opened_at < p_to
     GROUP BY s.tenant_id, e.department_id, s.visible_from
    UNION ALL
    SELECT s.tenant_id, e.department_id, 'encounters-completed', count(e.id)::numeric, s.visible_from
      FROM sites s JOIN encounters e ON e.tenant_id = s.tenant_id AND e.state = 'completed' AND e.closed_at >= s.from_at AND e.closed_at < p_to
     GROUP BY s.tenant_id, e.department_id, s.visible_from
    UNION ALL
    SELECT s.tenant_id, NULL::uuid, 'admissions', count(a.id)::numeric, s.visible_from
      FROM sites s JOIN admissions a ON a.tenant_id = s.tenant_id AND a.status <> 'cancelled' AND a.admitted_at >= s.from_at AND a.admitted_at < p_to
     GROUP BY s.tenant_id, s.visible_from
    UNION ALL
    SELECT s.tenant_id, NULL::uuid, 'inpatient-deaths', count(a.id)::numeric, s.visible_from
      FROM sites s JOIN admissions a ON a.tenant_id = s.tenant_id AND a.status = 'deceased' AND a.discharged_at >= s.from_at AND a.discharged_at < p_to
     GROUP BY s.tenant_id, s.visible_from
    UNION ALL
    SELECT s.tenant_id, NULL::uuid, 'deliveries', count(m.id)::numeric, s.visible_from
      FROM sites s JOIN maternity_episodes m ON m.tenant_id = s.tenant_id AND m.delivered_at >= s.from_at AND m.delivered_at < p_to
     GROUP BY s.tenant_id, s.visible_from
    UNION ALL
    SELECT s.tenant_id, NULL::uuid, CASE o.order_type WHEN 'laboratory' THEN 'laboratory-orders' WHEN 'imaging' THEN 'imaging-orders' ELSE 'other-orders' END,
           count(o.id)::numeric, s.visible_from
      FROM sites s JOIN service_orders o ON o.tenant_id = s.tenant_id AND o.status <> 'cancelled' AND o.created_at >= s.from_at AND o.created_at < p_to
     GROUP BY s.tenant_id, o.order_type, s.visible_from
    UNION ALL
    SELECT s.tenant_id, i.department_id, 'amount-billed', COALESCE(sum(ii.amount), 0), s.visible_from
      FROM sites s JOIN invoices i ON i.tenant_id = s.tenant_id AND i.status <> 'void' AND i.created_at >= s.from_at AND i.created_at < p_to
      JOIN invoice_items ii ON ii.invoice_id = i.id
     GROUP BY s.tenant_id, i.department_id, s.visible_from
    UNION ALL
    SELECT s.tenant_id, i.department_id, 'amount-received', COALESCE(sum(p.amount), 0), s.visible_from
      FROM sites s JOIN payments p ON p.tenant_id = s.tenant_id AND p.reversed_at IS NULL AND p.received_at >= s.from_at AND p.received_at < p_to
      JOIN invoices i ON i.id = p.invoice_id
     GROUP BY s.tenant_id, i.department_id, s.visible_from
    UNION ALL
    SELECT s.tenant_id, COALESCE(dl.department_id, sl.department_id), 'stock-movements', count(mv.id)::numeric, s.visible_from
      FROM sites s JOIN inventory_movements mv ON mv.tenant_id = s.tenant_id AND mv.occurred_at >= s.from_at AND mv.occurred_at < p_to
      LEFT JOIN inventory_locations dl ON dl.id = mv.destination_location_id
      LEFT JOIN inventory_locations sl ON sl.id = mv.source_location_id
     GROUP BY s.tenant_id, COALESCE(dl.department_id, sl.department_id), s.visible_from
    UNION ALL
    SELECT s.tenant_id, loc.department_id, 'low-stock-lines', count(*)::numeric, s.visible_from
      FROM sites s JOIN inventory_location_policies pol ON pol.tenant_id = s.tenant_id
      JOIN inventory_locations loc ON loc.id = pol.location_id
     WHERE pol.minimum_quantity > COALESCE((SELECT sum(b.on_hand - b.reserved - b.quarantined) FROM inventory_balances b
                                             WHERE b.location_id = pol.location_id AND b.item_id = pol.item_id), 0)
     GROUP BY s.tenant_id, loc.department_id, s.visible_from
    UNION ALL
    SELECT s.tenant_id, NULL::uuid, 'lots-expiring-90-days', count(*)::numeric, s.visible_from
      FROM sites s JOIN inventory_lots lot ON lot.tenant_id = s.tenant_id AND lot.status = 'available'
       AND lot.expires_on IS NOT NULL AND lot.expires_on < current_date + 90
       AND EXISTS (SELECT 1 FROM inventory_balances b WHERE b.lot_id = lot.id AND b.on_hand > 0)
     GROUP BY s.tenant_id, s.visible_from
  )
  SELECT m.tenant_id, m.department_id, d.name, m.metric, m.value, m.visible_from
    FROM metrics m LEFT JOIN departments d ON d.id = m.department_id
$$;

GRANT SELECT ON tenant_patient_links, encounters, admissions, maternity_episodes, service_orders, invoices, invoice_items, departments,
  payments, inventory_movements, inventory_locations, inventory_location_policies, inventory_balances, inventory_lots
  TO medveris_exchange;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'app.organization_sites(uuid)',
    'app.organization_duplicate_candidates(uuid, uuid)',
    'app.shared_supply_organization(uuid, uuid)',
    'app.shared_supply_sites(uuid)',
    'app.organization_site_metrics(uuid, timestamptz, timestamptz)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO medveris_exchange', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO medveris_runtime', f);
  END LOOP;
END $$;

COMMIT;
