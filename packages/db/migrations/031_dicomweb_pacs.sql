-- DICOMweb / PACS connection.
--
-- integration_verifications records each conformance run against a configured external
-- endpoint. An integration becomes available only after a passing run for the same
-- environment and endpoint fingerprint (a hash of the URL, auth scheme and principal), so a
-- changed PACS URL or account needs a new run. Runs hold counts and outcomes only, never
-- patient data, and are appended, never edited.
--
-- Imaging studies are linked to one PACS study by Study Instance UID after a radiographer or
-- radiologist compares the PACS demographics with the Medveris patient. The demographics seen
-- at link time are kept in pacs_identity. Pixel data stays in the PACS. Additive only.

BEGIN;

CREATE TABLE integration_verifications (
  id uuid PRIMARY KEY,
  integration_id text NOT NULL CHECK (integration_id ~ '^[a-zA-Z]{2,40}$'),
  app_env text NOT NULL CHECK (length(app_env) BETWEEN 2 AND 40),
  endpoint_fingerprint text NOT NULL CHECK (endpoint_fingerprint ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('passed', 'failed')),
  checks jsonb NOT NULL,
  run_by uuid NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_verifications_latest
  ON integration_verifications(integration_id, app_env, endpoint_fingerprint, finished_at DESC);

ALTER TABLE integration_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_verifications FORCE ROW LEVEL SECURITY;
-- Availability is decided on every request that needs the integration, by any caller.
CREATE POLICY integration_verifications_read ON integration_verifications FOR SELECT TO medveris_runtime USING (true);
CREATE POLICY integration_verifications_record ON integration_verifications FOR INSERT TO medveris_runtime
  WITH CHECK (current_setting('app.platform_role', true) = 'platform_operator');
GRANT SELECT, INSERT ON integration_verifications TO medveris_runtime;

ALTER TABLE imaging_studies
  ADD COLUMN pacs_linked_at timestamptz,
  ADD COLUMN pacs_linked_by uuid REFERENCES users(id),
  ADD COLUMN pacs_identity jsonb,
  ADD CONSTRAINT imaging_studies_pacs_link CHECK (
    pacs_state <> 'reconciled' OR (study_instance_uid IS NOT NULL AND pacs_linked_at IS NOT NULL AND pacs_linked_by IS NOT NULL)
  );
CREATE UNIQUE INDEX imaging_studies_pacs_study ON imaging_studies(tenant_id, study_instance_uid)
  WHERE pacs_state = 'reconciled' AND acquisition_status <> 'cancelled';

COMMIT;
