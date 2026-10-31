-- Allow point-of-sale allocations for products that are not lot tracked.
--
-- Inventory keeps a separate balance per batch. Lot-tracked pharmacy products
-- allocate FEFO batches and record the lot; untracked products have a balance
-- with a null lot_id, so the allocation row must be able to reference no batch.

BEGIN;

ALTER TABLE pharmacy_sale_allocations ALTER COLUMN lot_id DROP NOT NULL;

COMMIT;
