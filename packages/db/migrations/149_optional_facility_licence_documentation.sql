-- Migration 149: facility licence records are optional documentation, not an access requirement.
--
-- A facility may operate MedVeris without recording any regulatory licence, and may add or
-- correct the details later. Two things were missing to support that honestly:
--
--   1. A `rejected` verification outcome, so a reviewer can say the submitted details did not
--      verify without deleting the record or pretending it was never provided.
--   2. A place for the supporting document reference and the reviewer's notes.
--
-- Nothing here changes access rules: access is decided in application code, which no longer
-- treats a licence as a precondition. Neither column is required, and no existing row is
-- rewritten. The widened status check only admits a new value; every existing value still fits.
--
-- Forward plan: additive columns plus a relaxed CHECK; safe to apply while the previous Worker
-- version is serving, because it neither reads nor writes the new values.
-- Rollback: packages/db/rollbacks/149_optional_facility_licence_documentation_rollback.sql

BEGIN;

ALTER TABLE facility_registrations DROP CONSTRAINT IF EXISTS facility_registrations_status_check;
ALTER TABLE facility_registrations
  ADD CONSTRAINT facility_registrations_status_check
  CHECK (status IN ('recorded', 'verified', 'rejected', 'expired', 'withdrawn'));

ALTER TABLE facility_registrations
  ADD COLUMN IF NOT EXISTS document_reference text;
ALTER TABLE facility_registrations DROP CONSTRAINT IF EXISTS facility_registrations_document_reference_check;
ALTER TABLE facility_registrations
  ADD CONSTRAINT facility_registrations_document_reference_check
  CHECK (document_reference IS NULL OR length(document_reference) BETWEEN 1 AND 2000);

ALTER TABLE facility_registrations
  ADD COLUMN IF NOT EXISTS verification_notes text;
ALTER TABLE facility_registrations DROP CONSTRAINT IF EXISTS facility_registrations_verification_notes_check;
ALTER TABLE facility_registrations
  ADD CONSTRAINT facility_registrations_verification_notes_check
  CHECK (verification_notes IS NULL OR length(verification_notes) <= 2000);

COMMENT ON COLUMN facility_registrations.status IS
  'Documentation progress for an optional licence: recorded = provided, awaiting verification; verified; rejected = verification failed, details may be corrected and resubmitted; expired; withdrawn. Only `verified` permits a regulated medicine sale by a Drugshop, and no status restricts ordinary platform access.';
COMMENT ON COLUMN facility_registrations.document_reference IS
  'Optional reference or link to the supporting licence document supplied by the facility.';
COMMENT ON COLUMN facility_registrations.verification_notes IS
  'Optional reviewer note recorded with a verification or rejection decision.';

COMMIT;
