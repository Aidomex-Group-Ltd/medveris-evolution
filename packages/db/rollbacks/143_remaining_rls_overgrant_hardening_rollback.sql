-- Rollback for migration 143: restores the original permissive policies and DELETE grants.
-- WARNING: this restores public writes to sponsored metrics/reports, unconditional audit/outbox inserts, and recipient-tenant grant reads.

BEGIN;

DROP POLICY IF EXISTS sponsored_metrics_anonymous_insert ON public.sponsored_daily_metrics;
DROP POLICY IF EXISTS sponsored_metrics_anonymous_update ON public.sponsored_daily_metrics;
DROP POLICY IF EXISTS sponsored_metrics_system_insert ON public.sponsored_daily_metrics;
DROP POLICY IF EXISTS sponsored_metrics_system_update ON public.sponsored_daily_metrics;
DROP POLICY IF EXISTS sponsored_metrics_operator_insert ON public.sponsored_daily_metrics;
DROP POLICY IF EXISTS sponsored_metrics_operator_update ON public.sponsored_daily_metrics;
DROP POLICY IF EXISTS sponsored_metrics_write ON public.sponsored_daily_metrics;
CREATE POLICY sponsored_metrics_write ON public.sponsored_daily_metrics
FOR ALL TO public
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS sponsored_payment_events_system_insert ON public.sponsored_payment_events;
DROP POLICY IF EXISTS sponsored_payment_events_operator_insert ON public.sponsored_payment_events;
DROP POLICY IF EXISTS sponsored_payment_events_staff_insert ON public.sponsored_payment_events;
DROP POLICY IF EXISTS sponsored_payment_events_insert ON public.sponsored_payment_events;
CREATE POLICY sponsored_payment_events_insert ON public.sponsored_payment_events
FOR INSERT TO public
WITH CHECK (true);

DROP POLICY IF EXISTS integrations_tenant_select ON public.integration_configs;
DROP POLICY IF EXISTS integrations_tenant_insert ON public.integration_configs;
DROP POLICY IF EXISTS integrations_tenant_update ON public.integration_configs;
DROP POLICY IF EXISTS integrations_tenant_rls_select ON public.integration_configs;
DROP POLICY IF EXISTS integrations_tenant_rls_insert ON public.integration_configs;
DROP POLICY IF EXISTS integrations_tenant_rls_update ON public.integration_configs;
DROP POLICY IF EXISTS integrations_tenant ON public.integration_configs;
CREATE POLICY integrations_tenant ON public.integration_configs
FOR ALL TO public
USING ((tenant_id = app.current_tenant()) OR (tenant_id IS NULL))
WITH CHECK (tenant_id = app.current_tenant());

DROP POLICY IF EXISTS outbox_insert ON public.outbox_events;
CREATE POLICY outbox_insert ON public.outbox_events
FOR INSERT TO public
WITH CHECK ((tenant_id = app.current_tenant()) OR (app.current_user() IS NOT NULL));

DROP POLICY IF EXISTS audit_insert ON public.audit_events;
CREATE POLICY audit_insert ON public.audit_events
FOR INSERT TO public
WITH CHECK ((app.current_user() IS NOT NULL) OR (app.actor_kind() = ANY (ARRAY['registration', 'system', 'anonymous'])));

DROP POLICY IF EXISTS grants_patient_select ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient_insert ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient_update ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient_delete ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient_rls_select ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient_rls_insert ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient_rls_update ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient ON public.exchange_grants;
CREATE POLICY grants_patient ON public.exchange_grants
FOR ALL TO public
USING ((patient_id = app.current_patient()) OR (recipient_tenant_id = app.current_tenant()))
WITH CHECK ((patient_id = app.current_patient()) AND (grantor_user_id = app.current_user()));
CREATE POLICY grants_patient_update ON public.exchange_grants
FOR UPDATE TO public
USING (patient_id = app.current_patient())
WITH CHECK (patient_id = app.current_patient());

DROP POLICY IF EXISTS tenants_logo_update ON public.tenants;
CREATE POLICY tenants_logo_update ON public.tenants
FOR UPDATE TO public
USING (app.is_facility_admin() OR app.is_platform_operator())
WITH CHECK (app.is_facility_admin() OR app.is_platform_operator());

DROP POLICY IF EXISTS directory_reports_insert ON public.directory_reports;
CREATE POLICY directory_reports_insert ON public.directory_reports
FOR INSERT TO public
WITH CHECK (true);

GRANT DELETE ON public.sponsored_daily_metrics TO medveris_runtime;
GRANT DELETE ON public.integration_configs TO medveris_runtime;
GRANT DELETE ON public.outbox_events TO medveris_runtime;
GRANT DELETE ON public.directory_reports TO medveris_runtime;
GRANT DELETE ON public.tenants TO medveris_runtime;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medveris_app') THEN
    GRANT DELETE ON public.sponsored_daily_metrics TO medveris_app;
    GRANT DELETE ON public.integration_configs TO medveris_app;
    GRANT DELETE ON public.outbox_events TO medveris_app;
    GRANT DELETE ON public.directory_reports TO medveris_app;
    GRANT DELETE ON public.tenants TO medveris_app;
  END IF;
END
$$;

COMMIT;
