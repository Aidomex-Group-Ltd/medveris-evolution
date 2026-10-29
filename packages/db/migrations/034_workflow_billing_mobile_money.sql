-- Organization patient workflow, priced services/procedures/supplies, bills built from a visit, and
-- point-of-sale payments by cash or Yo! mobile money.
--
-- Reception records a visit (encounters); a clinician recommends services or procedures
-- (care_recommendations), each routed to a department work queue and progressed there with an
-- append-only event trail. Departments record supplied items (care_supply_usages). A cashier bills
-- recommended, completed and supplied work from the visit; partial unique indexes make sure each
-- recommendation and each supply line is charged at most once. Mobile money requests are idempotent
-- per client key and per provider reference, and provider callbacks are applied once.
--
-- Additive only: existing rows keep their meaning, new columns are nullable or defaulted, and replaced
-- policies accept every row and role the previous versions accepted.

BEGIN;

-- ---------------------------------------------------------------- workspace restore

-- The workspace a user last worked in, reopened at their next sign-in.
ALTER TABLE users ADD COLUMN last_active_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- price list

ALTER TABLE service_catalog DROP CONSTRAINT service_catalog_category_check;
ALTER TABLE service_catalog ADD CONSTRAINT service_catalog_category_check CHECK (category IN (
  'consultation','procedure','laboratory','imaging','pharmacy','bed','other','theatre','nursing','supply'
));
ALTER TABLE service_catalog
  ADD COLUMN item_type text NOT NULL DEFAULT 'service' CHECK (item_type IN ('service','procedure','supply','pharmacy-item')),
  ADD COLUMN department_id uuid REFERENCES departments(id),
  ADD COLUMN description text,
  ADD COLUMN unit_of_measure text,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN updated_by uuid REFERENCES users(id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE service_catalog SET item_type = 'procedure' WHERE category = 'procedure';
UPDATE service_catalog SET item_type = 'pharmacy-item' WHERE category = 'pharmacy';
CREATE INDEX service_catalog_active_idx ON service_catalog(tenant_id, active, category);

-- Any staff member in the workspace may read prices (departments see what they are requesting or supplying);
-- only finance and facility administrators change them.
DROP POLICY catalog_tenant ON service_catalog;
CREATE POLICY catalog_read ON service_catalog FOR SELECT USING (
  tenant_id = app.current_tenant() AND app.actor_kind() IN ('staff','system')
);
CREATE POLICY catalog_insert ON service_catalog FOR INSERT WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin'])
);
CREATE POLICY catalog_update ON service_catalog FOR UPDATE USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin']));
CREATE POLICY catalog_delete ON service_catalog FOR DELETE USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin'])
);

-- ---------------------------------------------------------------- recommendations and department queues

