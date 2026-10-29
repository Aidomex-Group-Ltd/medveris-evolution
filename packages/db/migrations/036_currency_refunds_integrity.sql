-- Local currencies, locked conversion rates, refunds, bill voiding, billing waivers and deterministic
-- integrity checkpoints.
--
-- Currency: a facility prices and bills in the currency of its country unless an administrator enables
-- another; every payment and refund now records its currency, always the bill's currency. Converting a
-- price uses a rate locked from a conversion provider, with the provider, fetch time and expiry stored.
--
-- Refunds are append-only and never alter the original payment. A bill without any net payment can be
-- voided with a reason; its lines are released so the work can be billed again. Billable work that will
-- not be charged is waived by finance with a reason instead of disappearing.
--
-- Integrity checkpoints now record exactly which audit events they cover, so verification recomputes the
-- same leaves the job used. Checkpoints taken before this migration are marked as range-based.
--
-- Additive: existing rows keep their meaning; historical invoices keep their recorded currency.

BEGIN;

-- ---------------------------------------------------------------- currencies

ALTER TABLE facility_billing_settings DROP CONSTRAINT facility_billing_settings_allowed_currencies_check;
CREATE FUNCTION app.valid_currency_codes(codes text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(codes) > 0 AND NOT EXISTS (SELECT 1 FROM unnest(codes) c WHERE c !~ '^[A-Z]{3}$')
$$;
ALTER TABLE facility_billing_settings ADD CONSTRAINT facility_billing_settings_currencies_check CHECK (app.valid_currency_codes(allowed_currencies));
ALTER TABLE facility_billing_settings ALTER COLUMN allowed_currencies DROP DEFAULT;

-- Every payment is in its bill's currency; recorded explicitly so exports never infer it.
ALTER TABLE payments ADD COLUMN currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
ALTER TABLE payments NO FORCE ROW LEVEL SECURITY;
UPDATE payments p SET currency = i.currency FROM invoices i WHERE i.id = p.invoice_id AND p.currency IS NULL;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE FUNCTION app.payment_currency_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bill_currency text;
BEGIN
  SELECT currency INTO bill_currency FROM invoices WHERE id = NEW.invoice_id;
  IF NEW.currency IS NULL THEN
    NEW.currency := bill_currency;
  ELSIF NEW.currency <> bill_currency THEN
    RAISE EXCEPTION 'payment_currency_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payments_currency_guard BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION app.payment_currency_guard();

-- Yo! collects whole Uganda shillings only.
ALTER TABLE mobile_money_requests ADD CONSTRAINT mobile_money_requests_yo_ugx
  CHECK (provider <> 'yo' OR (currency = 'UGX' AND amount = trunc(amount)));

-- Rates fetched from a conversion provider, locked for a short time so the administrator confirms the
-- exact rate that is applied. Used once; never applied at billing time.
CREATE TABLE fx_rate_locks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  catalog_item_id uuid REFERENCES service_catalog(id),
  base_currency text NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  quote_currency text NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
  rate numeric(28,12) NOT NULL CHECK (rate > 0),
  source_amount numeric NOT NULL CHECK (source_amount >= 0),
  converted_amount numeric NOT NULL CHECK (converted_amount >= 0),
  provider text NOT NULL,
  provider_timestamp timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  locked_by uuid NOT NULL REFERENCES users(id),
  used_at timestamptz,
  catalog_version integer,
  CHECK (base_currency <> quote_currency),
  CHECK (expires_at > fetched_at)
);
CREATE INDEX fx_rate_locks_item_idx ON fx_rate_locks(tenant_id, catalog_item_id, fetched_at);
ALTER TABLE fx_rate_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rate_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY fx_rate_locks_price_managers ON fx_rate_locks USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin']));
GRANT SELECT, INSERT, UPDATE ON fx_rate_locks TO medveris_runtime;

ALTER TABLE service_price_history ADD COLUMN fx_rate_lock_id uuid REFERENCES fx_rate_locks(id);
CREATE OR REPLACE FUNCTION app.service_price_history_capture() RETURNS trigger
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
    previous_status, new_status, previous_active, new_active, reason, changed_by, fx_rate_lock_id)
  VALUES (NEW.tenant_id, NEW.id, NEW.version, kind,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.price END, NEW.price,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.currency END, NEW.currency,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.price_status END, NEW.price_status,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.active END, NEW.active,
    NULLIF(current_setting('app.price_change_reason', true), ''),
    coalesce(NEW.updated_by, NEW.created_by),
    NULLIF(current_setting('app.fx_rate_lock_id', true), '')::uuid);
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- refunds

