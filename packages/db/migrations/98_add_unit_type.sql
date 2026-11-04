-- Medveris Unit Type Migration
-- Add unit_type field to tenants table
-- Forward-only migration

BEGIN;

-- Add unit_type field to tenants table
ALTER TABLE tenants
ADD COLUMN unit_type text NOT NULL DEFAULT 'hospital'
CHECK (unit_type IN ('hospital', 'pharmacy', 'drugshop', 'laboratory', 'imaging', 'dental'));

COMMIT;