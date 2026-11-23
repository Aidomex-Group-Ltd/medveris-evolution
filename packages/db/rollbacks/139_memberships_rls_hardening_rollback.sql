-- Rollback for 139_memberships_rls_hardening.sql
--
-- Restores the exact membership policy set recorded before migration 139 on
-- the local staging copy (/tmp/rls/memberships_original_policies.sql) and
-- removes the helpers/triggers added by 139. This is a security regression if
-- applied intentionally: it re-opens the membership write policies.

BEGIN;

DO $rollback$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'memberships'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.memberships', policy_row.policyname);
  END LOOP;
END
$rollback$;

DROP TRIGGER IF EXISTS memberships_guard ON public.memberships;
DROP TRIGGER IF EXISTS memberships_last_admin_guard ON public.memberships;
DROP FUNCTION IF EXISTS app.memberships_tenant_has_any(uuid);
DROP FUNCTION IF EXISTS app.memberships_guard();
DROP FUNCTION IF EXISTS app.memberships_last_admin_guard();

CREATE POLICY memberships_tenant ON public.memberships USING (((tenant_id = app.current_tenant()) OR (user_id = app."current_user"()) OR (app.current_membership_id() = id))) WITH CHECK ((tenant_id = app.current_tenant()));
CREATE POLICY memberships_jobs_usage ON public.memberships FOR SELECT TO medveris_jobs USING (true);
CREATE POLICY memberships_write_any ON public.memberships FOR INSERT WITH CHECK (app.is_platform_operator());
CREATE POLICY memberships_write_any_via_platform ON public.memberships FOR INSERT WITH CHECK (app.is_platform_operator());
CREATE POLICY memberships_write_any_via_platform_and_user_id ON public.memberships FOR INSERT WITH CHECK ((app.is_platform_operator() AND (user_id = app."current_user"())));
CREATE POLICY memberships_write_any_via_platform_and_user_id_on_any_tenant ON public.memberships FOR INSERT WITH CHECK ((app.is_platform_operator() AND (user_id = app."current_user"()) AND (app.current_tenant() IS NOT NULL)));
CREATE POLICY memberships_write_any_via_platform_and_user_id_on_current_tenan ON public.memberships FOR INSERT WITH CHECK ((app.is_platform_operator() AND (user_id = app."current_user"()) AND (tenant_id = app.current_tenant())));
CREATE POLICY memberships_write_any_via_platform_or_user_id ON public.memberships FOR INSERT WITH CHECK (((app.is_platform_operator() OR (user_id = app."current_user"()))));
CREATE POLICY memberships_write_any_via_platform_or_user_id_on_any_tenant ON public.memberships FOR INSERT WITH CHECK (((app.is_platform_operator() OR (user_id = app."current_user"())) AND (app.current_tenant() IS NOT NULL)));
CREATE POLICY memberships_write_any_via_platform_or_user_id_on_current_tenant ON public.memberships FOR INSERT WITH CHECK (((app.is_platform_operator() OR (user_id = app."current_user"())) AND (tenant_id = app.current_tenant())));
CREATE POLICY memberships_write_any_via_user_id ON public.memberships FOR INSERT WITH CHECK ((user_id = app."current_user"()));
CREATE POLICY memberships_write_direct ON public.memberships FOR INSERT WITH CHECK ((user_id = app."current_user"()));
CREATE POLICY memberships_write_owner ON public.memberships FOR INSERT WITH CHECK (((tenant_id = app.current_tenant()) AND (user_id = app."current_user"())));
CREATE POLICY memberships_write_owner_on_current_tenant_via_platform ON public.memberships FOR INSERT WITH CHECK (((tenant_id = app.current_tenant()) AND app.is_platform_operator()));
CREATE POLICY memberships_write_owner_override ON public.memberships FOR INSERT WITH CHECK ((user_id = app."current_user"()));
CREATE POLICY memberships_write_owner_via_user ON public.memberships FOR INSERT WITH CHECK ((user_id = app."current_user"()));
CREATE POLICY memberships_write_platform ON public.memberships FOR INSERT WITH CHECK (app.is_platform_operator());
CREATE POLICY memberships_write_platform_any ON public.memberships FOR INSERT WITH CHECK (app.is_platform_operator());
CREATE POLICY memberships_write_platform_on_any_tenant_via_platform ON public.memberships FOR INSERT WITH CHECK ((app.is_platform_operator() AND (app.current_tenant() IS NOT NULL)));
CREATE POLICY memberships_write_platform_on_any_tenant_via_platform_any ON public.memberships FOR INSERT WITH CHECK (app.is_platform_operator());
CREATE POLICY memberships_write_platform_on_any_tenant_via_user_id ON public.memberships FOR INSERT WITH CHECK (((user_id = app."current_user"()) AND (app.current_tenant() IS NOT NULL)));
CREATE POLICY memberships_write_platform_operator_on_any_tenant ON public.memberships FOR INSERT WITH CHECK (app.is_platform_operator());
CREATE POLICY memberships_write_registration ON public.memberships FOR INSERT WITH CHECK (((tenant_id = app.current_tenant()) AND (app.actor_kind() = ANY (ARRAY['registration'::text, 'system'::text]))));
CREATE POLICY memberships_write_registration_on_any_tenant_via_actor ON public.memberships FOR INSERT WITH CHECK ((app.actor_kind() = ANY (ARRAY['registration'::text, 'system'::text])));
CREATE POLICY memberships_write_registration_on_any_tenant_via_platform ON public.memberships FOR INSERT WITH CHECK (((app.actor_kind() = ANY (ARRAY['registration'::text, 'system'::text])) AND app.is_platform_operator()));
CREATE POLICY memberships_write_registration_on_current_tenant_via_actor ON public.memberships FOR INSERT WITH CHECK (((tenant_id = app.current_tenant()) AND (app.actor_kind() = ANY (ARRAY['registration'::text, 'system'::text]))));
CREATE POLICY memberships_write_registration_on_current_tenant_via_platform ON public.memberships FOR INSERT WITH CHECK (((tenant_id = app.current_tenant()) AND (app.actor_kind() = ANY (ARRAY['registration'::text, 'system'::text])) AND app.is_platform_operator()));
CREATE POLICY memberships_write_via_user_id ON public.memberships FOR INSERT WITH CHECK ((user_id = app."current_user"()));
CREATE POLICY memberships_write_via_user_id_on_any_tenant ON public.memberships FOR INSERT WITH CHECK ((user_id = app."current_user"()));
CREATE POLICY memberships_update ON public.memberships FOR UPDATE USING (((tenant_id = app.current_tenant()) OR (app.current_membership_id() = id))) WITH CHECK ((tenant_id = app.current_tenant()));
CREATE POLICY memberships_delete ON public.memberships FOR DELETE USING ((tenant_id = app.current_tenant()));

ALTER TABLE public.memberships
  ENABLE ROW LEVEL SECURITY,
  FORCE ROW LEVEL SECURITY;

COMMIT;
