-- Facility-scoped eHMIS / DHIS2 aggregate reporting.
--
-- Everything here belongs to one facility (tenant): eligibility and Ministry authorization evidence,
-- the DHIS2 organisation unit mapping, encrypted credentials, dataset mappings, reporting periods and
-- the submission ledger. Eligibility is never inferred from category or level: a facility administrator
-- records the authorization evidence and a platform operator verifies it; the trigger below refuses any
-- other path to `verified`. Live submission additionally needs a passing connection test, and the
-- deployment-level authorization configured outside the database.
--
-- Only aggregate HMIS reporting is modelled. Client-level reporting (MoH EMRS guideline §4.3(5), public
-- health emergencies) is a separate, exceptional authorization and is not implemented.
--
-- Reporting schedules are data, not code: the default row cites the January 2024 MoH EMRS guideline
-- (§4.2: push by the 7th, validation 8th–15th, locked after the 15th), verified on 2026-10-29.

BEGIN;

CREATE TABLE hmis_integrations (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  nhfr_id text CHECK (nhfr_id IS NULL OR length(nhfr_id) BETWEEN 2 AND 64),
  dhis2_base_url text CHECK (dhis2_base_url IS NULL OR dhis2_base_url ~ '^https?://[^/]+'),
  dhis2_org_unit_uid text CHECK (dhis2_org_unit_uid IS NULL OR dhis2_org_unit_uid ~ '^[A-Za-z][A-Za-z0-9]{10}$'),
  dhis2_org_unit_name text,
  eligibility_status text NOT NULL DEFAULT 'not-assessed' CHECK (eligibility_status IN (
    'not-assessed','pending-verification','verified','rejected','suspended'
  )),
  authorization_reference text,
  authorization_issuer text,
  authorization_scope text NOT NULL DEFAULT 'aggregate' CHECK (authorization_scope IN ('aggregate')),
  authorization_valid_until date,
  eligibility_requested_by uuid REFERENCES users(id),
  eligibility_requested_at timestamptz,
  eligibility_decided_by uuid REFERENCES users(id),
  eligibility_decided_at timestamptz,
  eligibility_decision_note text,
  credential_kind text CHECK (credential_kind IS NULL OR credential_kind IN ('basic','personal-access-token')),
  credential_ciphertext text,
  credential_hint text,
  credential_set_by uuid REFERENCES users(id),
  credential_set_at timestamptz,
  connection_status text NOT NULL DEFAULT 'not-tested' CHECK (connection_status IN ('not-tested','verified','failed')),
  connection_checked_at timestamptz,
  connection_detail text,
  -- Hash of base URL, org unit and credential; a change after a test makes the test stale.
  connection_fingerprint text,
  live_submission_enabled boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (eligibility_status <> 'verified' OR (eligibility_decided_by IS NOT NULL AND authorization_reference IS NOT NULL)),
  CHECK (eligibility_decided_by IS NULL OR eligibility_decided_by IS DISTINCT FROM eligibility_requested_by),
  CHECK (NOT live_submission_enabled OR (eligibility_status = 'verified' AND connection_status = 'verified')),
  CHECK ((credential_kind IS NULL) = (credential_ciphertext IS NULL))
);

CREATE FUNCTION app.guard_hmis_eligibility() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.eligibility_status IN ('verified','rejected','suspended')
     AND (TG_OP = 'INSERT' OR NEW.eligibility_status IS DISTINCT FROM OLD.eligibility_status
          OR NEW.eligibility_decided_by IS DISTINCT FROM OLD.eligibility_decided_by)
     AND NOT app.is_platform_operator() THEN
    RAISE EXCEPTION 'only a platform operator can record an eHMIS eligibility decision' USING ERRCODE = '42501';
  END IF;
  -- Changing the authorization evidence after a decision sends it back for verification.
  IF TG_OP = 'UPDATE' AND OLD.eligibility_status = 'verified' AND NOT app.is_platform_operator()
     AND (NEW.authorization_reference IS DISTINCT FROM OLD.authorization_reference
          OR NEW.authorization_valid_until IS DISTINCT FROM OLD.authorization_valid_until
          OR NEW.nhfr_id IS DISTINCT FROM OLD.nhfr_id) THEN
    NEW.eligibility_status := 'pending-verification';
    NEW.eligibility_decided_by := NULL;
    NEW.eligibility_decided_at := NULL;
    NEW.live_submission_enabled := false;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hmis_integrations_eligibility BEFORE INSERT OR UPDATE ON hmis_integrations
  FOR EACH ROW EXECUTE FUNCTION app.guard_hmis_eligibility();

