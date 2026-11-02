-- Legacy platform_operator elevate/revoke endpoints remain available only in the
-- environments named in app.platform_roles.legacy_elevate_environments. Outside those
-- environments the endpoints refuse with 410 Gone so callers are nudged toward the
-- request/approve/revoke workflow in apps/api/src/routes/admin.ts.
--
-- Additive and backward compatible for local and staging development.

BEGIN;

CREATE OR REPLACE FUNCTION app.legacy_elevate_available()
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.platform_roles_legacy_elevate', true) = 'true';
$$;

REVOKE ALL ON FUNCTION app.legacy_elevate_available() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.legacy_elevate_available() TO medveris_runtime;

COMMIT;
