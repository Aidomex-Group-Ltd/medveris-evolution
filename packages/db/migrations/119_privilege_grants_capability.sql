-- Extend privilege grants with capability linkage.
-- Recovered migration so fresh environments reproduce the live schema.

BEGIN;

ALTER TABLE privilege_grants ADD COLUMN IF NOT EXISTS capability_code TEXT;
ALTER TABLE privilege_grants ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE privilege_grants ADD COLUMN IF NOT EXISTS supervision_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE privilege_grants ADD COLUMN IF NOT EXISTS restricted_to_departments TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'privilege_grants_valid_capability') THEN
    ALTER TABLE privilege_grants ADD CONSTRAINT privilege_grants_valid_capability CHECK (capability_code IS NULL OR capability_code ~ '^[A-Z][A-Z0-9-]*$');
  END IF;
END $$;

COMMIT;
