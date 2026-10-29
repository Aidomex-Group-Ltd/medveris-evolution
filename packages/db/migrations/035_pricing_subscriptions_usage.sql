-- Facility price governance, platform subscriptions with a seven-day trial, usage metering and tier
-- estimates, and limited cross-organization referral sharing.
--
-- Facility prices: each item is either a test price or an approved price; only approved, active prices
-- reach a bill, enforced here as well as in the API. Every change is versioned into an append-only price
-- history with the previous and new values, who made it, why and when. Items are deactivated, never
-- deleted. Each facility configures its own currencies, zero-price rule and confirmation threshold.
--
-- Subscriptions: a billing account belongs to one independent workspace or one organization; every
-- workspace points at the account that pays for it. Plans are versioned and controlled centrally by
-- platform operators; a facility can read them and consent to one, never change them. Basic is capped at
-- USD 15 per month with no usage overages by constraint. Higher tiers are created without prices and stay
-- unselectable until Medveris approves a priced version.
--
-- Usage: server-side measurements per billing account and originating workspace, with resource, unit,
-- period, rule version, validation and billing status. No patient data is recorded. Corrections keep the
-- original value.
--
-- Additive: no existing row is deleted. Pre-existing prices in the synthetic seed workspaces become
-- inactive test prices; other pre-existing prices, entered by facility finance staff, stay approved and
-- are recorded as such in the price history.

BEGIN;

-- ---------------------------------------------------------------- facility billing settings

CREATE TABLE facility_billing_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  allowed_currencies text[] NOT NULL DEFAULT ARRAY['UGX']::text[]
    CHECK (cardinality(allowed_currencies) > 0 AND allowed_currencies <@ ARRAY['UGX','USD']::text[]),
  allow_zero_prices boolean NOT NULL DEFAULT false,
  allow_manual_charges boolean NOT NULL DEFAULT true,
  significant_change_percent numeric(5,2) NOT NULL DEFAULT 20 CHECK (significant_change_percent > 0 AND significant_change_percent <= 100),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE facility_billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_billing_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY facility_billing_settings_read ON facility_billing_settings FOR SELECT USING (
  tenant_id = app.current_tenant() AND app.actor_kind() IN ('staff','system')
);
CREATE POLICY facility_billing_settings_insert ON facility_billing_settings FOR INSERT WITH CHECK (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'staff' AND app.has_any_role(ARRAY['facility_admin'])
);
CREATE POLICY facility_billing_settings_update ON facility_billing_settings FOR UPDATE USING (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'staff' AND app.has_any_role(ARRAY['facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.actor_kind() = 'staff' AND app.has_any_role(ARRAY['facility_admin']));
GRANT SELECT, INSERT, UPDATE ON facility_billing_settings TO medveris_runtime;

-- ---------------------------------------------------------------- price status and history

ALTER TABLE service_catalog
  ADD COLUMN price_status text NOT NULL DEFAULT 'approved' CHECK (price_status IN ('test','approved')),
  ADD COLUMN approved_by uuid REFERENCES users(id),
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN deactivated_by uuid REFERENCES users(id),
  ADD COLUMN deactivated_at timestamptz,
  ADD COLUMN deactivation_reason text,
  ADD CONSTRAINT service_catalog_price_upper CHECK (price <= 100000000),
  ADD CONSTRAINT service_catalog_currency_code CHECK (currency ~ '^[A-Z]{3}$') NOT VALID;

-- Data changes below run under the migration role, which row-level security would otherwise hide every
-- row from; RLS is forced again before commit.
ALTER TABLE service_catalog NO FORCE ROW LEVEL SECURITY;
-- Redo 034's item-type backfill, which ran under forced RLS and matched no rows.
UPDATE service_catalog SET item_type = 'procedure' WHERE category = 'procedure' AND item_type = 'service';
UPDATE service_catalog SET item_type = 'pharmacy-item' WHERE category = 'pharmacy' AND item_type = 'service';
UPDATE service_catalog SET item_type = 'supply' WHERE category = 'supply' AND item_type = 'service';
-- Synthetic seed workspaces hold dummy prices: keep them for reference as inactive test prices.
UPDATE service_catalog
   SET price_status = 'test', active = false, deactivated_at = now(),
       deactivation_reason = 'Synthetic demonstration price; not approved for billing'
 WHERE tenant_id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')
    OR id = 'a6000000-0000-4000-8000-000000000001';
UPDATE service_catalog SET approved_by = created_by, approved_at = created_at WHERE price_status = 'approved';
ALTER TABLE service_catalog FORCE ROW LEVEL SECURITY;

-- Prices are deactivated, never deleted, so bills and history keep their reference.
DROP POLICY catalog_delete ON service_catalog;
REVOKE DELETE ON service_catalog FROM medveris_runtime;

CREATE TABLE service_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  catalog_item_id uuid NOT NULL REFERENCES service_catalog(id),
  version integer NOT NULL,
  change text NOT NULL CHECK (change IN ('created','price-changed','status-changed','deactivated','reactivated','updated','migrated')),
  previous_price numeric,
  new_price numeric NOT NULL,
  previous_currency text,
  new_currency text NOT NULL,
  previous_status text,
  new_status text NOT NULL,
  previous_active boolean,
  new_active boolean NOT NULL,
  reason text,
  changed_by uuid REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (catalog_item_id, version)
);
CREATE INDEX service_price_history_item_idx ON service_price_history(tenant_id, catalog_item_id, changed_at);
CREATE TRIGGER service_price_history_immutable BEFORE UPDATE OR DELETE ON service_price_history
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();

ALTER TABLE service_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_price_history FORCE ROW LEVEL SECURITY;
CREATE POLICY service_price_history_read ON service_price_history FOR SELECT USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin','auditor'])
);
CREATE POLICY service_price_history_insert ON service_price_history FOR INSERT WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin'])
);
GRANT SELECT, INSERT ON service_price_history TO medveris_runtime;

-- The starting point of every existing item's history.
ALTER TABLE service_price_history NO FORCE ROW LEVEL SECURITY;
ALTER TABLE service_catalog NO FORCE ROW LEVEL SECURITY;
INSERT INTO service_price_history (tenant_id, catalog_item_id, version, change, new_price, new_currency, new_status, new_active, reason, changed_by, changed_at)
SELECT tenant_id, id, version, 'migrated', price, currency, price_status, active,
       CASE WHEN price_status = 'test' THEN 'Synthetic demonstration price marked as test at migration'
            ELSE 'Price entered before price history; carried forward as approved' END,
       coalesce(updated_by, created_by), now()
  FROM service_catalog;
