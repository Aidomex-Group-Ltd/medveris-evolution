-- RLS hardening migration 143: narrow remaining public INSERT/UPDATE over-grants while preserving real flows.
-- Sponsored analytics and reports stay writable by validated anonymous/public flows; payment events allow verified staff/system/operator flows.
-- Audit and outbox writes are pinned to session GUCs with explicit exceptions for existing system, platform, reviewer, and organization flows.

BEGIN;

DROP POLICY IF EXISTS sponsored_metrics_write ON public.sponsored_daily_metrics;
DROP POLICY IF EXISTS sponsored_metrics_anonymous_insert ON public.sponsored_daily_metrics;
DROP POLICY IF EXISTS sponsored_metrics_anonymous_update ON public.sponsored_daily_metrics;
DROP POLICY IF EXISTS sponsored_metrics_system_insert ON public.sponsored_daily_metrics;
DROP POLICY IF EXISTS sponsored_metrics_system_update ON public.sponsored_daily_metrics;
DROP POLICY IF EXISTS sponsored_metrics_operator_insert ON public.sponsored_daily_metrics;
DROP POLICY IF EXISTS sponsored_metrics_operator_update ON public.sponsored_daily_metrics;

CREATE POLICY sponsored_metrics_anonymous_insert ON public.sponsored_daily_metrics
FOR INSERT TO public
WITH CHECK (
  app.actor_kind() = 'anonymous'
  AND app.current_tenant() IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.sponsored_campaigns c
    JOIN public.directory_facilities f ON f.id = c.facility_id
    WHERE c.id = sponsored_daily_metrics.campaign_id
      AND c.facility_id = sponsored_daily_metrics.facility_id
      AND c.status = 'active'
      AND c.payment_status = 'paid'
      AND c.editorial_status = 'approved'
      AND f.publication_status = 'published'
      AND f.status = 'active'
  )
);

CREATE POLICY sponsored_metrics_anonymous_update ON public.sponsored_daily_metrics
FOR UPDATE TO public
USING (
  app.actor_kind() = 'anonymous'
  AND app.current_tenant() IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.sponsored_campaigns c
    JOIN public.directory_facilities f ON f.id = c.facility_id
    WHERE c.id = sponsored_daily_metrics.campaign_id
      AND c.facility_id = sponsored_daily_metrics.facility_id
      AND c.status = 'active'
      AND c.payment_status = 'paid'
      AND c.editorial_status = 'approved'
      AND f.publication_status = 'published'
      AND f.status = 'active'
  )
)
WITH CHECK (
  app.actor_kind() = 'anonymous'
  AND app.current_tenant() IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.sponsored_campaigns c
    JOIN public.directory_facilities f ON f.id = c.facility_id
    WHERE c.id = sponsored_daily_metrics.campaign_id
      AND c.facility_id = sponsored_daily_metrics.facility_id
      AND c.status = 'active'
      AND c.payment_status = 'paid'
      AND c.editorial_status = 'approved'
      AND f.publication_status = 'published'
      AND f.status = 'active'
  )
);

CREATE POLICY sponsored_metrics_system_insert ON public.sponsored_daily_metrics
FOR INSERT TO public
WITH CHECK (app.actor_kind() = 'system');

CREATE POLICY sponsored_metrics_system_update ON public.sponsored_daily_metrics
FOR UPDATE TO public
USING (app.actor_kind() = 'system')
WITH CHECK (app.actor_kind() = 'system');

CREATE POLICY sponsored_metrics_operator_insert ON public.sponsored_daily_metrics
FOR INSERT TO public
WITH CHECK (app.is_platform_operator());

CREATE POLICY sponsored_metrics_operator_update ON public.sponsored_daily_metrics
FOR UPDATE TO public
USING (app.is_platform_operator())
WITH CHECK (app.is_platform_operator());

DROP POLICY IF EXISTS sponsored_metrics_anonymous_read ON public.sponsored_daily_metrics;
CREATE POLICY sponsored_metrics_anonymous_read ON public.sponsored_daily_metrics
FOR SELECT TO public
USING (
  app.actor_kind() = 'anonymous'
  AND app.current_tenant() IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.sponsored_campaigns c
    JOIN public.directory_facilities f ON f.id = c.facility_id
    WHERE c.id = sponsored_daily_metrics.campaign_id
      AND c.facility_id = sponsored_daily_metrics.facility_id
      AND c.status = 'active'
      AND c.payment_status = 'paid'
      AND c.editorial_status = 'approved'
      AND f.publication_status = 'published'
      AND f.status = 'active'
  )
);