CREATE TABLE care_recommendations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  target_department text NOT NULL CHECK (target_department IN ('laboratory','imaging','theatre','pharmacy','procedure','other')),
  department_id uuid REFERENCES departments(id),
  catalog_item_id uuid REFERENCES service_catalog(id),
  description text NOT NULL CHECK (length(description) BETWEEN 2 AND 300),
  quantity numeric NOT NULL DEFAULT 1 CHECK (quantity > 0 AND quantity <= 10000),
  priority text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','emergency')),
  instructions text,
  source text NOT NULL DEFAULT 'consultation' CHECK (source IN ('consultation','direct-request')),
  external_referrer text,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','accepted','in-progress','completed','declined','cancelled')),
  status_note text,
  billing_status text NOT NULL DEFAULT 'unbilled' CHECK (billing_status IN ('unbilled','billed','part-paid','paid')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_by uuid REFERENCES users(id),
  accepted_at timestamptz,
  started_at timestamptz,
  completed_by uuid REFERENCES users(id),
  completed_at timestamptz,
  CHECK (status NOT IN ('declined','cancelled') OR status_note IS NOT NULL),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
CREATE UNIQUE INDEX care_recommendations_idempotency ON care_recommendations(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- The same priced item, or the same free-text request, cannot be open twice on one visit.
CREATE UNIQUE INDEX care_recommendations_open_item ON care_recommendations(encounter_id, catalog_item_id)
  WHERE catalog_item_id IS NOT NULL AND status IN ('requested','accepted','in-progress');
CREATE UNIQUE INDEX care_recommendations_open_text ON care_recommendations(encounter_id, target_department, lower(description))
  WHERE catalog_item_id IS NULL AND status IN ('requested','accepted','in-progress');
CREATE INDEX care_recommendations_queue_idx ON care_recommendations(tenant_id, target_department, status, created_at);
CREATE INDEX care_recommendations_encounter_idx ON care_recommendations(encounter_id, created_at);

-- A recommendation always belongs to a visit of the same patient in the same workspace.
CREATE FUNCTION app.care_recommendation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.encounter_id <> OLD.encounter_id OR NEW.patient_id <> OLD.patient_id OR NEW.tenant_id <> OLD.tenant_id THEN
      RAISE EXCEPTION 'care_recommendation_reassignment' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM encounters e WHERE e.id = NEW.encounter_id AND e.tenant_id = NEW.tenant_id AND e.patient_id = NEW.patient_id
  ) THEN
    RAISE EXCEPTION 'care_recommendation_encounter_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER care_recommendations_guard BEFORE INSERT OR UPDATE ON care_recommendations
FOR EACH ROW EXECUTE FUNCTION app.care_recommendation_guard();

-- Who created or changed each request, when, and why. Never updated or deleted.
CREATE TABLE care_recommendation_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recommendation_id uuid NOT NULL REFERENCES care_recommendations(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('created','updated','status-changed','billed','unbilled','payment-updated')),
  from_status text,
  to_status text,
  note text,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid REFERENCES users(id),
  actor_roles text[] NOT NULL DEFAULT ARRAY[]::text[],
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX care_recommendation_events_idx ON care_recommendation_events(recommendation_id, occurred_at);
CREATE TRIGGER care_recommendation_events_immutable BEFORE UPDATE OR DELETE ON care_recommendation_events
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();

-- Items a department supplied during a visit (dressings, contrast, dispensed items), billable once.
CREATE TABLE care_supply_usages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  recommendation_id uuid REFERENCES care_recommendations(id),
  catalog_item_id uuid NOT NULL REFERENCES service_catalog(id),
  quantity numeric NOT NULL CHECK (quantity > 0 AND quantity <= 10000),
  note text,
  billing_status text NOT NULL DEFAULT 'unbilled' CHECK (billing_status IN ('unbilled','billed','part-paid','paid')),
  idempotency_key text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  voided_by uuid REFERENCES users(id),
  voided_at timestamptz,
  void_reason text,
  CHECK (voided_at IS NULL OR void_reason IS NOT NULL)
);
CREATE UNIQUE INDEX care_supply_usages_idempotency ON care_supply_usages(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX care_supply_usages_encounter_idx ON care_supply_usages(encounter_id, recorded_at);

CREATE FUNCTION app.care_supply_usage_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.encounter_id <> OLD.encounter_id OR NEW.patient_id <> OLD.patient_id OR NEW.tenant_id <> OLD.tenant_id
       OR NEW.recommendation_id IS DISTINCT FROM OLD.recommendation_id OR NEW.catalog_item_id <> OLD.catalog_item_id THEN
      RAISE EXCEPTION 'care_supply_reassignment' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM encounters e WHERE e.id = NEW.encounter_id AND e.tenant_id = NEW.tenant_id AND e.patient_id = NEW.patient_id
  ) THEN
    RAISE EXCEPTION 'care_supply_encounter_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.recommendation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM care_recommendations r WHERE r.id = NEW.recommendation_id AND r.encounter_id = NEW.encounter_id
  ) THEN
    RAISE EXCEPTION 'care_supply_recommendation_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER care_supply_usages_guard BEFORE INSERT OR UPDATE ON care_supply_usages
FOR EACH ROW EXECUTE FUNCTION app.care_supply_usage_guard();

ALTER TABLE care_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_recommendations FORCE ROW LEVEL SECURITY;
CREATE POLICY care_recommendations_read ON care_recommendations FOR SELECT USING (
  tenant_id = app.current_tenant() AND app.actor_kind() IN ('staff','system')
);
CREATE POLICY care_recommendations_insert ON care_recommendations FOR INSERT WITH CHECK (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'staff' AND app.has_any_role(ARRAY[
    'clinician','specialist_clinician','nurse','laboratory','radiology','pharmacist','theatre','receptionist','facility_admin'
  ])
);
CREATE POLICY care_recommendations_update ON care_recommendations FOR UPDATE USING (
  tenant_id = app.current_tenant() AND app.actor_kind() IN ('staff','system')
) WITH CHECK (tenant_id = app.current_tenant() AND app.actor_kind() IN ('staff','system'));

