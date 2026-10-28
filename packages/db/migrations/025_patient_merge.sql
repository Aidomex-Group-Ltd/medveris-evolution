-- Authorised patient identity merge.
--
-- A merge is requested by one authorised facility user and approved by a
-- different one. Approval marks the duplicate identity as merged into the
-- surviving identity; no clinical row is rewritten, so signed and hash-chained
-- records keep the identifier they were created under and are presented with
-- the surviving identity. The duplicate's demographics are snapshotted on the
-- merge record, and a merge can be reversed with a reason. Additive only.

BEGIN;

CREATE TABLE patient_merges (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_patient_id uuid NOT NULL REFERENCES patients(id),
  survivor_patient_id uuid NOT NULL REFERENCES patients(id),
  duplicate_candidate_id uuid REFERENCES patient_duplicate_candidates(id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'completed', 'rejected', 'reversed')),
  reason text NOT NULL,
  evidence text NOT NULL,
  source_snapshot jsonb,
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  reversed_by uuid REFERENCES users(id),
  reversed_at timestamptz,
  reversal_reason text,
  CHECK (source_patient_id <> survivor_patient_id),
  CHECK (status = 'requested' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_note IS NOT NULL)),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK (status <> 'reversed' OR (reversed_by IS NOT NULL AND reversal_reason IS NOT NULL))
);
CREATE UNIQUE INDEX patient_merges_one_open_per_source ON patient_merges(source_patient_id) WHERE status IN ('requested', 'completed');
CREATE INDEX patient_merges_tenant_idx ON patient_merges(tenant_id, status, requested_at);

ALTER TABLE patient_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_merges FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_merges_tenant ON patient_merges
  USING (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin', 'records', 'privacy_officer', 'auditor']))
  WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin', 'records']));
GRANT SELECT, INSERT, UPDATE ON patient_merges TO medveris_runtime;

-- Reasons a facility may not merge this identity on its own. Returns codes only,
-- never another facility's identifiers, because the caller cannot see those rows.
CREATE OR REPLACE FUNCTION app.patient_merge_blockers(p_source uuid, p_tenant uuid)
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN EXISTS (SELECT 1 FROM tenant_patient_links WHERE patient_id = p_source AND tenant_id <> p_tenant)
      THEN 'linked-to-another-facility' END,
    CASE WHEN EXISTS (SELECT 1 FROM patient_accounts WHERE patient_id = p_source)
      THEN 'has-patient-account' END,
    CASE WHEN EXISTS (SELECT 1 FROM exchange_grants WHERE patient_id = p_source AND revoked_at IS NULL AND expires_at > now())
      THEN 'has-active-exchange-grant' END,
    CASE WHEN EXISTS (SELECT 1 FROM patient_proxies WHERE patient_id = p_source AND status = 'active')
      THEN 'has-active-proxy' END
  ], NULL)
$$;
GRANT SELECT ON tenant_patient_links, patient_accounts, exchange_grants, patient_proxies TO medveris_exchange;
ALTER FUNCTION app.patient_merge_blockers(uuid, uuid) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.patient_merge_blockers(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.patient_merge_blockers(uuid, uuid) TO medveris_runtime;

COMMIT;