DROP POLICY IF EXISTS sponsored_payment_events_insert ON public.sponsored_payment_events;
DROP POLICY IF EXISTS sponsored_payment_events_system_insert ON public.sponsored_payment_events;
DROP POLICY IF EXISTS sponsored_payment_events_operator_insert ON public.sponsored_payment_events;
DROP POLICY IF EXISTS sponsored_payment_events_staff_insert ON public.sponsored_payment_events;

CREATE POLICY sponsored_payment_events_system_insert ON public.sponsored_payment_events
FOR INSERT TO public
WITH CHECK (app.actor_kind() = 'system');

CREATE POLICY sponsored_payment_events_operator_insert ON public.sponsored_payment_events
FOR INSERT TO public
WITH CHECK (app.is_platform_operator());

CREATE POLICY sponsored_payment_events_staff_insert ON public.sponsored_payment_events
FOR INSERT TO public
WITH CHECK (
  app.actor_kind() = 'staff'
  AND app.current_user() IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.sponsored_payments p
    WHERE p.id = sponsored_payment_events.payment_id
      AND p.status IN ('pending', 'confirmed')
  )
);

DROP POLICY IF EXISTS integrations_tenant ON public.integration_configs;
DROP POLICY IF EXISTS integrations_tenant_rls_select ON public.integration_configs;
DROP POLICY IF EXISTS integrations_tenant_rls_insert ON public.integration_configs;
DROP POLICY IF EXISTS integrations_tenant_rls_update ON public.integration_configs;
DROP POLICY IF EXISTS integrations_tenant_select ON public.integration_configs;
DROP POLICY IF EXISTS integrations_tenant_insert ON public.integration_configs;
DROP POLICY IF EXISTS integrations_tenant_update ON public.integration_configs;

CREATE POLICY integrations_tenant_select ON public.integration_configs
FOR SELECT TO public
USING (
  app.is_platform_operator()
  OR tenant_id = app.current_tenant()
  OR tenant_id IS NULL
);

CREATE POLICY integrations_tenant_insert ON public.integration_configs
FOR INSERT TO public
WITH CHECK (
  app.is_platform_operator()
  OR (
    tenant_id IS NOT NULL
    AND tenant_id = app.current_tenant()
    AND app.actor_kind() = 'staff'
  )
);

CREATE POLICY integrations_tenant_update ON public.integration_configs
FOR UPDATE TO public
USING (
  app.is_platform_operator()
  OR (
    tenant_id IS NOT NULL
    AND tenant_id = app.current_tenant()
    AND app.actor_kind() = 'staff'
  )
)
WITH CHECK (
  app.is_platform_operator()
  OR (
    tenant_id IS NOT NULL
    AND tenant_id = app.current_tenant()
    AND app.actor_kind() = 'staff'
  )
);

DROP POLICY IF EXISTS outbox_insert ON public.outbox_events;
CREATE POLICY outbox_insert ON public.outbox_events
FOR INSERT TO public
WITH CHECK (
  (
    tenant_id IS NOT NULL
    AND tenant_id = app.current_tenant()
    AND app.current_tenant() IS NOT NULL
  )
  OR (
    tenant_id IS NULL
    AND (
      app.actor_kind() IN ('system', 'anonymous', 'registration')
      OR (app.actor_kind() = 'patient' AND app.current_patient() IS NOT NULL)
      OR app.is_platform_operator()
      OR app.is_platform_reviewer()
    )
  )
);

