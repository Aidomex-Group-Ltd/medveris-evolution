-- Controlled bulk import/export jobs.
--
-- Every job records who asked, which dataset and scope it covered, what was written or read, and
-- the row-level errors. Export content is stored server-side and released only through a short-lived
-- token, so a copied job id is not a data disclosure. Imports never overwrite an existing patient,
-- financial or clinical record: a duplicate is reported instead.

BEGIN;

CREATE TABLE data_exchange_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('import', 'export')),
  dataset text NOT NULL CHECK (dataset IN ('patients', 'appointments', 'invoices')),
  format text NOT NULL CHECK (format IN ('csv', 'json')),
  scope text NOT NULL CHECK (scope IN ('tenant', 'department', 'unit')),
  department_id uuid REFERENCES departments(id),
  unit_id uuid REFERENCES units(id),
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  requested_by uuid NOT NULL REFERENCES users(id),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  applied_count integer NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  includes_sensitive boolean NOT NULL DEFAULT false,
  content text,
  content_digest text CHECK (content_digest IS NULL OR content_digest ~ '^[0-9a-f]{64}$'),
  download_token_hash text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (scope <> 'department' OR department_id IS NOT NULL),
  CHECK (scope <> 'unit' OR unit_id IS NOT NULL),
  CHECK (kind <> 'export' OR (content IS NOT NULL AND download_token_hash IS NOT NULL AND expires_at IS NOT NULL))
);

CREATE INDEX data_exchange_jobs_tenant_idx ON data_exchange_jobs(tenant_id, created_at DESC);
CREATE INDEX data_exchange_jobs_requester_idx ON data_exchange_jobs(tenant_id, requested_by, created_at DESC);

ALTER TABLE data_exchange_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_exchange_jobs FORCE ROW LEVEL SECURITY;

-- Exchange history is tenant data. The API additionally limits downloads to the requester (or a
-- facility administrator); RLS guarantees no tenant can ever see another tenant's jobs.
CREATE POLICY data_exchange_jobs_read ON data_exchange_jobs FOR SELECT
  USING (tenant_id = app.current_tenant() OR app.is_platform_operator() OR app.actor_kind() = 'system');

CREATE POLICY data_exchange_jobs_insert ON data_exchange_jobs FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant() AND requested_by = app.current_user());

CREATE POLICY data_exchange_jobs_update ON data_exchange_jobs FOR UPDATE
  USING (tenant_id = app.current_tenant() OR app.actor_kind() = 'system')
  WITH CHECK (tenant_id = app.current_tenant() OR app.actor_kind() = 'system');

GRANT SELECT, INSERT, UPDATE ON data_exchange_jobs TO medveris_runtime;

COMMENT ON TABLE data_exchange_jobs IS
  'Audited bulk import/export jobs. Export content is released only with a short-lived token issued to the requester.';
COMMENT ON COLUMN data_exchange_jobs.download_token_hash IS
  'SHA-256 of the one-time download token. The token itself is returned once, when the job is created.';

COMMIT;
