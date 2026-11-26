-- Migration 147: record each stocked item's dispensing classification explicitly.
--
-- A Drugshop licence does not authorise every item in a catalogue: prescription-only,
-- pharmacy-only and unclassified products are outside its scope. Until now the only signal was
-- `prescription_only`, which is a prescribing flag (default false) and cannot prove that a
-- product may lawfully be sold over the counter by a drug shop.
--
-- This adds an explicit classification. The default is `unverified`, so nothing becomes
-- dispensable by a Drugshop merely because it already exists in stock: a facility must state
-- what the item is. Pharmacy and general-facility dispensing rules are unchanged.
--
-- Forward plan: additive column with a constant default; safe to apply while the previous
-- Worker version is serving, because it is only read by the new code paths.
-- Rollback: packages/db/rollbacks/147_facility_dispensing_scope_rollback.sql

BEGIN;

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS dispensing_scope text NOT NULL DEFAULT 'unverified';

ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_dispensing_scope_check;
ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_dispensing_scope_check
  CHECK (dispensing_scope IN ('otc', 'prescription-only', 'pharmacy-only', 'not-dispensable', 'unverified'));

CREATE INDEX IF NOT EXISTS inventory_items_dispensing_scope_idx
  ON inventory_items (tenant_id, dispensing_scope);

COMMENT ON COLUMN inventory_items.dispensing_scope IS
  'Lawful dispensing classification. otc = may be sold by a Drugshop; prescription-only/pharmacy-only/not-dispensable = Drugshop must not dispense; unverified = recorded without a classification, no Drugshop dispensing.';

COMMIT;
