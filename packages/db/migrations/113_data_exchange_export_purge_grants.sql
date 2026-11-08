BEGIN;

-- The scheduled export-retention purge runs as the jobs role under the system actor
-- (apps/jobs/src/exports.ts). Migration 109 granted data_exchange_jobs only to
-- medveris_runtime, so every purge failed with 42501 (insufficient_privilege).
-- The system-actor policies already allow the update; this grants the needed
-- table privileges to the runner role without opening INSERT.
GRANT SELECT, UPDATE ON data_exchange_jobs TO medveris_jobs;

COMMIT;