CREATE TABLE payment_refunds (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES payments(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  method text NOT NULL CHECK (method IN ('cash','mobile-money','bank-transfer','other')),
  reference text,
  reason text NOT NULL CHECK (length(reason) >= 5),
  receipt_number text NOT NULL,
  idempotency_key text NOT NULL,
  refunded_by uuid NOT NULL REFERENCES users(id),
  refunded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, receipt_number),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX payment_refunds_invoice_idx ON payment_refunds(invoice_id, refunded_at);
CREATE TRIGGER payment_refunds_immutable BEFORE UPDATE OR DELETE ON payment_refunds
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();

-- A refund belongs to the payment's bill, is in its currency, and never exceeds what is left of it.
CREATE FUNCTION app.payment_refund_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  paid record;
  refunded numeric;
BEGIN
  SELECT p.amount, p.invoice_id, p.reversed_at, p.tenant_id, coalesce(p.currency, i.currency) AS currency INTO paid
    FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = NEW.payment_id FOR UPDATE OF p;
  IF paid IS NULL OR paid.tenant_id <> NEW.tenant_id OR paid.invoice_id <> NEW.invoice_id THEN
    RAISE EXCEPTION 'refund_payment_mismatch' USING ERRCODE = '23514';
  END IF;
  IF paid.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'refund_payment_reversed' USING ERRCODE = '23514';
  END IF;
  IF NEW.currency <> paid.currency THEN
    RAISE EXCEPTION 'refund_currency_mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO refunded FROM payment_refunds WHERE payment_id = NEW.payment_id;
  IF refunded + NEW.amount > paid.amount THEN
    RAISE EXCEPTION 'refund_exceeds_payment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_refunds_guard BEFORE INSERT ON payment_refunds FOR EACH ROW EXECUTE FUNCTION app.payment_refund_guard();

-- A payment with refunds cannot also be reversed; the two corrections are kept apart.
CREATE FUNCTION app.payment_reversal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reversed_at IS NOT NULL AND OLD.reversed_at IS NULL AND EXISTS (SELECT 1 FROM payment_refunds r WHERE r.payment_id = NEW.id) THEN
    RAISE EXCEPTION 'payment_has_refunds' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payments_reversal_guard BEFORE UPDATE OF reversed_at ON payments FOR EACH ROW EXECUTE FUNCTION app.payment_reversal_guard();

ALTER TABLE payment_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_refunds_read ON payment_refunds FOR SELECT USING (
  tenant_id = app.current_tenant() AND (app.has_any_role(ARRAY['finance','facility_admin','auditor']) OR app.actor_kind() = 'system')
);
CREATE POLICY payment_refunds_insert ON payment_refunds FOR INSERT WITH CHECK (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'staff' AND app.has_any_role(ARRAY['finance','facility_admin'])
);
GRANT SELECT, INSERT ON payment_refunds TO medveris_runtime;
GRANT SELECT ON payment_refunds TO medveris_exchange;

-- What a bill has actually collected: unreversed payments less refunds.
CREATE FUNCTION app.invoice_net_paid(p_invoice uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT sum(p.amount) FROM payments p WHERE p.invoice_id = p_invoice AND p.reversed_at IS NULL), 0)
       - coalesce((SELECT sum(r.amount) FROM payment_refunds r WHERE r.invoice_id = p_invoice), 0)
$$;

-- ---------------------------------------------------------------- voiding and waivers

ALTER TABLE invoices
  ADD COLUMN void_reason text,
  ADD COLUMN voided_by uuid REFERENCES users(id),
  ADD COLUMN voided_at timestamptz,
  ADD CONSTRAINT invoices_void_reason CHECK (status <> 'void' OR void_reason IS NOT NULL OR voided_at IS NULL);

-- A line on a voided bill is released, so its request or supplied item can be billed again.
ALTER TABLE invoice_items ADD COLUMN released_at timestamptz;
DROP INDEX invoice_items_recommendation_once;
DROP INDEX invoice_items_supply_once;
CREATE UNIQUE INDEX invoice_items_recommendation_once ON invoice_items(recommendation_id) WHERE recommendation_id IS NOT NULL AND released_at IS NULL;
CREATE UNIQUE INDEX invoice_items_supply_once ON invoice_items(supply_usage_id) WHERE supply_usage_id IS NOT NULL AND released_at IS NULL;

ALTER TABLE care_recommendations DROP CONSTRAINT care_recommendations_billing_status_check;
ALTER TABLE care_recommendations ADD CONSTRAINT care_recommendations_billing_status_check CHECK (billing_status IN ('unbilled','billed','part-paid','paid','waived'));
ALTER TABLE care_recommendations
  ADD COLUMN waived_by uuid REFERENCES users(id),
  ADD COLUMN waived_at timestamptz,
  ADD COLUMN waive_reason text,
  ADD CONSTRAINT care_recommendations_waiver CHECK (billing_status <> 'waived' OR (waived_at IS NOT NULL AND waive_reason IS NOT NULL));
