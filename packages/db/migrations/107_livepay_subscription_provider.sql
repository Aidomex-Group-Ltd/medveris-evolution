-- LivePay as a second subscription-checkout provider.
--
-- Expand-only: the existing Yo! provider value and every in-flight checkout remain valid, while the
-- check constraint starts accepting the LivePay adapter. The reference resolver stops depending on
-- the provider column so a signed LivePay webhook can find the workspace that owns the reference.
-- No historical row is rewritten and the currently serving Worker version keeps working unchanged.

BEGIN;

ALTER TABLE subscription_checkouts
  DROP CONSTRAINT subscription_checkouts_provider_check;

ALTER TABLE subscription_checkouts
  ADD CONSTRAINT subscription_checkouts_provider_check
  CHECK (provider IN ('yo', 'livepay'));

CREATE INDEX IF NOT EXISTS subscription_checkouts_provider_reference_idx
  ON subscription_checkouts(provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE OR REPLACE FUNCTION app.subscription_checkout_tenant(p_reference text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(a.owner_tenant_id, (SELECT t.id FROM tenants t WHERE t.billing_account_id = a.id ORDER BY t.created_at LIMIT 1))
    FROM subscription_checkouts c JOIN billing_accounts a ON a.id = c.billing_account_id
   WHERE c.external_reference = p_reference OR c.provider_reference = p_reference
   ORDER BY (c.external_reference = p_reference) DESC
   LIMIT 1
$$;

-- CREATE OR REPLACE keeps the existing owner (medveris_exchange); restate grants explicitly so a
-- fresh database and an upgraded database have identical privileges.
ALTER FUNCTION app.subscription_checkout_tenant(text) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.subscription_checkout_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.subscription_checkout_tenant(text) TO medveris_runtime;

COMMIT;
