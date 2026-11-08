BEGIN;

-- Export payloads are server-side files with an expiry; after the download window closes the
-- payload is patient data with no legitimate reader. The scheduled purge nulls content and token
-- and keeps the audit record. Migration 109's CHECK required them to stay non-null forever; this
-- replaces it with the invariant that actually matters: an export row always keeps its digest.
ALTER TABLE data_exchange_jobs DROP CONSTRAINT data_exchange_jobs_check2;
ALTER TABLE data_exchange_jobs ADD CONSTRAINT data_exchange_jobs_export_payload
  CHECK (kind <> 'export' OR content_digest IS NOT NULL);

COMMENT ON COLUMN data_exchange_jobs.content_digest IS
  'SHA-256 of the released payload, kept as audit evidence after retention purging nulls content.';

COMMIT;