ALTER TABLE service_catalog FORCE ROW LEVEL SECURITY;
ALTER TABLE service_price_history FORCE ROW LEVEL SECURITY;

-- Every version of a price-list item is recorded. A price, currency, status or availability change must
-- come with a new version, so no change can bypass the history.
CREATE FUNCTION app.service_price_history_capture() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version THEN
    IF NEW.price <> OLD.price OR NEW.currency <> OLD.currency OR NEW.price_status <> OLD.price_status OR NEW.active <> OLD.active THEN
      RAISE EXCEPTION 'service_price_unversioned_change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN kind := 'created';
  ELSIF NEW.active <> OLD.active THEN kind := CASE WHEN NEW.active THEN 'reactivated' ELSE 'deactivated' END;
  ELSIF NEW.price <> OLD.price OR NEW.currency <> OLD.currency THEN kind := 'price-changed';
  ELSIF NEW.price_status <> OLD.price_status THEN kind := 'status-changed';
  ELSE kind := 'updated';
  END IF;
  INSERT INTO service_price_history (tenant_id, catalog_item_id, version, change, previous_price, new_price, previous_currency, new_currency,
    previous_status, new_status, previous_active, new_active, reason, changed_by)
  VALUES (NEW.tenant_id, NEW.id, NEW.version, kind,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.price END, NEW.price,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.currency END, NEW.currency,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.price_status END, NEW.price_status,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.active END, NEW.active,
    NULLIF(current_setting('app.price_change_reason', true), ''),
    coalesce(NEW.updated_by, NEW.created_by));
  RETURN NEW;
END;
$$;
CREATE TRIGGER service_catalog_price_history AFTER INSERT OR UPDATE ON service_catalog
FOR EACH ROW EXECUTE FUNCTION app.service_price_history_capture();

-- A bill line from the price list is charged at that item's current approved price, in the bill's
-- currency, and records the price version it used. Later price changes never touch existing lines.
ALTER TABLE invoice_items ADD COLUMN catalog_version integer;
CREATE FUNCTION app.invoice_item_price_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  item record;
  bill_currency text;
BEGIN
  IF NEW.service_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.price, s.currency, s.price_status, s.active, s.version, s.tenant_id INTO item FROM service_catalog s WHERE s.id = NEW.service_id;
  SELECT i.currency INTO bill_currency FROM invoices i WHERE i.id = NEW.invoice_id;
  IF item IS NULL OR item.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'invoice_item_unknown_price' USING ERRCODE = '23514';
  END IF;
  IF item.price_status <> 'approved' THEN
    RAISE EXCEPTION 'invoice_item_test_price' USING ERRCODE = '23514';
  END IF;
  IF NOT item.active THEN
    RAISE EXCEPTION 'invoice_item_inactive_price' USING ERRCODE = '23514';
  END IF;
  IF NEW.unit_price <> item.price OR item.currency <> bill_currency THEN
    RAISE EXCEPTION 'invoice_item_price_mismatch' USING ERRCODE = '23514';
  END IF;
  NEW.catalog_version := item.version;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invoice_items_price_guard BEFORE INSERT ON invoice_items
FOR EACH ROW EXECUTE FUNCTION app.invoice_item_price_guard();

-- ---------------------------------------------------------------- billing accounts and plans

CREATE TABLE billing_accounts (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('individual','independent-facility','organization')),
  name text NOT NULL,
  owner_tenant_id uuid UNIQUE REFERENCES tenants(id),
  owner_organization_id uuid UNIQUE REFERENCES organizations(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_tenant_id IS NULL) <> (owner_organization_id IS NULL)),
  CHECK ((kind = 'organization') = (owner_organization_id IS NOT NULL))
);
-- The account that pays for a workspace's subscription and receives its usage.
ALTER TABLE tenants ADD COLUMN billing_account_id uuid REFERENCES billing_accounts(id);
CREATE INDEX tenants_billing_account_idx ON tenants(billing_account_id);

CREATE TABLE subscription_plans (
  id uuid PRIMARY KEY,
  code text NOT NULL CHECK (code IN ('trial','basic','standard','advanced','enterprise')),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('draft','approved','retired')),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  monthly_price_minor bigint CHECK (monthly_price_minor IS NULL OR monthly_price_minor >= 0),
  daily_reference_minor bigint CHECK (daily_reference_minor IS NULL OR daily_reference_minor >= 0),
  max_monthly_charge_minor bigint CHECK (max_monthly_charge_minor IS NULL OR max_monthly_charge_minor >= 0),
  usage_overages boolean NOT NULL DEFAULT false,
  trial_days integer CHECK (trial_days IS NULL OR trial_days > 0),
  features text[] NOT NULL DEFAULT ARRAY[]::text[],
  contract_required boolean NOT NULL DEFAULT false,
  effective_from timestamptz NOT NULL DEFAULT now(),
  approval_reference text,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version),
  CHECK (status <> 'approved' OR (monthly_price_minor IS NOT NULL AND approved_at IS NOT NULL AND approval_reference IS NOT NULL)),
  -- Basic: at most USD 15 a month, never usage overages.
  CHECK (code <> 'basic' OR (NOT usage_overages AND max_monthly_charge_minor IS NOT NULL AND max_monthly_charge_minor <= 1500
         AND (monthly_price_minor IS NULL OR monthly_price_minor <= max_monthly_charge_minor))),
  CHECK (code <> 'trial' OR (coalesce(monthly_price_minor, 0) = 0 AND NOT usage_overages AND trial_days = 7))
);
CREATE UNIQUE INDEX subscription_plans_one_approved ON subscription_plans(code) WHERE status = 'approved';

