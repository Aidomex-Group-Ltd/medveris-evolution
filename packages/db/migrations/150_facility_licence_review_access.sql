-- Migration 150: platform review access to optional facility licence records.
--
-- Migration 149 made a licence optional documentation. A platform reviewer now needs to see a
-- facility's submitted details and record a verification outcome, without gaining any other
-- access to that facility's data. Until now `facility_registrations` was reachable only through
-- the owning tenant's policies, so a platform operator (who has no facility context) saw nothing.
--
-- The two policies below are additive and limited to `app.is_platform_operator()`, which since
-- migration 045 is identity-bound: it requires an active, unrevoked platform_roles row for the
-- session's user. They do not touch the existing tenant policies, and they grant no INSERT or
-- DELETE. The route layer limits an operator to the verification columns (status, verified_by,
-- verified_at, verification_notes); it never edits the facility's submitted details.
--
-- Forward plan: additive policies only; the previous Worker version does not read them.
-- Rollback: packages/db/rollbacks/150_facility_licence_review_access_rollback.sql

BEGIN;

DROP POLICY IF EXISTS facility_registrations_platform_read ON facility_registrations;
CREATE POLICY facility_registrations_platform_read ON facility_registrations FOR SELECT
  USING (app.is_platform_operator());

DROP POLICY IF EXISTS facility_registrations_platform_review ON facility_registrations;
CREATE POLICY facility_registrations_platform_review ON facility_registrations FOR UPDATE
  USING (app.is_platform_operator())
  WITH CHECK (app.is_platform_operator());

COMMIT;
