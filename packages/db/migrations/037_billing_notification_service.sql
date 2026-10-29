-- Billing service writes its own notifications.
--
-- The API runs billing operations in a system context so the service may update subscriptions and
-- invoices after the caller has been authorized. Writing the related notification as a direct insert
-- from that path can still trip the row-level policy under a cached statement plan, which made
-- accepting a plan fail after the trial was cancelled. The billing service records the notification
-- through this privileged function instead, the same way usage metering records usage events.
--
-- Additive: reads and the notification guard are unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION app.record_billing_notification(
  p_account uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_dedupe_key text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  created uuid;
BEGIN
  INSERT INTO billing_notifications (billing_account_id, kind, title, body, dedupe_key)
  VALUES (p_account, p_kind, p_title, p_body, p_dedupe_key)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO created;
  RETURN created;
END;
$$;
ALTER FUNCTION app.record_billing_notification(uuid, text, text, text, text) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.record_billing_notification(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_billing_notification(uuid, text, text, text, text) TO medveris_runtime;
GRANT EXECUTE ON FUNCTION app.record_billing_notification(uuid, text, text, text, text) TO medveris_jobs;
GRANT SELECT, INSERT ON billing_notifications TO medveris_exchange;

COMMIT;
