-- Security-event aggregation for platform operators (Phase 5.2/5.3). Additive only.
-- Aggregate counts of security-relevant audit events over a sliding window; no identifiers,
-- no patient data, nothing tenant-attributable — the same disclosure class as app.outbox_backlog().
-- Callable by the runtime role only when the transaction carries the platform_operator GUC
-- (app.platform_role = 'platform_operator'); the function is owned by medveris_exchange
-- (BYPASSRLS, matching the outbox_backlog pattern) because audit_events is FORCE RLS.

BEGIN;

CREATE FUNCTION app.security_event_summary(span_minutes integer)
RETURNS TABLE (action text, decision text, reason_code text, events bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
     AND current_setting('app.platform_role', true) = 'platform_operator'
   GROUP BY a.action, a.decision, a.reason_code
$$;

ALTER FUNCTION app.security_event_summary(integer) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.security_event_summary(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.security_event_summary(integer) TO medveris_runtime;

COMMIT;
