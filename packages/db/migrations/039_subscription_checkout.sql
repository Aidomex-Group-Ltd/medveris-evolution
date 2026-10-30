-- Self-service subscription checkout with Yo! mobile money.
--
-- A customer chooses a billing interval (day, week, month, quarter or year), pays the UGX equivalent
-- of USD 0.50 per active user for one period, and the paid period is recorded here. Renewal is
-- manual: there is no stored mandate and no automatic charge, because the Yo! collection API sends a
-- one-off prompt and never a recurring debit. Each checkout keeps the exact exchange rate, its source
-- and timestamps so the disclosed UGX amount can be reproduced later.
--
-- Additive and backward compatible with earlier releases.

BEGIN;

ALTER TABLE subscriptions
  ADD COLUMN billing_interval text CHECK (billing_interval IN ('daily','weekly','monthly','quarterly','annually')),
  ADD COLUMN seats integer CHECK (seats > 0),
  ADD COLUMN renewal_mode text NOT NULL DEFAULT 'manual' CHECK (renewal_mode IN ('manual')),
  ADD COLUMN next_renewal_at timestamptz;

CREATE TABLE subscription_checkouts (
  id uuid PRIMARY KEY,
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(id),
  subscription_id uuid REFERENCES subscriptions(id),
  interval text NOT NULL CHECK (interval IN ('daily','weekly','monthly','quarterly','annually')),
  seats integer NOT NULL CHECK (seats > 0),
  unit_price_usd_minor integer NOT NULL CHECK (unit_price_usd_minor > 0),
  amount_usd_minor integer NOT NULL CHECK (amount_usd_minor > 0),
  amount_ugx bigint NOT NULL CHECK (amount_ugx > 0),
  fx_base text NOT NULL DEFAULT 'USD' CHECK (fx_base = 'USD'),
  fx_quote text NOT NULL DEFAULT 'UGX' CHECK (fx_quote = 'UGX'),
  fx_rate numeric(18, 8) NOT NULL CHECK (fx_rate > 0),
  fx_source text NOT NULL,
  fx_provider_timestamp timestamptz,
  fx_recorded_at timestamptz NOT NULL,
  fx_rounding text NOT NULL DEFAULT 'ceil-whole-shilling' CHECK (fx_rounding = 'ceil-whole-shilling'),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  product text NOT NULL,
  disclosure text NOT NULL,
  consent_accepted_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','cancelled','indeterminate')),
  msisdn text NOT NULL,
  provider text NOT NULL DEFAULT 'yo' CHECK (provider = 'yo'),
  provider_mode text NOT NULL,
  external_reference text NOT NULL UNIQUE,
  provider_reference text,
  network_reference text,
  idempotency_key text NOT NULL,
  status_detail text,
  failure_reason text,
  initiated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (period_end > period_start),
  CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
  UNIQUE (billing_account_id, idempotency_key)
);
-- One unresolved prompt per account, so a retried click or a second tab cannot prompt twice.
CREATE UNIQUE INDEX subscription_checkouts_one_pending
  ON subscription_checkouts(billing_account_id) WHERE status IN ('pending', 'indeterminate');
CREATE INDEX subscription_checkouts_account_idx ON subscription_checkouts(billing_account_id, created_at DESC);

CREATE TABLE subscription_checkout_events (
  id uuid PRIMARY KEY,
  checkout_id uuid NOT NULL REFERENCES subscription_checkouts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('initiate','ipn','failure-notification','status-check','cancel')),
  dedupe_key text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied','ignored','rejected','duplicate')),
  provider_status text,
  payload_digest text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkout_id, dedupe_key)
);

ALTER TABLE subscription_checkouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_checkouts FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_checkout_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_checkout_events FORCE ROW LEVEL SECURITY;

-- Customers read their account's checkouts; only the billing service writes them, after the API has
-- authorized the caller against the billing account.
CREATE POLICY subscription_checkouts_read ON subscription_checkouts FOR SELECT USING (
  app.billing_account_access(billing_account_id) IS NOT NULL OR app.actor_kind() IN ('system','registration')
);
CREATE POLICY subscription_checkouts_write ON subscription_checkouts FOR INSERT WITH CHECK (app.actor_kind() = 'system');
CREATE POLICY subscription_checkouts_update ON subscription_checkouts FOR UPDATE
  USING (app.actor_kind() = 'system') WITH CHECK (app.actor_kind() = 'system');
CREATE POLICY subscription_checkout_events_read ON subscription_checkout_events FOR SELECT USING (
  EXISTS (SELECT 1 FROM subscription_checkouts c WHERE c.id = checkout_id)
);
CREATE POLICY subscription_checkout_events_write ON subscription_checkout_events FOR INSERT WITH CHECK (app.actor_kind() = 'system');
CREATE POLICY subscription_checkout_events_update ON subscription_checkout_events FOR UPDATE
  USING (app.actor_kind() = 'system') WITH CHECK (app.actor_kind() = 'system');

GRANT SELECT, INSERT, UPDATE ON subscription_checkouts TO medveris_runtime;
GRANT SELECT, INSERT, UPDATE ON subscription_checkout_events TO medveris_runtime;
GRANT SELECT ON subscription_checkouts, subscription_checkout_events TO medveris_exchange;

-- Resolves a Yo! reference to the workspace the callback must run in, without exposing another
-- account's identifiers to the caller (which has no session).
CREATE FUNCTION app.subscription_checkout_tenant(p_reference text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(a.owner_tenant_id, (SELECT t.id FROM tenants t WHERE t.billing_account_id = a.id ORDER BY t.created_at LIMIT 1))
    FROM subscription_checkouts c JOIN billing_accounts a ON a.id = c.billing_account_id
   WHERE c.external_reference = p_reference OR (c.provider = 'yo' AND c.provider_reference = p_reference)
   ORDER BY (c.external_reference = p_reference) DESC
   LIMIT 1
$$;
ALTER FUNCTION app.subscription_checkout_tenant(text) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.subscription_checkout_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.subscription_checkout_tenant(text) TO medveris_runtime;

COMMIT;
