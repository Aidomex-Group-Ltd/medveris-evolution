-- Medveris Unit Type Backfill Migration
-- Backfill all existing tenants to 'hospital' unit_type

BEGIN;

UPDATE tenants
SET unit_type = 'hospital'
WHERE unit_type IS NULL OR unit_type NOT IN ('hospital', 'pharmacy', 'drugshop', 'laboratory', 'imaging', 'dental');

COMMIT;