-- An approved plan version is frozen; changing a price means approving a new version.
CREATE FUNCTION app.subscription_plan_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'subscription_plan_delete' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('approved','retired') AND (
       NEW.code <> OLD.code OR NEW.version <> OLD.version OR NEW.currency <> OLD.currency
    OR NEW.monthly_price_minor IS DISTINCT FROM OLD.monthly_price_minor OR NEW.max_monthly_charge_minor IS DISTINCT FROM OLD.max_monthly_charge_minor
    OR NEW.usage_overages <> OLD.usage_overages OR NEW.features <> OLD.features OR NEW.trial_days IS DISTINCT FROM OLD.trial_days
    OR (OLD.status = 'retired' AND NEW.status <> 'retired') OR (OLD.status = 'approved' AND NEW.status NOT IN ('approved','retired'))) THEN
    RAISE EXCEPTION 'subscription_plan_frozen' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER subscription_plans_guard BEFORE UPDATE OR DELETE ON subscription_plans
FOR EACH ROW EXECUTE FUNCTION app.subscription_plan_guard();

-- What is measured. Counters are summed over a period; gauges use the period's highest reading.
CREATE TABLE usage_resources (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_.]+$'),
  name text NOT NULL,
  unit text NOT NULL,
  aggregation text NOT NULL CHECK (aggregation IN ('sum','max')),
  measurement text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE plan_resource_rules (
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  resource text NOT NULL REFERENCES usage_resources(code),
  treatment text NOT NULL CHECK (treatment IN ('included','excluded','billable')),
  included_quantity numeric CHECK (included_quantity IS NULL OR included_quantity >= 0),
  limit_quantity numeric CHECK (limit_quantity IS NULL OR limit_quantity >= 0),
  unit_rate_minor numeric CHECK (unit_rate_minor IS NULL OR unit_rate_minor >= 0),
  rate_unit_quantity numeric NOT NULL DEFAULT 1 CHECK (rate_unit_quantity > 0),
  PRIMARY KEY (plan_id, resource)
);
CREATE FUNCTION app.plan_resource_rule_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  plan record;
BEGIN
  SELECT code, status, usage_overages INTO plan FROM subscription_plans WHERE id = coalesce(NEW.plan_id, OLD.plan_id);
  IF plan.status IN ('approved','retired') THEN
    RAISE EXCEPTION 'subscription_plan_frozen' USING ERRCODE = '42501';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.treatment = 'billable' AND (plan.code IN ('trial','basic') OR NOT plan.usage_overages) THEN
    RAISE EXCEPTION 'plan_rule_billable_without_overages' USING ERRCODE = '23514';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;

INSERT INTO usage_resources (code, name, unit, aggregation, measurement) VALUES
  ('compute.request_ms', 'Compute (API processing time)', 'millisecond', 'sum', 'Server-measured wall time of authenticated API requests, attributed to the active workspace'),
  ('network.egress_bytes', 'Network traffic out', 'byte', 'sum', 'Response body bytes of authenticated API requests'),
  ('network.ingress_bytes', 'Network traffic in', 'byte', 'sum', 'Request body bytes of authenticated API requests'),
  ('storage.file_bytes', 'Stored files', 'byte', 'max', 'Daily snapshot of uploaded file bytes held for the workspace'),
  ('users.active', 'Active staff accounts', 'user', 'max', 'Daily snapshot of active staff memberships');

-- Plans. Trial and Basic follow the published Medveris pricing instruction; higher tiers exist as
-- unpriced drafts until their prices, allowances and rates are approved.
INSERT INTO subscription_plans (id, code, version, name, description, status, monthly_price_minor, daily_reference_minor, max_monthly_charge_minor,
  usage_overages, trial_days, features, approval_reference, approved_at)
VALUES
  ('c0000000-0000-4000-8000-000000000001', 'trial', 1, 'Free trial', 'Seven calendar days of the Basic features with no subscription or usage charges.',
   'approved', 0, 0, 0, false, 7, ARRAY['core-clinical','point-of-sale','price-list'],
   'Medveris pricing instruction: 7-day free trial, no onboarding fee', now()),
  ('c0000000-0000-4000-8000-000000000002', 'basic', 1, 'Basic', 'USD 15 per month for low-consumption accounts (reference USD 0.50 per day). Fixed for the billing month; no usage overages.',
   'approved', 1500, 50, 1500, false, NULL, ARRAY['core-clinical','point-of-sale','price-list'],
   'Medveris pricing instruction: Basic USD 15/month, USD 0.50/day reference, no overages', now()),
  ('c0000000-0000-4000-8000-000000000003', 'standard', 1, 'Standard', 'Pricing awaiting approval.', 'draft', NULL, NULL, NULL, true, NULL, ARRAY['core-clinical','point-of-sale','price-list'], NULL, NULL),
  ('c0000000-0000-4000-8000-000000000004', 'advanced', 1, 'Advanced', 'Pricing awaiting approval.', 'draft', NULL, NULL, NULL, true, NULL, ARRAY['core-clinical','point-of-sale','price-list'], NULL, NULL),
  ('c0000000-0000-4000-8000-000000000005', 'enterprise', 1, 'Enterprise', 'Contract pricing awaiting approval.', 'draft', NULL, NULL, NULL, true, NULL, ARRAY['core-clinical','point-of-sale','price-list'], NULL, NULL);
UPDATE subscription_plans SET contract_required = true WHERE code = 'enterprise';
-- Trial and Basic include every measured resource; their supported limits await approval.
INSERT INTO plan_resource_rules (plan_id, resource, treatment)
SELECT p.id, r.code, 'included' FROM subscription_plans p CROSS JOIN usage_resources r WHERE p.code IN ('trial','basic');
-- From here on, rules of an approved or retired plan version are frozen with it.
CREATE TRIGGER plan_resource_rules_guard BEFORE INSERT OR UPDATE OR DELETE ON plan_resource_rules
FOR EACH ROW EXECUTE FUNCTION app.plan_resource_rule_guard();

ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_plans_read ON subscription_plans FOR SELECT USING (true);
CREATE POLICY subscription_plans_operator ON subscription_plans FOR INSERT WITH CHECK (app.is_platform_operator());
CREATE POLICY subscription_plans_operator_update ON subscription_plans FOR UPDATE
  USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());
CREATE POLICY subscription_plans_jobs ON subscription_plans FOR SELECT TO medveris_jobs USING (true);
ALTER TABLE plan_resource_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_resource_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_resource_rules_read ON plan_resource_rules FOR SELECT USING (true);
CREATE POLICY plan_resource_rules_operator ON plan_resource_rules FOR INSERT WITH CHECK (app.is_platform_operator());
CREATE POLICY plan_resource_rules_operator_update ON plan_resource_rules FOR UPDATE
  USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());
