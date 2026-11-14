-- Phase 4: Subscription receipts, payment extensions, and event history for checkout reconciliation
--
-- This migration adds:
--   1. receipts table: stores provider receipts from LivePay/Yo! collections
--   2. subscription_payments extensions: checkout_id reference and provider fields
--   3. subscription_events extensions: status-check and provider-reconciliation event types
--   4. indexes for checkout reconciliation lookups
--
-- All changes are additive and backward compatible.

BEGIN;

-- ---------------------------------------------------------------- receipts table

-- Receipts store the authoritative provider record for a completed or pending
-- checkout. One receipt per checkout (unique on checkout_id), denoting the
-- provider‑reported amount, currency, and reference so the API can reconcile
-- webhooks or status checks without re‑querying the provider unless needed.

CREATE TABLE receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id uuid NOT NULL REFERENCES subscription_checkouts(id) ON DELETE CASCADE,
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(id),
  provider text NOT NULL CHECK (provider IN ('livepay','yo')),
  provider_reference text NOT NULL,
  amount_ugx bigint NOT NULL CHECK (amount_ugx > 0),
  currency text NOT NULL CHECK (currency = 'UGX'),
  status text NOT NULL CHECK (status IN ('succeeded','failed','pending','indeterminate')),
  disclosed text NOT NULL, -- JSON string: the original disclosure the user saw
  received_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES users(id),
  UNIQUE (checkout_id)
);

CREATE INDEX receipts_account_idx ON receipts(billing_account_id, received_at DESC);
CREATE INDEX receipts_provider_idx ON receipts(provider, status);

-- ---------------------------------------------------------------- subscription_payments extensions

-- Add checkout linkage so a payment can be traced back to the checkout that triggered it.
-- This is nullable: existing payments (invoices, card, bank) are not affected.

ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS checkout_id uuid REFERENCES subscription_checkouts(id);

-- Provider field: livepay or yo, so the API can route status checks to the right client.

ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS provider text CHECK (provider IN ('livepay','yo'));

-- Provider reference from the provider (e.g. LivePay MTN ref, Yo! msisdn).

ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS provider_reference text;

-- ---------------------------------------------------------------- subscription_events extensions

-- Add event kinds for provider status checks and reconciliation.
-- Existing event kinds from 035 are: initiate, ipn, failure-notification, cancel.
-- New kinds: status-check, provider-reconciliation.

COMMENT ON TABLE subscription_events IS 'Records checkout‑related events including initiate, ipn, failure-notification, status-check, provider-reconciliation, cancel.';

-- ---------------------------------------------------------------- indexes for checkout reconciliation

-- Index to find pending/indeterminate checkouts per billing account quickly.

CREATE INDEX IF NOT EXISTS subscription_checkouts_pending_account_idx
  ON subscription_checkouts(billing_account_id) WHERE status IN ('pending', 'indeterminate');

-- Index to find receipts by provider and status for reconciliation jobs.

CREATE INDEX IF NOT EXISTS receipts_provider_status_idx
  ON receipts(provider, status);

-- Index on subscription_payments checkout linkage.

CREATE INDEX IF NOT EXISTS subscription_payments_checkout_idx
  ON subscription_payments(checkout_id) WHERE checkout_id IS NOT NULL;

-- ---------------------------------------------------------------- row-level security

-- Receipts are written by the billing service (system) and read by operators and the account owner.

ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY receipts_read ON receipts FOR SELECT USING (
  app.billing_account_access(billing_account_id) IS NOT NULL OR app.actor_kind() IN ('system','registration')
);
CREATE POLICY receipts_write ON receipts FOR INSERT WITH CHECK (app.actor_kind() = 'system');
CREATE POLICY receipts_update ON receipts FOR UPDATE
  USING (app.actor_kind() = 'system') WITH CHECK (app.actor_kind() = 'system');

-- Extend existing subscription_events policies to cover new event kinds.
-- The existing read policy already covers all rows; no change needed.

-- Extend subscription_payments read policy to include the new columns (they are part of the same table, no DDL change needed).

COMMIT;