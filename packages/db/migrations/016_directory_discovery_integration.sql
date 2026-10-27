-- Public provider directory, geographic discovery, sponsored placement and
-- hospital integration clients. Public listing data is deliberately separate
-- from tenant operations; an unclaimed listing never creates a tenant.
BEGIN;

CREATE OR REPLACE FUNCTION app.is_platform_operator() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.platform_role', true), ''), '') = 'platform_operator';
$$;

-- Public directory -----------------------------------------------------------
CREATE TABLE directory_facilities (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  facility_type text NOT NULL CHECK (facility_type IN (
    'hospital','clinic','health-centre','diagnostic-centre','pharmacy',
    'dental','eye','mental-health','rehabilitation','maternity','other'
  )),
  description text,
  country text NOT NULL,
  region text,
  district text,
  locality text,
  public_phone text,
  public_email text,
  website text,
  medveris_participation text NOT NULL DEFAULT 'none' CHECK (medveris_participation IN ('none','direct','connected')),
  integration_state text NOT NULL DEFAULT 'none' CHECK (integration_state IN ('none','sandbox','production')),
  publication_status text NOT NULL DEFAULT 'draft' CHECK (publication_status IN (
    'draft','pending-review','published','suspended','archived'
  )),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','relocated','merged')),
  claimed_tenant_id uuid REFERENCES tenants(id),
  claimed_by_user_id uuid REFERENCES users(id),
  credential_status text NOT NULL DEFAULT 'unverified' CHECK (credential_status IN (
    'unverified','submitted','verified','expired'
  )),
  capability_status text NOT NULL DEFAULT 'none' CHECK (capability_status IN (
    'none','declared','documented','verified'
  )),
  source_kind text NOT NULL DEFAULT 'facility-submitted' CHECK (source_kind IN (
    'authoritative-import','facility-submitted','claim','medveris-registered'
  )),
  source_name text,
  source_url text,
  source_license text,
  source_retrieved_on date,
  last_confirmed_on date,
  next_confirmation_on date,
  suspended_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_kind <> 'authoritative-import' OR source_license IS NOT NULL),
  CHECK (claimed_tenant_id IS NULL OR claimed_by_user_id IS NOT NULL)
);
CREATE INDEX directory_facilities_geo_idx ON directory_facilities(publication_status, status, country, region, district);
CREATE INDEX directory_facilities_tenant_idx ON directory_facilities(claimed_tenant_id);

