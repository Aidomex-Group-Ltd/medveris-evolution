-- Rollback for migration 149: removes the optional document reference and reviewer notes and
-- narrows the status check back to its previous values.
--
-- WARNING: any record rejected by a reviewer is returned to `recorded` (provided, awaiting
-- verification) so that no row breaks the narrower check. The reviewer decision itself stays in
-- the audit trail. The new Worker still works against the narrower schema for ordinary use, but
-- it can no longer store the two optional columns, so a code rollback is advisable.

BEGIN;

UPDATE facility_registrations SET status = 'recorded' WHERE status = 'rejected';

ALTER TABLE facility_registrations DROP CONSTRAINT IF EXISTS facility_registrations_status_check;
ALTER TABLE facility_registrations
  ADD CONSTRAINT facility_registrations_status_check
  CHECK (status IN ('recorded', 'verified', 'expired', 'withdrawn'));

ALTER TABLE facility_registrations DROP CONSTRAINT IF EXISTS facility_registrations_document_reference_check;
ALTER TABLE facility_registrations DROP COLUMN IF EXISTS document_reference;

ALTER TABLE facility_registrations DROP CONSTRAINT IF EXISTS facility_registrations_verification_notes_check;
ALTER TABLE facility_registrations DROP COLUMN IF EXISTS verification_notes;

COMMIT;
