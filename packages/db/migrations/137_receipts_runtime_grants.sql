-- 137_receipts_runtime_grants.sql
--
-- Migration 134 created `receipts` with ENABLE/FORCE ROW LEVEL SECURITY and
-- read/write/update policies, but never granted the runtime role any table
-- privilege on it. PostgreSQL checks table privileges before it evaluates RLS,
-- so every statement against `receipts` from the runtime role failed with
-- "permission denied for table receipts" no matter what the actor was.
--
-- That made GET /billing/receipts and the receipts section of
-- GET /billing/overview unable to return a single row. The grants here follow
-- the policies already defined in 134, so the effective rules are unchanged:
--
--   * SELECT - rows are still filtered by `receipts_read`, which requires
--     app.billing_account_access(billing_account_id) or a system/registration
--     actor. Holding the grant does not widen what a staff member can see.
--   * INSERT - still restricted by `receipts_write` to actor_kind() = 'system'.
--   * UPDATE - still restricted by `receipts_update` to actor_kind() = 'system'.
--
-- No policy is altered and no column is added; this migration only closes the
-- privilege gap so the existing policies can actually run.
--
-- Reversible:
--   REVOKE SELECT, INSERT, UPDATE ON receipts FROM medveris_runtime;

BEGIN;

GRANT SELECT, INSERT, UPDATE ON receipts TO medveris_runtime;

COMMIT;
