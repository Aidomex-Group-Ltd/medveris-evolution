-- 138_clinical_entry_attachments_rls.sql
--
-- Forward-fill the RLS that migration 117 should have created.
--
-- 117 created clinical_entry_attachments and granted DML to medveris_runtime,
-- but never enabled/forced RLS or created a policy. The local database had an
-- out-of-band attachments_tenant policy with no migration source, which masked
-- the defect until a fresh reset. This migration makes the policy explicit and
-- source-controlled so production built from migrations gets the same protection.
--
-- The table already has tenant_id, so a single tenant-scoped policy is
-- sufficient: every row read/write is gated on app.current_tenant(), the same
-- GUC the rest of the app uses for tenant-isolated tables.
--
-- Rollback (defensive; dropping RLS on a live table is unusual):
--   ALTER TABLE clinical_entry_attachments DISABLE ROW LEVEL SECURITY;
--   DROP POLICY attachments_tenant ON clinical_entry_attachments;

BEGIN;

ALTER TABLE clinical_entry_attachments
  ENABLE ROW LEVEL SECURITY,
  FORCE ROW LEVEL SECURITY;

CREATE POLICY attachments_tenant ON clinical_entry_attachments
  FOR ALL
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

COMMIT;
