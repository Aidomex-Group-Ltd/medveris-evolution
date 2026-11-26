-- Rollback for migration 147: removes the explicit dispensing classification.
-- WARNING: a Drugshop can then no longer prove which stock it may lawfully sell; the new
-- Worker refuses to dispense rather than assume permission, so this rollback also requires a
-- code rollback to a version that does not read the column.

BEGIN;

DROP INDEX IF EXISTS public.inventory_items_dispensing_scope_idx;
ALTER TABLE public.inventory_items DROP CONSTRAINT IF EXISTS inventory_items_dispensing_scope_check;
ALTER TABLE public.inventory_items DROP COLUMN IF EXISTS dispensing_scope;

COMMIT;