ALTER TABLE care_recommendation_events DROP CONSTRAINT care_recommendation_events_event_check;
ALTER TABLE care_recommendation_events ADD CONSTRAINT care_recommendation_events_event_check
  CHECK (event IN ('created','updated','status-changed','billed','unbilled','payment-updated','waived'));

ALTER TABLE care_supply_usages DROP CONSTRAINT care_supply_usages_billing_status_check;
ALTER TABLE care_supply_usages ADD CONSTRAINT care_supply_usages_billing_status_check CHECK (billing_status IN ('unbilled','billed','part-paid','paid','waived'));
ALTER TABLE care_supply_usages
  ADD COLUMN waived_by uuid REFERENCES users(id),
  ADD COLUMN waived_at timestamptz,
  ADD COLUMN waive_reason text,
  ADD CONSTRAINT care_supply_usages_waiver CHECK (billing_status <> 'waived' OR (waived_at IS NOT NULL AND waive_reason IS NOT NULL));

-- ---------------------------------------------------------------- deterministic checkpoints

-- Exactly which events a checkpoint sealed, in leaf order. An event is sealed once.
CREATE TABLE integrity_checkpoint_events (
  checkpoint_id uuid NOT NULL REFERENCES integrity_checkpoints(id),
  event_id uuid NOT NULL REFERENCES audit_events(id),
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (checkpoint_id, position),
  UNIQUE (event_id)
);
CREATE TRIGGER integrity_checkpoint_events_immutable BEFORE UPDATE OR DELETE ON integrity_checkpoint_events
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();
ALTER TABLE integrity_checkpoints ADD COLUMN leaf_selection text NOT NULL DEFAULT 'time-range' CHECK (leaf_selection IN ('time-range','recorded'));
GRANT SELECT, INSERT ON integrity_checkpoint_events TO medveris_jobs;
GRANT SELECT ON integrity_checkpoint_events TO medveris_exchange, medveris_runtime;
REVOKE UPDATE, DELETE ON integrity_checkpoint_events FROM medveris_jobs;

-- The checkpoint covering each note event: its recorded membership, or for older range-based checkpoints
-- the range that contains it.
CREATE OR REPLACE FUNCTION app.clinical_entry_integrity(p_entry uuid)
RETURNS TABLE (
  event_id uuid, action text, occurred_at timestamptz, event_hash text, previous_hash text, signature_key_id text,
  checkpoint_id uuid, batch_number integer, event_count integer, merkle_root text, checkpoint_signature_key_id text,
  checkpoint_created_at timestamptz, ledger_state text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.action, a.occurred_at, a.event_hash, a.previous_hash, a.signature_key_id,
         k.id, k.batch_number, k.event_count, k.merkle_root, k.signature_key_id, k.created_at, k.ledger_state
    FROM clinical_entries ce
    JOIN audit_events a ON a.tenant_id = ce.tenant_id AND (
         (a.resource_type = 'ClinicalEntry' AND a.resource_id = ce.id)
      OR (a.resource_type = 'ClinicalEntryVersion' AND a.metadata->>'entryId' = ce.id::text))
    LEFT JOIN integrity_checkpoint_events m ON m.event_id = a.id
    LEFT JOIN LATERAL (
      SELECT c.* FROM integrity_checkpoints c
       WHERE (m.checkpoint_id IS NOT NULL AND c.id = m.checkpoint_id)
          OR (m.checkpoint_id IS NULL AND c.leaf_selection = 'time-range' AND c.tenant_id = a.tenant_id
              AND a.occurred_at >= c.range_start AND a.occurred_at <= c.range_end)
       ORDER BY c.batch_number LIMIT 1
    ) k ON true
   WHERE ce.id = p_entry AND ce.tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
   ORDER BY a.occurred_at, a.id
$$;

-- Leaves of one checkpoint in the order they were sealed; range-based checkpoints fall back to their range.
CREATE OR REPLACE FUNCTION app.integrity_checkpoint_leaves(p_checkpoint uuid) RETURNS TABLE (id uuid, event_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT leaf.id, leaf.event_hash FROM (
    SELECT a.id, a.event_hash, m.position::bigint AS ordinal, a.occurred_at
      FROM integrity_checkpoints k
      JOIN integrity_checkpoint_events m ON m.checkpoint_id = k.id
      JOIN audit_events a ON a.id = m.event_id
     WHERE k.id = p_checkpoint AND k.leaf_selection = 'recorded' AND k.tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
    UNION ALL
    SELECT a.id, a.event_hash, 0::bigint, a.occurred_at
      FROM integrity_checkpoints k
      JOIN audit_events a ON a.tenant_id = k.tenant_id AND a.occurred_at >= k.range_start AND a.occurred_at <= k.range_end
     WHERE k.id = p_checkpoint AND k.leaf_selection = 'time-range' AND k.tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
  ) leaf
  ORDER BY leaf.ordinal, leaf.occurred_at, leaf.id
$$;

COMMIT;
