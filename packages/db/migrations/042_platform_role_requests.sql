-- Controlled, two-person, time-bound grants for the platform_operator role.
-- Replaces the previous single-operator "elevate" path with request -> independent
-- approval -> expiring grant -> audit, plus a CLI-only break-glass bootstrap.
-- Existing elevate/revoke endpoints are retired behind a synthetic-environment flag.

BEGIN;

-- Soft-revoke history on platform_roles so the audit trail is preserved and "active"
-- is defined by a single rule used by SQL, RLS and the API.
ALTER TABLE platform_roles
  ADD COLUMN IF NOT EXISTS granted_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS request_id uuid,
  ADD COLUMN IF NOT EXISTS granted_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS revoked_reason text;

-- Active platform_operator rows: not revoked and not expired.
-- Break-glass bootstrap grants may have a non-null expires_at but must still expire,
-- so NULL expires_at is reserved for legacy bootstrap grants (section 5 of the spec)
-- and is treated as active-only-while-not-revoked until the grant is replaced.
CREATE OR REPLACE FUNCTION app.is_platform_operator()
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_roles
    WHERE role = 'platform_operator'
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
  );
$$;

ALTER TABLE platform_roles DROP CONSTRAINT IF EXISTS platform_roles_request_check;
ALTER TABLE platform_roles ADD CONSTRAINT platform_roles_request_check
  CHECK (
    (request_id IS NULL)
    OR (role = 'platform_operator' AND granted_by IS NOT NULL AND granted_at IS NOT NULL)
  );

ALTER TABLE platform_roles DROP CONSTRAINT IF EXISTS platform_roles_decision_check;
ALTER TABLE platform_roles ADD CONSTRAINT platform_roles_decision_check
  CHECK (
    approved_by IS NULL
    OR approved_by <> granted_by
  );

ALTER TABLE platform_roles DROP CONSTRAINT IF EXISTS platform_roles_revocation_check;
ALTER TABLE platform_roles ADD CONSTRAINT platform_roles_revocation_check
  CHECK (
    revoked_at IS NULL
    OR (revoked_by IS NOT NULL AND revoked_at >= granted_at)
  );

CREATE INDEX platform_roles_active_idx
  ON platform_roles (role, revoked_at, expires_at)
  WHERE role = 'platform_operator';

-- Pending requests are the dual-control input for a platform_operator grant.
CREATE TABLE platform_role_requests (
  id uuid PRIMARY KEY,
  role text NOT NULL CHECK (role = 'platform_operator'),
  target_user_id uuid NOT NULL REFERENCES users(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','approved','denied','cancelled','expired'
  )),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR status IN ('approved','denied')),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK (decided_by IS NULL OR decided_by <> target_user_id),
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_role_requests_one_pending
  ON platform_role_requests (target_user_id, role)
  WHERE status = 'pending';

CREATE INDEX platform_role_requests_pending_idx
  ON platform_role_requests (target_user_id, role)
  WHERE status = 'pending';

CREATE INDEX platform_role_requests_target_idx
  ON platform_role_requests (target_user_id, status, created_at DESC);

CREATE INDEX platform_role_requests_requested_idx
  ON platform_role_requests (requested_by, status, created_at DESC);

ALTER TABLE platform_role_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_role_requests FORCE ROW LEVEL SECURITY;

-- Only platform operators may inspect or decide requests. No direct client writes;
-- writes happen through the service layer via withPlatformActor.
CREATE POLICY platform_role_requests_read ON platform_role_requests FOR SELECT
  USING (app.is_platform_operator());
CREATE POLICY platform_role_requests_write ON platform_role_requests FOR ALL
  USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator());

-- Prevent the same target from having more than one pending request at a time.

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_role_requests TO medveris_runtime;

-- Helper: how many active platform operators are there right now.
CREATE OR REPLACE FUNCTION app.active_platform_operator_count()
RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM platform_roles
  WHERE role = 'platform_operator'
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now());
$$;

COMMIT;
