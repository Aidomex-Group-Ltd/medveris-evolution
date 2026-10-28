-- Staff invitation lifecycle.
--
-- Invitees are not members of the inviting facility, so the tenant policy hid their invitation and
-- every lookup or acceptance failed. The application now proves possession of the emailed token by
-- setting app.invitation_token_hash for the transaction; only that one row becomes visible and
-- updatable. Adds revocation, decline and the accepting account. Additive only.

BEGIN;

ALTER TABLE invitations
  ADD COLUMN accepted_by uuid REFERENCES users(id),
  ADD COLUMN membership_id uuid REFERENCES memberships(id),
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid REFERENCES users(id),
  ADD COLUMN declined_at timestamptz,
  ADD CONSTRAINT invitations_single_outcome CHECK (num_nonnulls(accepted_at, revoked_at, declined_at) <= 1);

CREATE INDEX invitations_tenant_created_idx ON invitations(tenant_id, created_at);
CREATE INDEX invitations_pending_email_idx ON invitations(tenant_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL;

CREATE OR REPLACE FUNCTION app.invitation_token_hash() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.invitation_token_hash', true), '')
$$;

CREATE POLICY invitations_token_read ON invitations FOR SELECT
  USING (token_hash = app.invitation_token_hash());
CREATE POLICY invitations_token_update ON invitations FOR UPDATE
  USING (token_hash = app.invitation_token_hash())
  WITH CHECK (token_hash = app.invitation_token_hash());

COMMIT;