CREATE TABLE hmis_dataset_mappings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dataset_code text NOT NULL CHECK (length(dataset_code) BETWEEN 2 AND 60),
  dataset_name text NOT NULL CHECK (length(dataset_name) BETWEEN 2 AND 200),
  dhis2_data_set_uid text NOT NULL CHECK (dhis2_data_set_uid ~ '^[A-Za-z][A-Za-z0-9]{10}$'),
  period_type text NOT NULL CHECK (period_type IN ('Weekly','Monthly','Quarterly')),
  attribute_option_combo_uid text CHECK (attribute_option_combo_uid IS NULL OR attribute_option_combo_uid ~ '^[A-Za-z][A-Za-z0-9]{10}$'),
  elements jsonb NOT NULL CHECK (jsonb_typeof(elements) = 'array' AND jsonb_array_length(elements) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  approval_reference text,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approval_reference IS NOT NULL))
);
CREATE UNIQUE INDEX hmis_dataset_mappings_live ON hmis_dataset_mappings(tenant_id, dhis2_data_set_uid) WHERE status <> 'retired';

CREATE TABLE hmis_reporting_rules (
  id uuid PRIMARY KEY,
  -- NULL is the platform default; a facility row overrides it for that facility.
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  period_type text NOT NULL CHECK (period_type IN ('Weekly','Monthly','Quarterly')),
  submission_due_day integer NOT NULL CHECK (submission_due_day BETWEEN 1 AND 28),
  validation_start_day integer NOT NULL CHECK (validation_start_day BETWEEN 1 AND 28),
  validation_end_day integer NOT NULL CHECK (validation_end_day BETWEEN 1 AND 28),
  lock_after_day integer NOT NULL CHECK (lock_after_day BETWEEN 1 AND 28),
  source text NOT NULL CHECK (length(source) BETWEEN 5 AND 500),
  verified_on date NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (validation_start_day <= validation_end_day AND validation_end_day <= lock_after_day)
);
CREATE UNIQUE INDEX hmis_reporting_rules_scope ON hmis_reporting_rules(COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), period_type);

INSERT INTO hmis_reporting_rules (id, tenant_id, period_type, submission_due_day, validation_start_day, validation_end_day, lock_after_day, source, verified_on)
VALUES ('6f1d2c7e-0b1a-4c55-9d3e-5a0e0c2b7a01', NULL, 'Monthly', 7, 8, 15, 15,
  'Uganda MoH, Guidelines for the Implementation of the Electronic Medical Records System (January 2024), section 4.2: push by the 7th, validation 8th–15th, eHMIS locked after the 15th',
  DATE '2026-10-29');

CREATE TABLE hmis_report_periods (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mapping_id uuid NOT NULL REFERENCES hmis_dataset_mappings(id),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}([0-9]{2}|W[0-9]{1,2}|Q[1-4])$'),
  period_start date NOT NULL,
  period_end date NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL CHECK (status IN (
    'generated','validation-failed','approved','submitting','submitted','failed','exported','submitted-manually','superseded'
  )),
  data_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  -- tenant + data set + org unit + period + revision; a key is submitted live at most once.
  idempotency_key text NOT NULL UNIQUE,
  generated_by uuid NOT NULL REFERENCES users(id),
  generated_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  approval_note text,
  submitted_at timestamptz,
  import_summary jsonb,
  last_error text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  manual_reference text,
  reopened_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (status NOT IN ('approved','submitting','submitted','exported','submitted-manually') OR approved_by IS NOT NULL),
  CHECK (status <> 'submitted-manually' OR manual_reference IS NOT NULL),
  UNIQUE (tenant_id, mapping_id, period, revision)
);
CREATE UNIQUE INDEX hmis_report_periods_live ON hmis_report_periods(tenant_id, mapping_id, period) WHERE status <> 'superseded';
CREATE INDEX hmis_report_periods_tenant_idx ON hmis_report_periods(tenant_id, period_start DESC);

