-- Emergency break-glass access: revocation metadata (Phase 3 / 3.3). Additive only:
-- no existing column, constraint, policy or trigger changed.
-- emergency_overrides.revoked_at already existed but could not be set by any route and
-- carry no actor/reason; this migration adds the missing attribution columns so an
-- active override can be revoked by its requester or by governance, with audit.

BEGIN;

ALTER TABLE emergency_overrides ADD COLUMN IF NOT EXISTS revoked_by uuid REFERENCES users(id);
ALTER TABLE emergency_overrides ADD COLUMN IF NOT EXISTS revoked_reason text;

COMMIT;
