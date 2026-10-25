-- Operational role refinements for facilities that separate clinical care
-- from bed turnaround and portering. Housekeeping may change bed readiness
-- and record cleaning work but may not admit, transfer or discharge patients.

BEGIN;

DROP POLICY IF EXISTS beds_tenant ON beds;
CREATE POLICY beds_tenant ON beds USING (
  tenant_id = app.current_tenant()
) WITH CHECK (
  tenant_id = app.current_tenant()
  AND app.has_any_role(ARRAY['clinician','nurse','facility_admin','housekeeping'])
);

-- Portering updates are scoped to operational tasks only; porters cannot
-- mutate clinical encounters or admissions.
DROP POLICY IF EXISTS porter_access ON porter_tasks;
CREATE POLICY porter_access ON porter_tasks USING (
  tenant_id = app.current_tenant()
  AND app.has_any_role(ARRAY['porter','facility_admin','clinician','nurse'])
) WITH CHECK (
  tenant_id = app.current_tenant()
  AND app.has_any_role(ARRAY['porter','facility_admin','nurse','clinician'])
);

COMMIT;