CREATE POLICY plan_resource_rules_operator_delete ON plan_resource_rules FOR DELETE USING (app.is_platform_operator());
GRANT SELECT, INSERT, UPDATE ON subscription_plans TO medveris_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON plan_resource_rules TO medveris_runtime;
GRANT SELECT ON usage_resources TO medveris_runtime, medveris_jobs;
GRANT SELECT ON subscription_plans, plan_resource_rules TO medveris_jobs;

-- ---------------------------------------------------------------- billing account access

GRANT SELECT ON billing_accounts, tenants, organization_memberships TO medveris_exchange;
-- 'manage' for the account's administrators (owner workspace administrators, or organization owners and
-- administrators), 'view' for finance of the owner workspace and administrators of workspaces it pays
-- for, 'operate' for platform operators; NULL otherwise.
CREATE FUNCTION app.billing_account_access(p_account uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN app.is_platform_operator() THEN 'operate'
    WHEN a.owner_tenant_id IS NOT NULL AND a.owner_tenant_id = app.current_tenant() AND app.actor_kind() = 'staff'
         AND app.has_any_role(ARRAY['owner','facility_admin']) THEN 'manage'
    WHEN a.owner_organization_id IS NOT NULL AND app.actor_kind() = 'staff' AND EXISTS (
         SELECT 1 FROM organization_memberships m WHERE m.organization_id = a.owner_organization_id AND m.user_id = app.current_user()
            AND m.status = 'active' AND m.role IN ('organization_owner','organization_admin')) THEN 'manage'
    WHEN app.actor_kind() = 'staff' AND app.has_any_role(ARRAY['owner','facility_admin','finance']) AND EXISTS (
         SELECT 1 FROM tenants t WHERE t.id = app.current_tenant() AND t.billing_account_id = a.id) THEN 'view'
  END
  FROM billing_accounts a WHERE a.id = p_account
$$;
ALTER FUNCTION app.billing_account_access(uuid) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.billing_account_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.billing_account_access(uuid) TO medveris_runtime;

ALTER TABLE billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_accounts_read ON billing_accounts FOR SELECT USING (
  app.billing_account_access(id) IS NOT NULL OR app.actor_kind() IN ('system','registration')
);
-- Accounts are created at onboarding and by the platform, never edited by a workspace.
CREATE POLICY billing_accounts_create ON billing_accounts FOR INSERT WITH CHECK (
  app.actor_kind() IN ('system','registration') OR app.is_platform_operator()
  OR (app.actor_kind() = 'staff' AND created_by = app.current_user())
);
CREATE POLICY billing_accounts_operator ON billing_accounts FOR UPDATE
  USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());
CREATE POLICY billing_accounts_jobs ON billing_accounts FOR SELECT TO medveris_jobs USING (true);
GRANT SELECT, INSERT, UPDATE ON billing_accounts TO medveris_runtime;
GRANT SELECT ON billing_accounts TO medveris_jobs;

-- ---------------------------------------------------------------- subscriptions

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY,
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(id),
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  status text NOT NULL CHECK (status IN ('trialing','trial_expired','pending_payment','active','past_due','restricted','cancelled','suspended')),
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_eligibility text NOT NULL DEFAULT 'eligible' CHECK (trial_eligibility IN ('eligible','already-claimed','operator-granted')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  -- The consent under which the current paid plan runs.
  consent_id uuid,
  -- A plan the customer consented to, starting at the end of the trial or of the current period.
  pending_plan_id uuid REFERENCES subscription_plans(id),
  pending_consent_id uuid,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  cancelled_at timestamptz,
  cancellation_reason text,
  status_reason text,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((trial_started_at IS NULL) = (trial_ends_at IS NULL)),
  CHECK (trial_ends_at IS NULL OR trial_ends_at = trial_started_at + interval '7 days'),
  CHECK (status <> 'trialing' OR trial_started_at IS NOT NULL),
  CHECK ((current_period_start IS NULL) = (current_period_end IS NULL)),
  CHECK (current_period_end IS NULL OR current_period_end > current_period_start)
);
CREATE UNIQUE INDEX subscriptions_one_current ON subscriptions(billing_account_id) WHERE status <> 'cancelled';
CREATE INDEX subscriptions_status_idx ON subscriptions(status, trial_ends_at, current_period_end);

CREATE TABLE subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(id),
  event text NOT NULL,
  from_status text,
  to_status text,
  from_plan_id uuid REFERENCES subscription_plans(id),
  to_plan_id uuid REFERENCES subscription_plans(id),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid REFERENCES users(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('staff','system','platform','registration','jobs')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_events_idx ON subscription_events(subscription_id, occurred_at);
CREATE TRIGGER subscription_events_immutable BEFORE UPDATE OR DELETE ON subscription_events
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();

-- One trial per owner email, organization registration or facility registration, kept as keyed hashes.
CREATE TABLE trial_claims (
  fingerprint text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('owner-email','organization-registration','facility-registration')),
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(id),
  claimed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription_consents (
  id uuid PRIMARY KEY,
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(id),
  subscription_id uuid REFERENCES subscriptions(id),
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  change text NOT NULL CHECK (change IN ('start','upgrade','downgrade','renew')),
  monthly_price_minor bigint NOT NULL CHECK (monthly_price_minor >= 0),
  proration_minor bigint NOT NULL DEFAULT 0 CHECK (proration_minor >= 0),
  currency text NOT NULL CHECK (currency = 'USD'),
  effective_at timestamptz NOT NULL,
  disclosure text NOT NULL,
  disclosure_digest text NOT NULL,
  accepted_by uuid NOT NULL REFERENCES users(id),
  accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER subscription_consents_immutable BEFORE UPDATE OR DELETE ON subscription_consents
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_consent_fk FOREIGN KEY (consent_id) REFERENCES subscription_consents(id),
  ADD CONSTRAINT subscriptions_pending_consent_fk FOREIGN KEY (pending_consent_id) REFERENCES subscription_consents(id);

-- A paid plan, or a pending paid plan, only applies with the customer's consent to that plan version at
-- that price for this account. Nobody, including a platform operator, can start a priced plan without it.
CREATE FUNCTION app.subscription_plan_consent_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  plan record;
BEGIN
  SELECT code, monthly_price_minor, status INTO plan FROM subscription_plans WHERE id = NEW.plan_id;
  IF plan.code <> 'trial' THEN
    IF NEW.consent_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM subscription_consents c
       WHERE c.id = NEW.consent_id AND c.billing_account_id = NEW.billing_account_id AND c.plan_id = NEW.plan_id
         AND c.monthly_price_minor = plan.monthly_price_minor
    ) THEN
      RAISE EXCEPTION 'subscription_plan_without_consent' USING ERRCODE = '23514';
    END IF;
    IF (TG_OP = 'INSERT' OR NEW.plan_id <> OLD.plan_id) AND plan.status <> 'approved' THEN
      RAISE EXCEPTION 'subscription_plan_not_approved' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.pending_plan_id IS NOT NULL AND (NEW.pending_consent_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM subscription_consents c JOIN subscription_plans p ON p.id = c.plan_id
     WHERE c.id = NEW.pending_consent_id AND c.billing_account_id = NEW.billing_account_id AND c.plan_id = NEW.pending_plan_id
       AND p.status = 'approved' AND c.monthly_price_minor = p.monthly_price_minor
  )) THEN
    RAISE EXCEPTION 'subscription_pending_plan_without_consent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER subscriptions_consent_guard BEFORE INSERT OR UPDATE OF plan_id, consent_id, pending_plan_id, pending_consent_id ON subscriptions
