-- RLS hardening migration 145: remove forgeable platform-role GUC gates.
-- Bootstrap, legacy elevate, content-editor, operator aggregates, and operator policies now use DB-backed role state or a migrator-only session guard.

BEGIN;

CREATE OR REPLACE FUNCTION app.platform_roles_bootstrap()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT session_user = 'medveris_migrator'
     AND COALESCE(current_setting('app.platform_roles_bootstrap', true), 'false') = 'true'
$$;

CREATE OR REPLACE FUNCTION app.is_content_editor()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.platform_roles pr
    WHERE pr.user_id = app.current_user()
      AND pr.role = 'platform_operator'
      AND pr.revoked_at IS NULL
      AND (pr.expires_at IS NULL OR pr.expires_at > now())
  )
  OR (
    session_user = 'medveris_migrator'
    AND COALESCE(NULLIF(current_setting('app.platform_role', true), ''), '') IN ('content_editor', 'content_reviewer')
  )
$$;

CREATE OR REPLACE FUNCTION app.legacy_elevate_available()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT session_user = 'medveris_migrator'
     AND current_setting('app.platform_roles_legacy_elevate', true) = 'true'
$$;

CREATE OR REPLACE FUNCTION app.outbox_backlog()
RETURNS TABLE (status text, events bigint, oldest_seconds double precision, max_attempts integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.status, count(*), extract(epoch FROM now() - min(o.occurred_at)), max(o.attempt_count)
    FROM outbox_events o
   WHERE o.status <> 'processed'
     AND app.current_user() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM platform_roles pr
       WHERE pr.user_id = app.current_user()
         AND pr.role = 'platform_operator'
         AND pr.revoked_at IS NULL
         AND (pr.expires_at IS NULL OR pr.expires_at > now())
     )
   GROUP BY o.status
$$;

CREATE OR REPLACE FUNCTION app.security_event_summary(span_minutes integer)
RETURNS TABLE (action text, decision text, reason_code text, events bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.action, a.decision, a.reason_code, count(*)
    FROM audit_events a
   WHERE a.action IN (
      'auth.login', 'auth.email.verify', 'auth.mfa.email-code.send', 'auth.mfa.email-code.verify',
      'auth.mfa.recovery-code.use', 'auth.mfa.enroll', 'auth.password.reset', 'session.context.switch',
      'legal.acceptance',
      'exchange.records.read', 'consent.grant.create', 'consent.grant.revoke',
      'referral.share.create', 'referral.share.revoke',
      'emergency.override.create', 'emergency.override.records.read', 'emergency.override.review', 'emergency.override.revoke',
      'patient.merge.request', 'patient.merge.complete', 'patient.merge.reject', 'patient.merge.reverse', 'patient.merge.reversed',
      'patient.duplicate.review', 'patient.proxy.request',
      'membership.invite', 'membership.invitation.revoke', 'membership.invitation.decline', 'membership.accept-invitation',
      'membership.roles.change', 'membership.remove',
      'role_grant.request', 'role_grant.approve',
      'platform_operator.request', 'platform_operator.approve', 'platform_operator.deny', 'platform_operator.cancel',
      'platform_operator.revoke', 'platform_operator.expire', 'platform_operator.break_glass_grant',
      'platform_operator.legacy_elevate', 'platform_operator.legacy_revoke',
      'integration.patient.match', 'integration.patient.link', 'integration.patient.unlink',
      'upload.scan.local', 'upload.quarantine', 'upload.content.read',
      'subscription.checkout'
   )
     AND a.occurred_at > now() - make_interval(mins => GREATEST(1, LEAST(COALESCE(span_minutes, 60), 10080)))
     AND app.current_user() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM platform_roles pr
       WHERE pr.user_id = app.current_user()
         AND pr.role = 'platform_operator'
         AND pr.revoked_at IS NULL
         AND (pr.expires_at IS NULL OR pr.expires_at > now())
     )
   GROUP BY a.action, a.decision, a.reason_code
$$;

DROP POLICY IF EXISTS integration_verifications_record ON public.integration_verifications;
CREATE POLICY integration_verifications_record ON public.integration_verifications
FOR INSERT TO medveris_runtime
WITH CHECK (app.is_platform_operator());

DROP POLICY IF EXISTS support_tickets_operator_all ON public.support_tickets;
CREATE POLICY support_tickets_operator_all ON public.support_tickets
FOR ALL TO public
USING (app.is_platform_operator())
WITH CHECK (app.is_platform_operator());

DROP POLICY IF EXISTS support_ticket_events_operator_all ON public.support_ticket_events;
CREATE POLICY support_ticket_events_operator_all ON public.support_ticket_events
FOR ALL TO public
USING (app.is_platform_operator())
WITH CHECK (app.is_platform_operator());

COMMIT;
