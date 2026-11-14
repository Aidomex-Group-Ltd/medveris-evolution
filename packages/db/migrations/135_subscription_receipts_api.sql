-- Phase 5: API and query enhancements for receipts
-- This migration adds SQL functions to query the receipts table added in migration 134
-- All changes are additive and backward compatible.

BEGIN;

-- ---------------------------------------------------------------- function to fetch receipts for a billing account

CREATE OR REPLACE FUNCTION app.subscription_receipts_for_account(p_billing_account_id uuid)
RETURNS TABLE (
  id uuid,
  provider text,
  provider_reference text,
  amount_ugx bigint,
  currency text,
  status text,
  received_at timestamptz,
  recorded_by uuid
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT r.id, r.provider, r.provider_reference, r.amount_ugx, r.currency, r.status, r.received_at, r.recorded_by
  FROM receipts r
  WHERE r.billing_account_id = p_billing_account_id
  ORDER BY r.received_at DESC;
$$;

GRANT EXECUTE ON FUNCTION app.subscription_receipts_for_account(uuid) TO medveris_runtime;
GRANT EXECUTE ON FUNCTION app.subscription_receipts_for_account(uuid) TO medveris_exchange;

-- ---------------------------------------------------------------- function to fetch a single receipt by checkout_id

CREATE OR REPLACE FUNCTION app.subscription_receipt_for_checkout(p_checkout_id uuid)
RETURNS TABLE (
  id uuid,
  provider text,
  provider_reference text,
  amount_ugx bigint,
  currency text,
  status text,
  received_at timestamptz,
  recorded_by uuid
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT r.id, r.provider, r.provider_reference, r.amount_ugx, r.currency, r.status, r.received_at, r.recorded_by
  FROM receipts r
  WHERE r.checkout_id = p_checkout_id;
$$;

GRANT EXECUTE ON FUNCTION app.subscription_receipt_for_checkout(uuid) TO medveris_runtime;
GRANT EXECUTE ON FUNCTION app.subscription_receipt_for_checkout(uuid) TO medveris_exchange;

COMMIT;