CREATE TABLE directory_branches (
  id uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES directory_facilities(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  address_line1 text,
  address_line2 text,
  city text,
  region text,
  district text,
  locality text,
  country text NOT NULL,
  latitude numeric(9,6) CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
  longitude numeric(9,6) CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
  coordinate_source text NOT NULL DEFAULT 'unknown' CHECK (coordinate_source IN (
    'unknown','facility-supplied','authorized-correction','third-party-derived','map-pin'
  )),
  location_status text NOT NULL DEFAULT 'unconfirmed' CHECK (location_status IN (
    'unconfirmed','confirmed','disputed'
  )),
  public_phone text,
  public_email text,
  website text,
  opening_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  opening_exceptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  accessibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','relocated')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, name)
);
CREATE INDEX directory_branches_coords_idx ON directory_branches(latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
CREATE INDEX directory_branches_facility_idx ON directory_branches(facility_id, status);

CREATE TABLE directory_services (
  id uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES directory_facilities(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES directory_branches(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN (
    'outpatient','inpatient','emergency','maternal','child-health','diagnostics',
    'pharmacy','dental','eye','mental-health','rehabilitation','surgery','other'
  )),
  description text,
  availability_note text,
  public_contact text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, code)
);
CREATE INDEX directory_services_category_idx ON directory_services(facility_id, category, status);

CREATE TABLE directory_capabilities (
  id uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES directory_facilities(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'declared' CHECK (status IN (
    'declared','documented','verified','suspended'
  )),
  evidence_source text,
  verified_at timestamptz,
  verified_by uuid REFERENCES users(id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, code)
);

CREATE TABLE directory_claims (
  id uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES directory_facilities(id) ON DELETE CASCADE,
  claimant_user_id uuid NOT NULL REFERENCES users(id),
  claimant_tenant_id uuid REFERENCES tenants(id),
  representative_name text NOT NULL,
  role_title text NOT NULL,
  email text NOT NULL,
  phone text,
  authority_basis text NOT NULL,
  evidence text,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN (
    'submitted','under-review','verified','rejected','withdrawn'
  )),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX directory_claims_facility_idx ON directory_claims(facility_id, status);
CREATE INDEX directory_claims_user_idx ON directory_claims(claimant_user_id, created_at);

CREATE TABLE directory_events (
  id uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES directory_facilities(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  actor_tenant_id uuid REFERENCES tenants(id),
  note text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX directory_events_facility_idx ON directory_events(facility_id, occurred_at);

CREATE TABLE directory_duplicate_reviews (
  id uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES directory_facilities(id) ON DELETE CASCADE,
  candidate_facility_id uuid NOT NULL REFERENCES directory_facilities(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','merged','rejected')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (facility_id <> candidate_facility_id)
);

CREATE TABLE directory_reports (
  id uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES directory_facilities(id) ON DELETE CASCADE,
  report_type text NOT NULL CHECK (report_type IN ('abuse','closed','relocated','location','other')),
  detail text NOT NULL,
  reporter_user_id uuid REFERENCES users(id),
  reporter_contact text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolution text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX directory_reports_status_idx ON directory_reports(status, created_at);

CREATE TABLE directory_confirmations (
  id uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES directory_facilities(id) ON DELETE CASCADE,
  confirmed_by uuid NOT NULL REFERENCES users(id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  next_due_on date,
  evidence text,
  note text
);

CREATE TABLE directory_edit_requests (
  id uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES directory_facilities(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sponsored placement --------------------------------------------------------
CREATE TABLE sponsored_packages (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  price numeric(18,2) NOT NULL CHECK (price >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  duration_days integer NOT NULL CHECK (duration_days > 0),
  eligible_countries text[] NOT NULL DEFAULT '{}',
  eligible_facility_types text[] NOT NULL DEFAULT '{}',
  eligible_service_categories text[] NOT NULL DEFAULT '{}',
  placement_surface text NOT NULL CHECK (placement_surface IN (
    'search','featured-card','map','category'
  )),
  sponsored_slots integer NOT NULL DEFAULT 1 CHECK (sponsored_slots > 0),
  max_active_per_facility integer NOT NULL DEFAULT 1 CHECK (max_active_per_facility > 0),
  requirements text,
  cancellation_policy text,
  starts_on date,
  ends_on date,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE sponsored_campaigns (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES sponsored_packages(id),
  facility_id uuid NOT NULL REFERENCES directory_facilities(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES directory_branches(id) ON DELETE SET NULL,
  package_name_snapshot text NOT NULL,
  amount_snapshot numeric(18,2) NOT NULL CHECK (amount_snapshot >= 0),
  currency_snapshot text NOT NULL CHECK (currency_snapshot ~ '^[A-Z]{3}$'),
  duration_days_snapshot integer NOT NULL CHECK (duration_days_snapshot > 0),
  placement_surface text NOT NULL CHECK (placement_surface IN ('search','featured-card','map','category')),
  sponsored_slots integer NOT NULL DEFAULT 1 CHECK (sponsored_slots > 0),
  scope_country text,
  scope_region text,
  scope_district text,
  scope_locality text,
  service_categories text[] NOT NULL DEFAULT '{}',
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','pending-review','approved','scheduled','active','paused','expired','cancelled','rejected'
  )),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN (
    'unpaid','pending','paid','refunded','waived'
  )),
  editorial_status text NOT NULL DEFAULT 'pending' CHECK (editorial_status IN (
    'pending','approved','rejected'
  )),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  decision_reason text,
  paused_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX sponsored_campaigns_scope_idx ON sponsored_campaigns(status, placement_surface, starts_on, ends_on);
CREATE INDEX sponsored_campaigns_facility_idx ON sponsored_campaigns(facility_id, created_at);

CREATE TABLE sponsored_payments (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES sponsored_campaigns(id) ON DELETE CASCADE,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  method text NOT NULL CHECK (method IN ('manual','bank-transfer','mobile-money','card')),
  provider text,
  provider_reference text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed','refunded')),
  idempotency_key text NOT NULL UNIQUE,
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sponsored_payments_campaign_idx ON sponsored_payments(campaign_id, status);

CREATE TABLE sponsored_payment_events (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES sponsored_payments(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_event_id text NOT NULL,
  signature_verified boolean NOT NULL,
  payload_digest text,
  status text NOT NULL CHECK (status IN ('received','applied','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_event_id)
);

CREATE TABLE sponsored_daily_metrics (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES sponsored_campaigns(id) ON DELETE CASCADE,
  facility_id uuid NOT NULL REFERENCES directory_facilities(id) ON DELETE CASCADE,
  metric_date date NOT NULL,
  surface text NOT NULL CHECK (surface IN ('search','featured-card','map','category','detail')),
  impressions integer NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  detail_opens integer NOT NULL DEFAULT 0 CHECK (detail_opens >= 0),
  pin_interactions integer NOT NULL DEFAULT 0 CHECK (pin_interactions >= 0),
  contact_clicks integer NOT NULL DEFAULT 0 CHECK (contact_clicks >= 0),
  directions_clicks integer NOT NULL DEFAULT 0 CHECK (directions_clicks >= 0),
  booking_initiations integer NOT NULL DEFAULT 0 CHECK (booking_initiations >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, metric_date, surface)
);

-- Hospital integration platform ---------------------------------------------
CREATE TABLE api_products (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  service_family text NOT NULL,
  data_classification text NOT NULL CHECK (data_classification IN (
    'none','aggregate','directory','clinical'
  )),
  required_scopes text[] NOT NULL DEFAULT '{}',
  rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute > 0),
  daily_quota integer NOT NULL DEFAULT 10000 CHECK (daily_quota > 0),
  support_level text NOT NULL DEFAULT 'standard',
  sandbox_available boolean NOT NULL DEFAULT true,
  commercial_status text NOT NULL DEFAULT 'undecided' CHECK (commercial_status IN (
    'included','undecided','paid'
  )),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_clients (
  id uuid PRIMARY KEY,
  client_id text NOT NULL UNIQUE,
  client_secret_hash text NOT NULL,
  name text NOT NULL,
  organization text NOT NULL,
  tenant_id uuid REFERENCES tenants(id),
  environment text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox','production')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','active','suspended','revoked'
  )),
  scopes text[] NOT NULL DEFAULT '{}',
  products text[] NOT NULL DEFAULT '{}',
  callback_url text,
  technical_contact text NOT NULL,
  privacy_contact text,
  incident_contact text,
  existing_vendor text,
  intended_use text NOT NULL,
  patient_populations text[] NOT NULL DEFAULT '{}',
  processing_locations text[] NOT NULL DEFAULT '{}',
  supported_standards text[] NOT NULL DEFAULT '{}',
  legal_basis text,
  data_sharing_notes text,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  last_used_at timestamptz,
  secret_rotated_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_clients_status_idx ON integration_clients(status, environment);

CREATE TABLE integration_tokens (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES integration_clients(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{}',
  audience text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_tokens_client_idx ON integration_tokens(client_id, expires_at);

CREATE TABLE partner_patient_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES integration_clients(id) ON DELETE CASCADE,
  external_system text NOT NULL,
  external_identifier text NOT NULL,
  source_version text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unlinked','superseded')),
  linked_by_user_id uuid REFERENCES users(id),
  linked_at timestamptz NOT NULL DEFAULT now(),
  unlinked_at timestamptz,
  unlink_reason text,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX partner_patient_links_active_unique
  ON partner_patient_links(client_id, external_system, external_identifier)
  WHERE status = 'active';
CREATE INDEX partner_patient_links_patient_idx ON partner_patient_links(tenant_id, patient_id, status);

CREATE TABLE integration_delivery_events (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  client_id uuid REFERENCES integration_clients(id),
  event_type text NOT NULL,
  external_event_id text NOT NULL,
  payload_digest text NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN (
    'received','processed','failed','dead-letter'
  )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (tenant_id, client_id, event_type, external_event_id)
);

CREATE TRIGGER directory_events_immutable BEFORE UPDATE OR DELETE ON directory_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();
CREATE TRIGGER sponsored_payment_events_immutable BEFORE UPDATE OR DELETE ON sponsored_payment_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();

-- RLS -----------------------------------------------------------------------
ALTER TABLE directory_facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_facilities FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_facilities_read ON directory_facilities FOR SELECT USING (
  (publication_status = 'published' AND status = 'active')
  OR claimed_tenant_id = app.current_tenant()
  OR app.is_platform_operator()
);
CREATE POLICY directory_facilities_write ON directory_facilities FOR ALL USING (
  app.is_platform_operator()
  OR (claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin']))
) WITH CHECK (
  app.is_platform_operator()
  OR (claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin']))
);

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'directory_branches','directory_services','directory_capabilities',
    'directory_claims','directory_events','directory_duplicate_reviews',
    'directory_reports','directory_confirmations','directory_edit_requests'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

CREATE POLICY directory_branches_read ON directory_branches FOR SELECT USING (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant())
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.publication_status = 'published' AND f.status = 'active')
);
CREATE POLICY directory_branches_write ON directory_branches FOR ALL USING (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin']))
) WITH CHECK (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin']))
);

CREATE POLICY directory_services_read ON directory_services FOR SELECT USING (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant())
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.publication_status = 'published' AND f.status = 'active')
);
CREATE POLICY directory_services_write ON directory_services FOR ALL USING (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin']))
) WITH CHECK (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin']))
);

CREATE POLICY directory_capabilities_read ON directory_capabilities FOR SELECT USING (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant())
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.publication_status = 'published' AND f.status = 'active')
);
CREATE POLICY directory_capabilities_write ON directory_capabilities FOR ALL USING (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin']))
) WITH CHECK (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin']))
);

CREATE POLICY directory_claims_read ON directory_claims FOR SELECT USING (
  claimant_user_id = app.current_user()
  OR claimant_tenant_id = app.current_tenant()
  OR app.is_platform_operator()
);
CREATE POLICY directory_claims_insert ON directory_claims FOR INSERT WITH CHECK (
  claimant_user_id = app.current_user()
);
CREATE POLICY directory_claims_platform ON directory_claims FOR UPDATE USING (
  app.is_platform_operator()
) WITH CHECK (
  app.is_platform_operator()
);

CREATE POLICY directory_events_read ON directory_events FOR SELECT USING (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant())
);
CREATE POLICY directory_events_insert ON directory_events FOR INSERT WITH CHECK (
  app.current_user() IS NOT NULL OR app.is_platform_operator()
);

CREATE POLICY directory_duplicates_platform ON directory_duplicate_reviews FOR ALL USING (
  app.is_platform_operator()
) WITH CHECK (app.is_platform_operator());
CREATE POLICY directory_duplicates_provider_read ON directory_duplicate_reviews FOR SELECT USING (
  EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant())
);

CREATE POLICY directory_reports_insert ON directory_reports FOR INSERT WITH CHECK (true);
CREATE POLICY directory_reports_read ON directory_reports FOR SELECT USING (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant())
);
CREATE POLICY directory_reports_platform ON directory_reports FOR UPDATE USING (
  app.is_platform_operator()
) WITH CHECK (app.is_platform_operator());

CREATE POLICY directory_confirmations_provider ON directory_confirmations FOR ALL USING (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin']))
) WITH CHECK (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin']))
);

CREATE POLICY directory_edits_provider ON directory_edit_requests FOR ALL USING (
  app.is_platform_operator()
  OR requested_by = app.current_user()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant())
) WITH CHECK (
  app.is_platform_operator()
  OR requested_by = app.current_user()
);

ALTER TABLE sponsored_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsored_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY sponsored_packages_read ON sponsored_packages FOR SELECT USING (
  active OR app.is_platform_operator() OR app.current_user() IS NOT NULL
);
CREATE POLICY sponsored_packages_write ON sponsored_packages FOR ALL USING (
  app.is_platform_operator()
) WITH CHECK (app.is_platform_operator());

ALTER TABLE sponsored_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsored_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY sponsored_campaigns_read ON sponsored_campaigns FOR SELECT USING (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant())
  OR (status = 'active' AND payment_status = 'paid' AND editorial_status = 'approved'
      AND starts_on <= current_date AND ends_on >= current_date)
);
CREATE POLICY sponsored_campaigns_provider_write ON sponsored_campaigns FOR ALL USING (
  app.is_platform_operator()
  OR (created_by = app.current_user() AND EXISTS (
    SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin'])
  ))
) WITH CHECK (
  app.is_platform_operator()
  OR (created_by = app.current_user() AND EXISTS (
    SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin'])
  ))
);

ALTER TABLE sponsored_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsored_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY sponsored_payments_read ON sponsored_payments FOR SELECT USING (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM sponsored_campaigns c WHERE c.id = campaign_id AND EXISTS (
    SELECT 1 FROM directory_facilities f WHERE f.id = c.facility_id AND f.claimed_tenant_id = app.current_tenant()
  ))
);
CREATE POLICY sponsored_payments_provider_insert ON sponsored_payments FOR INSERT WITH CHECK (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM sponsored_campaigns c WHERE c.id = campaign_id AND c.created_by = app.current_user())
);
CREATE POLICY sponsored_payments_platform_update ON sponsored_payments FOR UPDATE USING (
  app.is_platform_operator()
) WITH CHECK (app.is_platform_operator());

ALTER TABLE sponsored_payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsored_payment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY sponsored_payment_events_read ON sponsored_payment_events FOR SELECT USING (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM sponsored_payments p WHERE p.id = payment_id AND EXISTS (
    SELECT 1 FROM sponsored_campaigns c WHERE c.id = p.campaign_id AND EXISTS (
      SELECT 1 FROM directory_facilities f WHERE f.id = c.facility_id AND f.claimed_tenant_id = app.current_tenant()
    )
  ))
);
CREATE POLICY sponsored_payment_events_insert ON sponsored_payment_events FOR INSERT WITH CHECK (true);

ALTER TABLE sponsored_daily_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsored_daily_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY sponsored_metrics_read ON sponsored_daily_metrics FOR SELECT USING (
  app.is_platform_operator()
  OR EXISTS (SELECT 1 FROM directory_facilities f WHERE f.id = facility_id AND f.claimed_tenant_id = app.current_tenant())
);
CREATE POLICY sponsored_metrics_write ON sponsored_daily_metrics FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE api_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_products FORCE ROW LEVEL SECURITY;
CREATE POLICY api_products_read ON api_products FOR SELECT USING (enabled OR app.is_platform_operator());
CREATE POLICY api_products_write ON api_products FOR ALL USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());

ALTER TABLE integration_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_clients FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_clients_read ON integration_clients FOR SELECT USING (
  app.is_platform_operator()
  OR tenant_id = app.current_tenant()
);
CREATE POLICY integration_clients_platform ON integration_clients FOR ALL USING (
  app.is_platform_operator()
) WITH CHECK (app.is_platform_operator());

ALTER TABLE integration_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_tokens_all ON integration_tokens FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE partner_patient_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_patient_links FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_links_tenant ON partner_patient_links FOR ALL USING (
  tenant_id = app.current_tenant()
) WITH CHECK (
  tenant_id = app.current_tenant()
);

ALTER TABLE integration_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_delivery_events FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_delivery_tenant ON integration_delivery_events FOR ALL USING (
  app.is_platform_operator() OR tenant_id = app.current_tenant()
) WITH CHECK (
  app.is_platform_operator() OR tenant_id = app.current_tenant()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  directory_facilities, directory_branches, directory_services, directory_capabilities,
  directory_claims, directory_events, directory_duplicate_reviews, directory_reports,
  directory_confirmations, directory_edit_requests,
  sponsored_packages, sponsored_campaigns, sponsored_payments, sponsored_payment_events,
  sponsored_daily_metrics, api_products, integration_clients, integration_tokens,
  partner_patient_links, integration_delivery_events
TO medveris_runtime;

REVOKE UPDATE, DELETE ON directory_events FROM medveris_runtime;
REVOKE UPDATE, DELETE ON sponsored_payment_events FROM medveris_runtime;

COMMIT;
