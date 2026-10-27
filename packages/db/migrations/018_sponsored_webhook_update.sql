-- Payment webhook reconciliation updates the event receipt after the immutable
-- insert. Only platform operators may apply provider callbacks.
BEGIN;

CREATE POLICY sponsored_payment_events_platform_update ON sponsored_payment_events FOR UPDATE USING (
  app.is_platform_operator()
) WITH CHECK (app.is_platform_operator());

COMMIT;
