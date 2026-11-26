-- Migration 148: let a facility's own administrators maintain that facility's price list.
--
-- Migration 121 created RLS policies for `price_lists` and `price_list_prices` but granted the
-- runtime role SELECT only. The policies therefore could never be exercised: every insert or
-- update failed with "permission denied" before row filtering applied. It also made
-- `price_history` unwritable: the audit trigger is not SECURITY DEFINER, so it inserts as the
-- calling role, and no INSERT policy existed.
--
-- This migration grants exactly the statements the facility price-list workflow needs and adds
-- an INSERT policy on `price_history` scoped to the same facilities whose prices may be written.
-- It does NOT widen who may write: the existing policies still restrict rows to an active
-- facility_admin or finance membership of the owning facility. Platform operators still have no
-- write path to facility prices and facilities still have no write path to `master_prices`.
--
-- Forward plan: privileges and one additive policy; no table or column changes, no backfill.
-- Rollback: packages/db/rollbacks/148_facility_price_list_write_grants_rollback.sql

BEGIN;

GRANT INSERT, UPDATE ON public.price_lists TO medveris_runtime;
GRANT INSERT, UPDATE ON public.price_list_prices TO medveris_runtime;

-- The change-history trigger inserts as the calling role.
GRANT INSERT ON public.price_history TO medveris_runtime;

DROP POLICY IF EXISTS price_history_insert ON public.price_history;
CREATE POLICY price_history_insert ON public.price_history
  FOR INSERT
  WITH CHECK (
    price_list_price_id IN (
      SELECT plp.id
        FROM price_list_prices plp
        JOIN price_lists pl ON pl.id = plp.price_list_id
       WHERE pl.facility_id IN (
         SELECT m.tenant_id
           FROM memberships m
          WHERE m.user_id = app.current_user()
            AND m.status = 'active'
            AND m.roles && ARRAY['facility_admin'::text, 'finance'::text]
       )
    )
  );

COMMENT ON POLICY price_history_insert ON public.price_history IS
  'Price-change history is written by the trigger on behalf of an active facility_admin or finance member of the owning facility.';

COMMIT;