DROP POLICY IF EXISTS audit_insert ON public.audit_events;
CREATE POLICY audit_insert ON public.audit_events
FOR INSERT TO public
WITH CHECK (
  (
    tenant_id IS NOT DISTINCT FROM app.current_tenant()
    OR app.actor_kind() = 'system'
    OR app.is_platform_operator()
    OR app.is_platform_reviewer()
    OR (
      app.actor_kind() = 'staff'
      AND app.current_tenant() IS NULL
      AND app.current_user() IS NOT NULL
      AND (
        tenant_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.memberships m
          WHERE m.user_id = app.current_user()
            AND m.tenant_id = audit_events.tenant_id
            AND m.status = 'active'
        )
        OR EXISTS (
          SELECT 1
          FROM public.organization_memberships om
          JOIN public.organization_links ol ON ol.organization_id = om.organization_id
          WHERE om.user_id = app.current_user()
            AND om.status = 'active'
            AND ol.status = 'active'
            AND ol.tenant_id = audit_events.tenant_id
        )
      )
    )
  )
  AND (
    actor_kind = app.actor_kind()
    OR (app.actor_kind() = 'system' AND actor_kind IN ('system', 'staff', 'patient', 'anonymous', 'registration'))
    OR (app.is_platform_operator() AND actor_kind IN ('staff', 'patient', 'system', 'anonymous'))
    OR (app.is_platform_reviewer() AND actor_kind IN ('staff', 'system'))
    OR (app.actor_kind() = 'registration' AND actor_kind IN ('registration', 'staff'))
    OR (app.actor_kind() = 'staff' AND app.current_tenant() IS NULL AND actor_kind IN ('staff', 'patient'))
  )
);

DROP POLICY IF EXISTS grants_patient ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient_rls_select ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient_rls_insert ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient_rls_update ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient_select ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient_insert ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient_update ON public.exchange_grants;
DROP POLICY IF EXISTS grants_patient_delete ON public.exchange_grants;

CREATE POLICY grants_patient_select ON public.exchange_grants
FOR SELECT TO public
USING (
  (patient_id = app.current_patient() AND grantor_user_id = app.current_user())
  OR (recipient_tenant_id = app.current_tenant() AND app.current_tenant() IS NOT NULL)
);

CREATE POLICY grants_patient_insert ON public.exchange_grants
FOR INSERT TO public
WITH CHECK (
  patient_id = app.current_patient()
  AND grantor_user_id = app.current_user()
  AND app.current_user() IS NOT NULL
);

CREATE POLICY grants_patient_update ON public.exchange_grants
FOR UPDATE TO public
USING (
  patient_id = app.current_patient()
  AND grantor_user_id = app.current_user()
  AND app.current_user() IS NOT NULL
)
WITH CHECK (
  patient_id = app.current_patient()
  AND grantor_user_id = app.current_user()
  AND app.current_user() IS NOT NULL
);

CREATE POLICY grants_patient_delete ON public.exchange_grants
FOR DELETE TO public
USING (
  patient_id = app.current_patient()
  AND grantor_user_id = app.current_user()
  AND app.current_user() IS NOT NULL
);

DROP POLICY IF EXISTS tenants_logo_update ON public.tenants;
CREATE POLICY tenants_logo_update ON public.tenants
FOR UPDATE TO public
USING (
  (app.is_facility_admin() OR app.is_platform_operator())
  AND id = app.current_tenant()
)
WITH CHECK (
  (app.is_facility_admin() OR app.is_platform_operator())
  AND id = app.current_tenant()
);

DROP POLICY IF EXISTS directory_reports_insert ON public.directory_reports;
CREATE POLICY directory_reports_insert ON public.directory_reports
FOR INSERT TO public
WITH CHECK (
  app.actor_kind() = 'anonymous'
  AND EXISTS (
    SELECT 1
    FROM public.directory_facilities f
    WHERE f.id = directory_reports.facility_id
      AND f.publication_status = 'published'
      AND f.status = 'active'
  )
);

REVOKE DELETE ON public.sponsored_daily_metrics FROM medveris_runtime;
REVOKE DELETE ON public.integration_configs FROM medveris_runtime;
REVOKE DELETE ON public.outbox_events FROM medveris_runtime;
REVOKE DELETE ON public.directory_reports FROM medveris_runtime;
REVOKE DELETE ON public.tenants FROM medveris_runtime;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medveris_app') THEN
    REVOKE DELETE ON public.sponsored_daily_metrics FROM medveris_app;
    REVOKE DELETE ON public.integration_configs FROM medveris_app;
    REVOKE DELETE ON public.outbox_events FROM medveris_app;
    REVOKE DELETE ON public.directory_reports FROM medveris_app;
    REVOKE DELETE ON public.tenants FROM medveris_app;
  END IF;
END
$$;

ALTER TABLE public.sponsored_daily_metrics FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sponsored_payment_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.integration_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE public.directory_reports FORCE ROW LEVEL SECURITY;

COMMIT;