FOR EACH ROW EXECUTE FUNCTION app.subscription_plan_consent_guard();

-- ---------------------------------------------------------------- subscription invoices and payments

CREATE TABLE subscription_invoices (
  id uuid PRIMARY KEY,
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(id),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  number text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('period','proration')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  currency text NOT NULL CHECK (currency = 'USD'),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void','uncollectible')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  paid_at timestamptz,
  payment_attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  void_reason text,
  CHECK (period_end > period_start),
  CHECK (status <> 'void' OR void_reason IS NOT NULL)
);
-- A billing period is invoiced once per kind, so the monthly plan price cannot be charged twice.
CREATE UNIQUE INDEX subscription_invoices_once ON subscription_invoices(subscription_id, kind, period_start) WHERE status <> 'void';
CREATE INDEX subscription_invoices_account_idx ON subscription_invoices(billing_account_id, issued_at);

CREATE TABLE subscription_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES subscription_invoices(id),
  kind text NOT NULL CHECK (kind IN ('plan','proration','usage','credit')),
  description text NOT NULL,
  plan_id uuid REFERENCES subscription_plans(id),
  quantity numeric NOT NULL DEFAULT 1,
  unit_amount_minor bigint NOT NULL,
  amount_minor bigint NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL
);
CREATE TRIGGER subscription_invoice_lines_immutable BEFORE UPDATE OR DELETE ON subscription_invoice_lines
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();

-- Charges for one plan in one period never exceed that plan's monthly maximum (Basic: USD 15).
CREATE FUNCTION app.subscription_line_cap_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cap bigint;
  charged bigint;
  sub uuid;
BEGIN
  IF NEW.plan_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT max_monthly_charge_minor INTO cap FROM subscription_plans WHERE id = NEW.plan_id;
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT subscription_id INTO sub FROM subscription_invoices WHERE id = NEW.invoice_id;
  SELECT coalesce(sum(l.amount_minor), 0) INTO charged
    FROM subscription_invoice_lines l JOIN subscription_invoices i ON i.id = l.invoice_id
   WHERE i.subscription_id = sub AND i.status <> 'void' AND l.plan_id = NEW.plan_id
     AND l.period_start < NEW.period_end AND l.period_end > NEW.period_start;
  IF charged + NEW.amount_minor > cap THEN
    RAISE EXCEPTION 'subscription_plan_cap_exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER subscription_invoice_lines_cap BEFORE INSERT ON subscription_invoice_lines
FOR EACH ROW EXECUTE FUNCTION app.subscription_line_cap_guard();

CREATE TABLE subscription_payments (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES subscription_invoices(id),
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency = 'USD'),
  method text NOT NULL CHECK (method IN ('bank-transfer','card','mobile-money','cash','other')),
  status text NOT NULL CHECK (status IN ('succeeded','failed')),
  provider_reference text,
  failure_reason text,
  receipt_number text UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  recorded_by uuid REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
  refunded_at timestamptz,
  refunded_by uuid REFERENCES users(id),
  refund_reason text,
  CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
  CHECK (status <> 'succeeded' OR receipt_number IS NOT NULL),
  CHECK (refunded_minor = 0 OR (status = 'succeeded' AND refund_reason IS NOT NULL))
);
CREATE INDEX subscription_payments_invoice_idx ON subscription_payments(invoice_id, recorded_at);

-- ---------------------------------------------------------------- usage

CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id uuid REFERENCES billing_accounts(id),
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  resource text NOT NULL REFERENCES usage_resources(code),
  quantity numeric NOT NULL CHECK (quantity >= 0),
  corrected_quantity numeric CHECK (corrected_quantity IS NULL OR corrected_quantity >= 0),
  unit text NOT NULL,
  -- API measurements are combined into hourly buckets; snapshots are one row per workspace per day.
  bucket_start timestamptz NOT NULL,
  observation_count integer NOT NULL DEFAULT 1 CHECK (observation_count > 0),
  period_start timestamptz NOT NULL,
  plan_id uuid REFERENCES subscription_plans(id),
  rule_version text NOT NULL,
  source text NOT NULL CHECK (source IN ('api-request','storage-snapshot','user-snapshot','job')),
  dedupe_key text NOT NULL UNIQUE,
  validation_status text NOT NULL CHECK (validation_status IN ('valid','invalid','unverified','unassigned')),
  billing_status text NOT NULL CHECK (billing_status IN ('trial','included','billable','excluded','not-billable')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_account_period_idx ON usage_events(billing_account_id, period_start, resource);
CREATE INDEX usage_events_tenant_bucket_idx ON usage_events(tenant_id, bucket_start);
CREATE INDEX usage_events_unassigned_idx ON usage_events(validation_status) WHERE validation_status <> 'valid';

CREATE TABLE usage_event_corrections (
  id uuid PRIMARY KEY,
  usage_event_id uuid NOT NULL REFERENCES usage_events(id),
  billing_account_id uuid REFERENCES billing_accounts(id),
  original_quantity numeric NOT NULL,
  previous_quantity numeric NOT NULL,
  corrected_quantity numeric NOT NULL CHECK (corrected_quantity >= 0),
  reason text NOT NULL,
  corrected_by uuid NOT NULL REFERENCES users(id),
  corrected_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER usage_event_corrections_immutable BEFORE UPDATE OR DELETE ON usage_event_corrections
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();

-- Billing status of a measurement under the subscription in force when it was taken.
GRANT SELECT, INSERT, UPDATE ON usage_events TO medveris_exchange;
GRANT SELECT ON subscriptions, plan_resource_rules, subscription_plans, usage_resources TO medveris_exchange;
CREATE FUNCTION app.usage_billing_status(p_status text, p_plan uuid, p_resource text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_status IS NULL THEN 'not-billable'
    WHEN p_status = 'trialing' THEN 'trial'
    ELSE coalesce((SELECT r.treatment FROM plan_resource_rules r WHERE r.plan_id = p_plan AND r.resource = p_resource), 'excluded')
  END
$$;
ALTER FUNCTION app.usage_billing_status(text, uuid, text) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.usage_billing_status(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.usage_billing_status(text, uuid, text) TO medveris_runtime, medveris_jobs;

-- Adds one authenticated API request's measurements to the active workspace's hourly bucket. Callable
-- only for the workspace set in the transaction context; quantities only, nothing about the request.
CREATE FUNCTION app.record_request_usage(p_tenant uuid, p_compute_ms numeric, p_ingress_bytes numeric, p_egress_bytes numeric) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  account uuid;
  sub record;
  bucket timestamptz := date_trunc('hour', now());
  measured record;
BEGIN
  IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM app.current_tenant() THEN
    RAISE EXCEPTION 'usage_tenant_mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_compute_ms < 0 OR p_ingress_bytes < 0 OR p_egress_bytes < 0 THEN
    RAISE EXCEPTION 'usage_negative_quantity' USING ERRCODE = '23514';
  END IF;
  SELECT t.billing_account_id INTO account FROM tenants t WHERE t.id = p_tenant;
  SELECT s.status, s.plan_id, coalesce(CASE WHEN s.status = 'trialing' THEN s.trial_started_at END, s.current_period_start, s.trial_started_at) AS period_start,
         p.code || ':' || p.version AS rule_version
    INTO sub FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
   WHERE s.billing_account_id = account AND s.status <> 'cancelled';
  FOR measured IN SELECT * FROM (VALUES ('compute.request_ms', 'millisecond', p_compute_ms), ('network.ingress_bytes', 'byte', p_ingress_bytes), ('network.egress_bytes', 'byte', p_egress_bytes)) v(resource, unit, quantity) LOOP
    INSERT INTO usage_events (billing_account_id, tenant_id, resource, quantity, unit, bucket_start, period_start, plan_id, rule_version, source,
      dedupe_key, validation_status, billing_status)
    VALUES (account, p_tenant, measured.resource, measured.quantity, measured.unit, bucket,
      coalesce(sub.period_start, date_trunc('month', now())), sub.plan_id, coalesce(sub.rule_version, 'none'), 'api-request',
      'api:' || p_tenant || ':' || measured.resource || ':' || to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24'),
      CASE WHEN account IS NULL THEN 'unassigned' ELSE 'valid' END,
      app.usage_billing_status(sub.status, sub.plan_id, measured.resource))
    ON CONFLICT (dedupe_key) DO UPDATE
      SET quantity = usage_events.quantity + excluded.quantity, observation_count = usage_events.observation_count + 1, updated_at = now();
  END LOOP;
END;
$$;
ALTER FUNCTION app.record_request_usage(uuid, numeric, numeric, numeric) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.record_request_usage(uuid, numeric, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_request_usage(uuid, numeric, numeric, numeric) TO medveris_runtime;

-- ---------------------------------------------------------------- notifications and recommendations

CREATE TABLE billing_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(id),
  kind text NOT NULL CHECK (kind IN ('trial-reminder','trial-expired','usage-threshold','invoice-issued','payment-overdue',
    'payment-failed','payment-received','restricted','tier-recommendation','subscription-changed')),
  title text NOT NULL,
  body text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  read_by uuid REFERENCES users(id)
);
CREATE INDEX billing_notifications_account_idx ON billing_notifications(billing_account_id, created_at);

CREATE TABLE tier_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(id),
  evaluated_on date NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  measured_days integer NOT NULL,
  current_plan_id uuid REFERENCES subscription_plans(id),
  recommended_plan_id uuid REFERENCES subscription_plans(id),
  estimated_monthly_minor bigint,
  projected_usage jsonb NOT NULL,
  estimates jsonb NOT NULL,
  explanation text NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','dismissed','superseded','informational')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_account_id, evaluated_on)
);

-- ---------------------------------------------------------------- row-level security for billing

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_events FORCE ROW LEVEL SECURITY;
ALTER TABLE trial_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_invoice_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_event_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_event_corrections FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE tier_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tier_recommendations FORCE ROW LEVEL SECURITY;

-- Reads follow billing_account_access. Writes come from the billing service running as 'system' after
-- the API has authorized the user, from onboarding ('registration'), from platform operators, or from
-- the scheduled billing cycle (medveris_jobs). A workspace user can never write billing state directly.
CREATE POLICY subscriptions_read ON subscriptions FOR SELECT USING (
  app.billing_account_access(billing_account_id) IS NOT NULL OR app.actor_kind() IN ('system','registration')
);
CREATE POLICY subscriptions_write ON subscriptions FOR INSERT WITH CHECK (app.actor_kind() IN ('system','registration') OR app.is_platform_operator());
CREATE POLICY subscriptions_update ON subscriptions FOR UPDATE
  USING (app.actor_kind() = 'system' OR app.is_platform_operator()) WITH CHECK (app.actor_kind() = 'system' OR app.is_platform_operator());
CREATE POLICY subscriptions_jobs ON subscriptions TO medveris_jobs USING (true) WITH CHECK (true);

CREATE POLICY subscription_events_read ON subscription_events FOR SELECT USING (
  app.billing_account_access(billing_account_id) IS NOT NULL
);
CREATE POLICY subscription_events_write ON subscription_events FOR INSERT WITH CHECK (app.actor_kind() IN ('system','registration') OR app.is_platform_operator());
CREATE POLICY subscription_events_jobs ON subscription_events TO medveris_jobs USING (true) WITH CHECK (true);

CREATE POLICY trial_claims_onboarding ON trial_claims USING (app.actor_kind() IN ('system','registration') OR app.is_platform_operator())
  WITH CHECK (app.actor_kind() IN ('system','registration') OR app.is_platform_operator());

CREATE POLICY subscription_consents_read ON subscription_consents FOR SELECT USING (
  app.billing_account_access(billing_account_id) IS NOT NULL OR app.actor_kind() = 'system'
);
CREATE POLICY subscription_consents_write ON subscription_consents FOR INSERT WITH CHECK (app.actor_kind() = 'system');
CREATE POLICY subscription_consents_jobs ON subscription_consents FOR SELECT TO medveris_jobs USING (true);

CREATE POLICY subscription_invoices_read ON subscription_invoices FOR SELECT USING (
  app.billing_account_access(billing_account_id) IS NOT NULL OR app.actor_kind() = 'system'
);
CREATE POLICY subscription_invoices_write ON subscription_invoices FOR INSERT WITH CHECK (app.actor_kind() = 'system' OR app.is_platform_operator());
CREATE POLICY subscription_invoices_update ON subscription_invoices FOR UPDATE
  USING (app.actor_kind() = 'system' OR app.is_platform_operator()) WITH CHECK (app.actor_kind() = 'system' OR app.is_platform_operator());
CREATE POLICY subscription_invoices_jobs ON subscription_invoices TO medveris_jobs USING (true) WITH CHECK (true);

CREATE POLICY subscription_invoice_lines_read ON subscription_invoice_lines FOR SELECT USING (
  EXISTS (SELECT 1 FROM subscription_invoices i WHERE i.id = invoice_id)
);
CREATE POLICY subscription_invoice_lines_write ON subscription_invoice_lines FOR INSERT WITH CHECK (app.actor_kind() = 'system' OR app.is_platform_operator());
CREATE POLICY subscription_invoice_lines_jobs ON subscription_invoice_lines TO medveris_jobs USING (true) WITH CHECK (true);

CREATE POLICY subscription_payments_read ON subscription_payments FOR SELECT USING (
  app.billing_account_access(billing_account_id) IS NOT NULL OR app.actor_kind() = 'system'
);
CREATE POLICY subscription_payments_write ON subscription_payments FOR INSERT WITH CHECK (app.is_platform_operator() OR app.actor_kind() = 'system');
CREATE POLICY subscription_payments_update ON subscription_payments FOR UPDATE
  USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());
CREATE POLICY subscription_payments_jobs ON subscription_payments FOR SELECT TO medveris_jobs USING (true);

-- Administrators of a workspace also see the usage their own workspace generated.
CREATE POLICY usage_events_read ON usage_events FOR SELECT USING (
  app.billing_account_access(billing_account_id) IS NOT NULL
  OR (tenant_id = app.current_tenant() AND app.actor_kind() = 'staff' AND app.has_any_role(ARRAY['owner','facility_admin']))
);
CREATE POLICY usage_events_operator ON usage_events FOR UPDATE
  USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());
CREATE POLICY usage_events_jobs ON usage_events TO medveris_jobs USING (true) WITH CHECK (true);

CREATE POLICY usage_event_corrections_read ON usage_event_corrections FOR SELECT USING (
  app.billing_account_access(billing_account_id) IS NOT NULL
);
CREATE POLICY usage_event_corrections_write ON usage_event_corrections FOR INSERT WITH CHECK (app.is_platform_operator());

CREATE POLICY billing_notifications_read ON billing_notifications FOR SELECT USING (
  app.billing_account_access(billing_account_id) IS NOT NULL
);
CREATE POLICY billing_notifications_write ON billing_notifications FOR INSERT WITH CHECK (app.actor_kind() = 'system' OR app.is_platform_operator());
-- Account managers mark notifications read; nothing else about a notification changes.
CREATE POLICY billing_notifications_mark_read ON billing_notifications FOR UPDATE
  USING (app.billing_account_access(billing_account_id) IN ('manage','view','operate'))
  WITH CHECK (app.billing_account_access(billing_account_id) IN ('manage','view','operate'));
CREATE POLICY billing_notifications_jobs ON billing_notifications TO medveris_jobs USING (true) WITH CHECK (true);
CREATE FUNCTION app.billing_notification_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_account_id <> OLD.billing_account_id OR NEW.kind <> OLD.kind OR NEW.title <> OLD.title OR NEW.body <> OLD.body
     OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'billing_notification_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_notifications_guard BEFORE UPDATE ON billing_notifications
FOR EACH ROW EXECUTE FUNCTION app.billing_notification_guard();

CREATE POLICY tier_recommendations_read ON tier_recommendations FOR SELECT USING (
  app.billing_account_access(billing_account_id) IS NOT NULL
);
CREATE POLICY tier_recommendations_update ON tier_recommendations FOR UPDATE
  USING (app.actor_kind() = 'system') WITH CHECK (app.actor_kind() = 'system');
CREATE POLICY tier_recommendations_jobs ON tier_recommendations TO medveris_jobs USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON subscriptions, subscription_invoices, subscription_payments, billing_notifications, tier_recommendations, usage_events TO medveris_runtime;
GRANT SELECT, INSERT ON subscription_events, trial_claims, subscription_consents, subscription_invoice_lines, usage_event_corrections TO medveris_runtime;
GRANT SELECT, INSERT, UPDATE ON subscriptions, subscription_invoices, billing_notifications, tier_recommendations, usage_events TO medveris_jobs;
GRANT SELECT, INSERT ON subscription_events, subscription_invoice_lines TO medveris_jobs;
GRANT SELECT ON subscription_consents, subscription_payments TO medveris_jobs;
GRANT SELECT ON uploads, memberships TO medveris_jobs;
CREATE POLICY uploads_jobs_usage ON uploads FOR SELECT TO medveris_jobs USING (true);
CREATE POLICY memberships_jobs_usage ON memberships FOR SELECT TO medveris_jobs USING (true);

-- ---------------------------------------------------------------- existing workspaces get an account and a trial

-- Every organization pays for the workspaces it created or approved; every other workspace pays for
-- itself. Their seven-day trial starts now, when billing is activated for them.
ALTER TABLE billing_accounts NO FORCE ROW LEVEL SECURITY;
INSERT INTO billing_accounts (id, kind, name, owner_organization_id, created_by)
SELECT gen_random_uuid(), 'organization', o.name, o.id, o.created_by FROM organizations o;
UPDATE tenants t SET billing_account_id = a.id
  FROM billing_accounts a WHERE a.owner_organization_id = t.organization_id AND t.organization_id IS NOT NULL;
INSERT INTO billing_accounts (id, kind, name, owner_tenant_id, created_by)
SELECT gen_random_uuid(), 'independent-facility', t.name, t.id, t.created_by FROM tenants t WHERE t.billing_account_id IS NULL;
UPDATE tenants t SET billing_account_id = a.id FROM billing_accounts a WHERE a.owner_tenant_id = t.id AND t.billing_account_id IS NULL;

ALTER TABLE subscriptions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_events NO FORCE ROW LEVEL SECURITY;
INSERT INTO subscriptions (id, billing_account_id, plan_id, status, trial_started_at, trial_ends_at, status_reason)
SELECT gen_random_uuid(), a.id, 'c0000000-0000-4000-8000-000000000001', 'trialing', now(), now() + interval '7 days',
       'Billing activated for an existing account'
  FROM billing_accounts a;
INSERT INTO subscription_events (subscription_id, billing_account_id, event, to_status, to_plan_id, actor_kind, detail)
SELECT s.id, s.billing_account_id, 'trial-started', 'trialing', s.plan_id, 'system', jsonb_build_object('reason', 'billing activated for an existing account')
  FROM subscriptions s;
ALTER TABLE subscription_events FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_accounts FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- referral sharing across organizations

-- A referral to another Medveris workspace may share a limited set of record categories with that
-- workspace for a bounded time. The share is an exchange grant with the legal basis 'continuing-care',
-- created by a clinician of the referring workspace and readable through the existing audited projection.
ALTER TABLE referrals
  ADD COLUMN to_tenant_id uuid REFERENCES tenants(id),
  ADD COLUMN share_grant_id uuid REFERENCES exchange_grants(id);

GRANT SELECT, INSERT, UPDATE ON exchange_grants TO medveris_exchange;
GRANT SELECT, UPDATE ON referrals TO medveris_exchange;
GRANT SELECT ON tenant_patient_links TO medveris_exchange;
CREATE FUNCTION app.create_referral_share(p_referral uuid, p_recipient uuid, p_categories text[], p_days integer, p_purpose text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ref record;
  grant_id uuid := gen_random_uuid();
BEGIN
  IF app.actor_kind() <> 'staff' OR NOT app.has_any_role(ARRAY['clinician','specialist_clinician']) THEN
    RAISE EXCEPTION 'referral_share_forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 30 THEN
    RAISE EXCEPTION 'referral_share_duration' USING ERRCODE = '23514';
  END IF;
  IF p_categories IS NULL OR cardinality(p_categories) = 0 OR NOT (p_categories <@ ARRAY['encounter','note','observation','condition','allergy','referral']::text[]) THEN
    RAISE EXCEPTION 'referral_share_categories' USING ERRCODE = '23514';
  END IF;
  SELECT r.id, r.tenant_id, r.patient_id, r.status, r.share_grant_id INTO ref FROM referrals r
   WHERE r.id = p_referral AND r.tenant_id = app.current_tenant() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'referral_share_not_found' USING ERRCODE = '42501';
  END IF;
  IF ref.share_grant_id IS NOT NULL THEN
    RAISE EXCEPTION 'referral_share_exists' USING ERRCODE = '23505';
  END IF;
  IF ref.status IN ('declined','cancelled') THEN
    RAISE EXCEPTION 'referral_share_closed' USING ERRCODE = '23514';
  END IF;
  IF p_recipient = ref.tenant_id OR NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = p_recipient AND t.status = 'active') THEN
    RAISE EXCEPTION 'referral_share_recipient' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_patient_links l WHERE l.tenant_id = ref.tenant_id AND l.patient_id = ref.patient_id) THEN
    RAISE EXCEPTION 'referral_share_patient' USING ERRCODE = '42501';
  END IF;
  INSERT INTO exchange_grants (id, patient_id, grantor_user_id, recipient_tenant_id, source_tenant_ids, categories, purpose, legal_basis,
    authorization_evidence, policy_version, sensitivity_exclusions, starts_at, expires_at)
  VALUES (grant_id, ref.patient_id, app.current_user(), p_recipient, ARRAY[ref.tenant_id], p_categories, p_purpose, 'continuing-care',
    'referral:' || ref.id, 'medveris-referral-share-1.0', ARRAY['mental-health','sexual-health','hiv','substance-use']::text[], now(), now() + make_interval(days => p_days));
  UPDATE referrals SET to_tenant_id = p_recipient, share_grant_id = grant_id WHERE id = ref.id;
  RETURN grant_id;
