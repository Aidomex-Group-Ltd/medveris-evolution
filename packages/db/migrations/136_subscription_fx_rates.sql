-- Subscription FX rate sources for USD/UGX checkout pricing.
--
-- Adds: (1) a cached latest provider-fetched rate and (2) operator-set manual rates with audit
-- fields and expiry. A checkout must always be priced from a valid, non-stale source; manual rates
-- are only a fallback when the provider is unavailable or unset. Expand-only, no data rewrite.

BEGIN;

-- Latest provider-fetched rate per pair, kept so pricing can be served from a recent cached value
-- and so the provider does not have to be reachable on every quote. fetched_at is the cache time;
-- provider_timestamp is when the market published the rate.
CREATE TABLE subscription_fx_rates (
  base text NOT NULL,
  quote text NOT NULL,
  rate numeric(18, 8) NOT NULL CHECK (rate > 0),
  provider text NOT NULL,
  provider_timestamp timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (base, quote)
);

-- Operator-set manual rates (break-glass/fallback). Only a non-expired row whose expires_at is in
-- the future may be used, and never in preference to a fresh provider/cached rate when one is valid.
CREATE TABLE subscription_fx_manual_rates (
  id uuid PRIMARY KEY,
  base text NOT NULL,
  quote text NOT NULL,
  rate numeric(18, 8) NOT NULL CHECK (rate > 0),
  set_by uuid REFERENCES users(id),
  set_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  note text,
  CHECK (expires_at > set_at)
);
CREATE INDEX subscription_fx_manual_rates_pair_idx
  ON subscription_fx_manual_rates(base, quote, expires_at DESC);

-- Row-level security: reads for authorized actors; writes by the system/service (and operator flows
-- run in the billing/system context that owns this table). No secrets are stored here.
ALTER TABLE subscription_fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_fx_rates FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_fx_manual_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_fx_manual_rates FORCE ROW LEVEL SECURITY;

CREATE POLICY subscription_fx_rates_read ON subscription_fx_rates FOR SELECT USING (
  app.actor_kind() IN ('staff','system','registration')
);
CREATE POLICY subscription_fx_rates_write ON subscription_fx_rates FOR INSERT WITH CHECK (app.actor_kind() = 'system');
CREATE POLICY subscription_fx_rates_update ON subscription_fx_rates FOR UPDATE
  USING (app.actor_kind() = 'system') WITH CHECK (app.actor_kind() = 'system');

CREATE POLICY subscription_fx_manual_rates_read ON subscription_fx_manual_rates FOR SELECT USING (
  app.actor_kind() IN ('staff','system','registration')
);
CREATE POLICY subscription_fx_manual_rates_write ON subscription_fx_manual_rates FOR INSERT WITH CHECK (app.actor_kind() = 'system');
CREATE POLICY subscription_fx_manual_rates_update ON subscription_fx_manual_rates FOR UPDATE
  USING (app.actor_kind() = 'system') WITH CHECK (app.actor_kind() = 'system');

GRANT SELECT, INSERT, UPDATE ON subscription_fx_rates TO medveris_runtime;
GRANT SELECT, INSERT, UPDATE ON subscription_fx_manual_rates TO medveris_runtime;
GRANT SELECT ON subscription_fx_rates, subscription_fx_manual_rates TO medveris_exchange;

COMMIT;
