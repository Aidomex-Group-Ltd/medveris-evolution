-- Allow tenant-scoped integration clients to read only patients they are
-- already entitled to see, and allow facility administrators to submit
-- integration applications without platform-operator rights.
BEGIN;

CREATE POLICY patients_integration_read ON patients FOR SELECT USING (
  app.actor_kind() = 'system'
  AND app.current_tenant() IS NOT NULL
  AND (
    created_tenant_id = app.current_tenant()
    OR EXISTS (
      SELECT 1 FROM tenant_patient_links l
       WHERE l.patient_id = patients.id AND l.tenant_id = app.current_tenant()
    )
  )
);

CREATE POLICY integration_clients_tenant_insert ON integration_clients FOR INSERT WITH CHECK (
  tenant_id = app.current_tenant() AND created_by = app.current_user()
);

COMMIT;