END;
$$;
ALTER FUNCTION app.create_referral_share(uuid, uuid, text[], integer, text) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.create_referral_share(uuid, uuid, text[], integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_referral_share(uuid, uuid, text[], integer, text) TO medveris_runtime;

CREATE FUNCTION app.revoke_referral_share(p_referral uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  grant_id uuid;
BEGIN
  IF app.actor_kind() <> 'staff' OR NOT app.has_any_role(ARRAY['clinician','specialist_clinician','facility_admin']) THEN
    RAISE EXCEPTION 'referral_share_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT r.share_grant_id INTO grant_id FROM referrals r WHERE r.id = p_referral AND r.tenant_id = app.current_tenant();
  IF grant_id IS NULL THEN
    RAISE EXCEPTION 'referral_share_not_found' USING ERRCODE = '42501';
  END IF;
  UPDATE exchange_grants SET revoked_at = now(), revoked_by = app.current_user(), revoked_reason = p_reason
   WHERE id = grant_id AND revoked_at IS NULL;
  RETURN grant_id;
END;
$$;
ALTER FUNCTION app.revoke_referral_share(uuid, text) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.revoke_referral_share(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.revoke_referral_share(uuid, text) TO medveris_runtime;

-- Referring and receiving workspaces see the shares that concern them; the patient keeps seeing theirs.
CREATE POLICY grants_referral_staff ON exchange_grants FOR SELECT USING (
  app.actor_kind() = 'staff' AND legal_basis = 'continuing-care'
  AND (recipient_tenant_id = app.current_tenant() OR app.current_tenant() = ANY(source_tenant_ids))
);

COMMIT;
