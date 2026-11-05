-- Sandbox modes: verification provenance and simulated-data tagging.
--
-- Integration mode (live | sandbox) is recorded with every conformance run so a run against a
-- sandbox endpoint can never be read as a live verification. Records that a sandbox adapter
-- creates carry `simulated` and `source = 'sandbox:<adapter>'` so reports, eHMIS exports and FHIR
-- output can exclude or clearly separate them. Additive only; every column defaults to the
-- pre-existing, non-sandbox behaviour.

BEGIN;

ALTER TABLE integration_verifications
  ADD COLUMN mode text NOT NULL DEFAULT 'live'
  CHECK (mode IN ('live', 'sandbox'));

ALTER TABLE ai_jobs
  ADD COLUMN simulated boolean NOT NULL DEFAULT false,
  ADD COLUMN source text;

ALTER TABLE device_observations
  ADD COLUMN simulated boolean NOT NULL DEFAULT false,
  ADD COLUMN source text;

ALTER TABLE observations
  ADD COLUMN simulated boolean NOT NULL DEFAULT false,
  ADD COLUMN source text;

COMMENT ON COLUMN integration_verifications.mode IS
  'Mode of the endpoint the run tested. sandbox runs never make an integration available.';
COMMENT ON COLUMN ai_jobs.simulated IS 'true when the job ran against a sandbox model adapter.';
COMMENT ON COLUMN ai_jobs.source IS 'Adapter that produced the output, e.g. sandbox:ollama.';
COMMENT ON COLUMN device_observations.simulated IS 'true when the observation came from a sandbox device gateway.';
COMMENT ON COLUMN device_observations.source IS 'Adapter that produced the observation, e.g. sandbox:devices.';
COMMENT ON COLUMN observations.simulated IS 'true when the observation came from a sandbox adapter.';
COMMENT ON COLUMN observations.source IS 'Adapter that produced the observation, e.g. sandbox:devices.';

COMMIT;