ALTER TABLE care_recommendation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_recommendation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY care_recommendation_events_read ON care_recommendation_events FOR SELECT USING (
  tenant_id = app.current_tenant() AND app.actor_kind() IN ('staff','system')
);
CREATE POLICY care_recommendation_events_insert ON care_recommendation_events FOR INSERT WITH CHECK (
  tenant_id = app.current_tenant() AND app.actor_kind() IN ('staff','system')
);

ALTER TABLE care_supply_usages ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_supply_usages FORCE ROW LEVEL SECURITY;
CREATE POLICY care_supply_usages_read ON care_supply_usages FOR SELECT USING (
  tenant_id = app.current_tenant() AND app.actor_kind() IN ('staff','system')
);
CREATE POLICY care_supply_usages_insert ON care_supply_usages FOR INSERT WITH CHECK (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'staff' AND app.has_any_role(ARRAY[
    'clinician','nurse','laboratory','radiology','pharmacist','theatre','facility_admin'
  ])
);
CREATE POLICY care_supply_usages_update ON care_supply_usages FOR UPDATE USING (
  tenant_id = app.current_tenant() AND app.actor_kind() IN ('staff','system')
) WITH CHECK (tenant_id = app.current_tenant() AND app.actor_kind() IN ('staff','system'));

GRANT SELECT, INSERT, UPDATE ON care_recommendations, care_supply_usages TO medveris_runtime;
GRANT SELECT, INSERT ON care_recommendation_events TO medveris_runtime;

-- ---------------------------------------------------------------- bills built from a visit

ALTER TABLE invoice_items
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','recommendation','supply')),
  ADD COLUMN recommendation_id uuid REFERENCES care_recommendations(id),
  ADD COLUMN supply_usage_id uuid REFERENCES care_supply_usages(id),
  ADD COLUMN created_by uuid REFERENCES users(id),
  ADD COLUMN created_at timestamptz DEFAULT now(),
  ADD CONSTRAINT invoice_items_source_link CHECK (
    (source = 'manual' AND recommendation_id IS NULL AND supply_usage_id IS NULL)
    OR (source = 'recommendation' AND recommendation_id IS NOT NULL AND supply_usage_id IS NULL)
    OR (source = 'supply' AND supply_usage_id IS NOT NULL AND recommendation_id IS NULL)
  );
-- Each recommended or supplied item is charged on at most one invoice line.
CREATE UNIQUE INDEX invoice_items_recommendation_once ON invoice_items(recommendation_id) WHERE recommendation_id IS NOT NULL;
CREATE UNIQUE INDEX invoice_items_supply_once ON invoice_items(supply_usage_id) WHERE supply_usage_id IS NOT NULL;
CREATE INDEX invoices_encounter_idx ON invoices(tenant_id, encounter_id, status);

-- ---------------------------------------------------------------- point of sale and mobile money

CREATE TABLE mobile_money_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  provider text NOT NULL DEFAULT 'yo' CHECK (provider IN ('yo')),
  provider_mode text NOT NULL CHECK (provider_mode IN ('sandbox','production')),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  msisdn text NOT NULL CHECK (msisdn ~ '^256[0-9]{9}$'),
  -- Sent to Yo! as ExternalReference; callbacks and status checks are matched on it.
  external_reference text NOT NULL UNIQUE,
  provider_reference text,
  network_reference text,
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','pending','succeeded','failed','indeterminate')),
  status_detail text,
  idempotency_key text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_checked_at timestamptz,
  check_count integer NOT NULL DEFAULT 0,
  payment_id uuid REFERENCES payments(id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (status <> 'succeeded' OR payment_id IS NOT NULL)
);
-- One unresolved prompt per bill, so a retried click cannot send the payer a second request.
CREATE UNIQUE INDEX mobile_money_requests_one_open ON mobile_money_requests(invoice_id)
  WHERE status IN ('initiated','pending','indeterminate');
CREATE UNIQUE INDEX mobile_money_requests_provider_reference ON mobile_money_requests(provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE INDEX mobile_money_requests_invoice_idx ON mobile_money_requests(invoice_id, created_at);

-- Every provider response, callback and status check, applied at most once per dedupe key.
CREATE TABLE mobile_money_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES mobile_money_requests(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('initiate','ipn','failure-notification','status-check')),
  dedupe_key text NOT NULL,
  signature_verified boolean,
  provider_status text,
  outcome text NOT NULL CHECK (outcome IN ('applied','duplicate','ignored','rejected','error')),
  payload_digest text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, dedupe_key)
);
CREATE TRIGGER mobile_money_events_immutable BEFORE UPDATE OR DELETE ON mobile_money_events
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();

