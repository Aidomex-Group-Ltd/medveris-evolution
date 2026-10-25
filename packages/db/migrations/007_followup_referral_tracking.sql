-- Operational tracking for follow-ups and referrals. These columns record a
-- local staff decision; they do not claim that an external facility accepted or
-- received a referral.

BEGIN;

ALTER TABLE follow_ups
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN status_note text,
  ADD COLUMN status_changed_by uuid REFERENCES users(id),
  ADD COLUMN status_changed_at timestamptz;

ALTER TABLE referrals
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN status_note text,
  ADD COLUMN status_changed_by uuid REFERENCES users(id),
  ADD COLUMN status_changed_at timestamptz;

CREATE INDEX follow_ups_tenant_status_due_idx ON follow_ups(tenant_id, status, due_date);
CREATE INDEX referrals_tenant_status_created_idx ON referrals(tenant_id, status, created_at);

COMMIT;
