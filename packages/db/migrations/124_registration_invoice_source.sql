-- Allow system-generated registration/initial consultation invoice lines.

BEGIN;

ALTER TABLE invoice_items DROP CONSTRAINT IF EXISTS invoice_items_source_check;
ALTER TABLE invoice_items
  ADD CONSTRAINT invoice_items_source_check
  CHECK (source IN ('manual', 'recommendation', 'supply', 'registration'));

ALTER TABLE invoice_items DROP CONSTRAINT IF EXISTS invoice_items_source_link;
ALTER TABLE invoice_items
  ADD CONSTRAINT invoice_items_source_link
  CHECK (
    (source IN ('manual', 'registration') AND recommendation_id IS NULL AND supply_usage_id IS NULL)
    OR (source = 'recommendation' AND recommendation_id IS NOT NULL AND supply_usage_id IS NULL)
    OR (source = 'supply' AND supply_usage_id IS NOT NULL AND recommendation_id IS NULL)
  );

COMMIT;
