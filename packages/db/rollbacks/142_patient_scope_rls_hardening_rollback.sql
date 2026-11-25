-- Rollback for migration 142: restores the original broad staff patient and patient-account reads.
-- WARNING: this reintroduces cross-tenant PHI visibility and must only be used to unwind a failed deploy.

BEGIN;

DROP POLICY IF EXISTS patients_staff_read ON public.patients;
CREATE POLICY patients_staff_read ON public.patients
FOR SELECT TO public
USING (
  app.actor_kind() = 'staff'
  AND app.current_user() IS NOT NULL
);

DROP POLICY IF EXISTS patient_accounts_staff ON public.patient_accounts;
CREATE POLICY patient_accounts_staff ON public.patient_accounts
FOR SELECT TO public
USING (app.actor_kind() = 'staff');

DROP FUNCTION IF EXISTS app.patient_exchange_lookup(text);
DROP FUNCTION IF EXISTS app.patient_enrollment_lookup(text, text, date);

COMMIT;