ALTER TABLE payments
  ADD COLUMN receipt_number text,
  ADD COLUMN amount_tendered numeric CHECK (amount_tendered IS NULL OR amount_tendered >= amount),
  ADD COLUMN change_due numeric CHECK (change_due IS NULL OR change_due >= 0),
  ADD COLUMN mobile_money_request_id uuid REFERENCES mobile_money_requests(id),
  ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX payments_receipt_number ON payments(tenant_id, receipt_number) WHERE receipt_number IS NOT NULL;
CREATE UNIQUE INDEX payments_idempotency ON payments(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- A confirmed mobile money request posts exactly one payment, however often the provider calls back.
CREATE UNIQUE INDEX payments_mobile_money_once ON payments(mobile_money_request_id) WHERE mobile_money_request_id IS NOT NULL;

ALTER TABLE mobile_money_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_money_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY mobile_money_requests_cashier ON mobile_money_requests USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin']));
CREATE POLICY mobile_money_requests_system ON mobile_money_requests USING (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'system'
) WITH CHECK (tenant_id = app.current_tenant() AND app.actor_kind() = 'system');

ALTER TABLE mobile_money_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_money_events FORCE ROW LEVEL SECURITY;
CREATE POLICY mobile_money_events_cashier ON mobile_money_events USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin','auditor'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin']));
CREATE POLICY mobile_money_events_system ON mobile_money_events USING (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'system'
) WITH CHECK (tenant_id = app.current_tenant() AND app.actor_kind() = 'system');

GRANT SELECT, INSERT, UPDATE ON mobile_money_requests TO medveris_runtime;
GRANT SELECT, INSERT ON mobile_money_events TO medveris_runtime;

-- Verified provider callbacks reconcile the bill without a signed-in user.
CREATE POLICY invoices_system ON invoices USING (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'system'
) WITH CHECK (tenant_id = app.current_tenant() AND app.actor_kind() = 'system');
CREATE POLICY invoice_items_system ON invoice_items FOR SELECT USING (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'system'
);
CREATE POLICY payments_system ON payments USING (
  tenant_id = app.current_tenant() AND app.actor_kind() = 'system'
) WITH CHECK (tenant_id = app.current_tenant() AND app.actor_kind() = 'system');

-- The workspace a provider callback belongs to, found from the reference Medveris sent. Returns no
-- payment or patient data; the callback is then processed inside that workspace's row-level security.
GRANT SELECT ON mobile_money_requests TO medveris_exchange;
CREATE FUNCTION app.mobile_money_request_tenant(p_reference text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.tenant_id FROM mobile_money_requests r
   WHERE r.external_reference = p_reference OR (r.provider = 'yo' AND r.provider_reference = p_reference)
   ORDER BY (r.external_reference = p_reference) DESC
   LIMIT 1
$$;
ALTER FUNCTION app.mobile_money_request_tenant(text) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.mobile_money_request_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mobile_money_request_tenant(text) TO medveris_runtime;

-- ---------------------------------------------------------------- consultation note integrity evidence

-- Clinicians who may read a note can check its tamper evidence: the hash-chained audit events for the
-- note and the signed Merkle checkpoint covering each. Hashes, actions and times only; no audit metadata.
GRANT SELECT ON audit_events, integrity_checkpoints, ledger_anchors, clinical_entries TO medveris_exchange;
CREATE FUNCTION app.clinical_entry_integrity(p_entry uuid)
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
    LEFT JOIN integrity_checkpoints k ON k.tenant_id = a.tenant_id AND a.occurred_at >= k.range_start AND a.occurred_at <= k.range_end
   WHERE ce.id = p_entry AND ce.tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
   ORDER BY a.occurred_at, a.id
$$;
ALTER FUNCTION app.clinical_entry_integrity(uuid) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.clinical_entry_integrity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.clinical_entry_integrity(uuid) TO medveris_runtime;

-- Leaves of one checkpoint, to recompute its Merkle root. Event ids and hashes only.
CREATE FUNCTION app.integrity_checkpoint_leaves(p_checkpoint uuid) RETURNS TABLE (id uuid, event_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.event_hash
    FROM integrity_checkpoints k
    JOIN audit_events a ON a.tenant_id = k.tenant_id AND a.occurred_at >= k.range_start AND a.occurred_at <= k.range_end
   WHERE k.id = p_checkpoint AND k.tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
   ORDER BY a.occurred_at, a.id
$$;
ALTER FUNCTION app.integrity_checkpoint_leaves(uuid) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.integrity_checkpoint_leaves(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.integrity_checkpoint_leaves(uuid) TO medveris_runtime;

COMMIT;