CREATE TABLE hmis_submission_ledger (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id uuid REFERENCES hmis_report_periods(id),
  kind text NOT NULL CHECK (kind IN ('connection-test','dry-run','live','manual-export','manual-submission','status-change')),
  idempotency_key text,
  request_digest text,
  outcome text NOT NULL CHECK (outcome IN ('succeeded','failed','rejected','skipped-duplicate','refused')),
  http_status integer,
  -- Counts and DHIS2 import status only; never credentials or patient data.
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  actor_user_id uuid REFERENCES users(id),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hmis_submission_ledger_idx ON hmis_submission_ledger(tenant_id, finished_at DESC);
CREATE TRIGGER hmis_submission_ledger_append_only BEFORE UPDATE OR DELETE ON hmis_submission_ledger
  FOR EACH ROW EXECUTE FUNCTION app.reject_append_only_mutation();

CREATE FUNCTION app.is_hmis_staff() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.actor_kind() = 'staff' AND app.has_any_role(ARRAY['facility_admin','public_health','owner'])
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hmis_integrations','hmis_dataset_mappings','hmis_reporting_rules','hmis_report_periods','hmis_submission_ledger'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

CREATE POLICY hmis_integrations_facility ON hmis_integrations
  USING ((tenant_id = app.current_tenant() AND app.is_hmis_staff()) OR app.is_platform_operator())
  WITH CHECK ((tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin'])) OR app.is_platform_operator());
CREATE POLICY hmis_dataset_mappings_facility ON hmis_dataset_mappings
  USING (tenant_id = app.current_tenant() AND app.is_hmis_staff())
  WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin']));
CREATE POLICY hmis_reporting_rules_read ON hmis_reporting_rules FOR SELECT
  USING (tenant_id IS NULL OR (tenant_id = app.current_tenant() AND app.is_hmis_staff()));
CREATE POLICY hmis_reporting_rules_facility ON hmis_reporting_rules FOR INSERT
  WITH CHECK ((tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin'])) OR (tenant_id IS NULL AND app.is_platform_operator()));
CREATE POLICY hmis_reporting_rules_update ON hmis_reporting_rules FOR UPDATE
  USING ((tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin'])) OR (tenant_id IS NULL AND app.is_platform_operator()))
  WITH CHECK ((tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin'])) OR (tenant_id IS NULL AND app.is_platform_operator()));
CREATE POLICY hmis_report_periods_facility ON hmis_report_periods
  USING (tenant_id = app.current_tenant() AND app.is_hmis_staff())
  WITH CHECK (tenant_id = app.current_tenant() AND app.is_hmis_staff());
CREATE POLICY hmis_submission_ledger_read ON hmis_submission_ledger FOR SELECT
  USING ((tenant_id = app.current_tenant() AND app.is_hmis_staff()) OR app.is_platform_operator());
CREATE POLICY hmis_submission_ledger_insert ON hmis_submission_ledger FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant() AND app.is_hmis_staff());

GRANT SELECT, INSERT, UPDATE ON hmis_integrations, hmis_dataset_mappings, hmis_reporting_rules, hmis_report_periods TO medveris_runtime;
GRANT SELECT, INSERT ON hmis_submission_ledger TO medveris_runtime;

-- Aggregate source metrics for HMIS mappings, counted from the facility's own records. Reading through
-- a definer function avoids false zeros where the reporting role cannot read a clinical table, while
-- returning counts only. Age bands follow the HMIS 105 OPD disaggregation; sex is female/male/other.
CREATE FUNCTION app.hmis_source_metrics(p_tenant uuid, p_from date, p_to date)
RETURNS TABLE (metric text, sex text, age_band text, value integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH allowed AS (
    SELECT 1 WHERE p_tenant = app.current_tenant() AND app.is_hmis_staff()
  ),
  visits AS (
    SELECT e.id, p.sex,
           CASE
             WHEN (e.opened_at::date - p.date_of_birth) <= 28 THEN '0-28d'
             WHEN age(e.opened_at::date, p.date_of_birth) < interval '5 years' THEN '29d-4y'
             WHEN age(e.opened_at::date, p.date_of_birth) < interval '10 years' THEN '5-9y'
             WHEN age(e.opened_at::date, p.date_of_birth) < interval '20 years' THEN '10-19y'
             ELSE '20y+'
           END AS age_band,
           NOT EXISTS (
             SELECT 1 FROM encounters prior
              WHERE prior.tenant_id = e.tenant_id AND prior.patient_id = e.patient_id
                AND prior.state NOT IN ('cancelled','entered-in-error')
                AND prior.opened_at < e.opened_at AND prior.opened_at >= date_trunc('year', e.opened_at)
           ) AS first_this_year
      FROM encounters e JOIN patients p ON p.id = e.patient_id, allowed
     WHERE e.tenant_id = p_tenant AND e.state NOT IN ('cancelled','entered-in-error','planned')
       AND e.opened_at >= p_from AND e.opened_at < p_to + 1
  ),
  visit_metrics AS (
    SELECT CASE WHEN first_this_year THEN 'opd.new-attendance' ELSE 'opd.re-attendance' END AS metric, sex, age_band FROM visits
  ),
  inpatient AS (
    SELECT 'ipd.admissions' AS metric, p.sex FROM admissions a JOIN patients p ON p.id = a.patient_id, allowed
     WHERE a.tenant_id = p_tenant AND a.status <> 'cancelled' AND a.admitted_at >= p_from AND a.admitted_at < p_to + 1
    UNION ALL
    SELECT CASE a.status WHEN 'deceased' THEN 'ipd.deaths' ELSE 'ipd.discharges' END, p.sex
      FROM admissions a JOIN patients p ON p.id = a.patient_id, allowed
     WHERE a.tenant_id = p_tenant AND a.status IN ('discharged','transferred-out','deceased')
       AND a.discharged_at >= p_from AND a.discharged_at < p_to + 1
    UNION ALL
    SELECT 'maternity.deliveries', 'female' FROM maternity_episodes m, allowed
     WHERE m.tenant_id = p_tenant AND m.delivered_at >= p_from AND m.delivered_at < p_to + 1
    UNION ALL
    SELECT CASE o.order_type WHEN 'laboratory' THEN 'lab.tests-resulted' ELSE 'imaging.examinations-resulted' END, p.sex
      FROM service_order_items i JOIN service_orders o ON o.id = i.order_id JOIN patients p ON p.id = o.patient_id, allowed
     WHERE o.tenant_id = p_tenant AND o.order_type IN ('laboratory','imaging') AND i.status = 'resulted'
       AND o.updated_at >= p_from AND o.updated_at < p_to + 1
  )
  SELECT metric, sex, age_band, count(*)::int FROM visit_metrics GROUP BY metric, sex, age_band
  UNION ALL
  SELECT metric, sex, 'all', count(*)::int FROM visit_metrics GROUP BY metric, sex
  UNION ALL
  SELECT metric, 'all', 'all', count(*)::int FROM visit_metrics GROUP BY metric
  UNION ALL
  SELECT metric, sex, 'all', count(*)::int FROM inpatient GROUP BY metric, sex
  UNION ALL
  SELECT metric, 'all', 'all', count(*)::int FROM inpatient GROUP BY metric
$$;
GRANT SELECT ON encounters, patients, admissions, maternity_episodes, service_orders, service_order_items TO medveris_exchange;
ALTER FUNCTION app.hmis_source_metrics(uuid, date, date) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.hmis_source_metrics(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.hmis_source_metrics(uuid, date, date) TO medveris_runtime;

COMMIT;
