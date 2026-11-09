BEGIN;

-- Stage 2 shared clinical notes: note type, void/archive and attachments.
ALTER TABLE clinical_entries
  ADD COLUMN IF NOT EXISTS note_type text NOT NULL DEFAULT 'consultation'
    CHECK (note_type IN ('consultation','progress','admission','nursing','discharge','referral','procedure','followup','maternity','pediatric')),
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text;

ALTER TABLE clinical_entry_versions
  ADD COLUMN IF NOT EXISTS note_type text NOT NULL DEFAULT 'consultation'
    CHECK (note_type IN ('consultation','progress','admission','nursing','discharge','referral','procedure','followup','maternity','pediatric'));

ALTER TABLE clinical_entries DROP CONSTRAINT IF EXISTS clinical_entries_status_check;
ALTER TABLE clinical_entries ADD CONSTRAINT clinical_entries_status_check
  CHECK (status IN ('draft','signed','amended','entered-in-error','voided'));

ALTER TABLE clinical_entry_versions DROP CONSTRAINT IF EXISTS clinical_entry_versions_status_check;
ALTER TABLE clinical_entry_versions ADD CONSTRAINT clinical_entry_versions_status_check
  CHECK (status IN ('draft','signed','amended','entered-in-error','voided'));

CREATE INDEX IF NOT EXISTS clinical_entries_note_type_idx
  ON clinical_entries (tenant_id, note_type, status, created_at);

CREATE TABLE IF NOT EXISTS clinical_entry_attachments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES clinical_entries(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  upload_id uuid NOT NULL REFERENCES uploads(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, upload_id)
);
CREATE INDEX IF NOT EXISTS clinical_attachments_entry_idx ON clinical_entry_attachments (entry_id);

GRANT SELECT, INSERT, DELETE ON clinical_entry_attachments TO medveris_runtime;

ALTER TABLE uploads ADD COLUMN IF NOT EXISTS patient_id uuid REFERENCES patients(id);

GRANT SELECT, INSERT, DELETE ON clinical_entry_attachments TO medveris_runtime;

COMMIT;
