-- Harden direct-record access that was intentionally broad during the foundation milestone.
-- The global patient directory remains readable for exact identity resolution, but clinical
-- updates are scoped to the facility that holds a patient link.

DROP POLICY patients_staff_update ON patients;
CREATE POLICY patients_staff_update ON patients FOR UPDATE
  USING (
    app.actor_kind() = 'staff'
    AND EXISTS (
      SELECT 1 FROM tenant_patient_links l
       WHERE l.patient_id = patients.id AND l.tenant_id = app.current_tenant()
    )
  )
  WITH CHECK (
    app.actor_kind() = 'staff'
    AND EXISTS (
      SELECT 1 FROM tenant_patient_links l
       WHERE l.patient_id = patients.id AND l.tenant_id = app.current_tenant()
    )
  );

-- Pre-authentication denial evidence must be appendable without an authenticated actor.
DROP POLICY audit_insert ON audit_events;
CREATE POLICY audit_insert ON audit_events FOR INSERT
  WITH CHECK (
    app.current_user() IS NOT NULL
    OR app.actor_kind() IN ('registration', 'system', 'anonymous')
  );
