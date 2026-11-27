-- Rollback for migration 150. Removes only the platform review policies added there; the
-- tenant-scoped policies from migration 032 are untouched.

BEGIN;

DROP POLICY IF EXISTS facility_registrations_platform_read ON facility_registrations;
DROP POLICY IF EXISTS facility_registrations_platform_review ON facility_registrations;

COMMIT;
