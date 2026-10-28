-- Emailed sign-in codes and attempt limits for the sign-in verification step.
--
-- A user who has passed the password check may ask for a six-digit code to be
-- emailed instead of using their authenticator app. Only a hash of the code is
-- stored, bound to the challenge. Send and failed-attempt counts live on the
-- challenge because the API's in-memory rate limits are per instance.
-- Additive only.

BEGIN;

ALTER TABLE auth_challenges
  ADD COLUMN email_code_hash text,
  ADD COLUMN email_code_expires_at timestamptz,
  ADD COLUMN email_code_sent_at timestamptz,
  ADD COLUMN email_code_sends integer NOT NULL DEFAULT 0 CHECK (email_code_sends >= 0),
  ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  ADD COLUMN verified_method text CHECK (verified_method IN ('totp', 'email', 'recovery'));

COMMIT;
