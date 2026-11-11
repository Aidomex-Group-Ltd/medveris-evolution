-- 08a — Neon DBA PRE-provisioning for migrations 125/126 (staging)
--
-- Run against the Neon database `medveris_staging` as a Neon admin role that has
-- CREATEROLE *and* BYPASSRLS (for example `neondb_owner` or `neon_service`), or as
-- the Neon superuser (`cloud_admin`). Neon SQL Editor / psql are both fine.
--
-- Purpose: create the dedicated NOLOGIN SECURITY DEFINER owner and grant the
-- migrator a *temporary, non-inheriting but SET-capable* membership so that the
-- approved migration runner can execute the `ALTER FUNCTION ... OWNER TO` in
-- migration 125. The membership MUST be removed by 08b immediately afterwards.
--
-- This script is idempotent. It does not modify application data.

DO $$
DECLARE
  v_me            text := current_user;
  v_db            text := current_database();
  v_super         boolean;
  v_createrole    boolean;
  v_bypassrls     boolean;
  v_admin         boolean;
  v_applied       int;
  v_guard_exists  boolean;
  v_migrator      boolean;
  v_runtime       boolean;
  v_exchange      boolean;
  v_app_owner     text;
  v_public_owner  text;
  v_role_fn       boolean;
BEGIN
  IF v_db NOT IN ('medveris_staging', 'medveris-prod') THEN
    RAISE EXCEPTION 'Refusing to provision on unexpected database %', v_db;
  END IF;

  SELECT rolsuper, rolcreaterole, rolbypassrls
    INTO v_super, v_createrole, v_bypassrls
    FROM pg_roles WHERE rolname = v_me;

  IF NOT (COALESCE(v_super,false) OR (COALESCE(v_createrole,false) AND COALESCE(v_bypassrls,false))) THEN
    RAISE EXCEPTION
      'Run as a role with (CREATEROLE and BYPASSRLS) or SUPERUSER; current_user=% (createrole=%, bypassrls=%, superuser=%)',
      v_me, v_createrole, v_bypassrls, v_super;
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medveris_migrator') INTO v_migrator;
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medveris_runtime')  INTO v_runtime;
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medveris_exchange') INTO v_exchange;
  IF NOT v_migrator OR NOT v_runtime OR NOT v_exchange THEN
    RAISE EXCEPTION 'medveris_migrator, medveris_runtime and medveris_exchange must exist before 125/126';
  END IF;

  SELECT pg_get_userbyid(nspowner) INTO v_app_owner    FROM pg_namespace WHERE nspname = 'app';
  SELECT pg_get_userbyid(nspowner) INTO v_public_owner FROM pg_namespace WHERE nspname = 'public';
  IF v_app_owner IS DISTINCT FROM 'medveris_migrator' OR v_public_owner IS DISTINCT FROM 'medveris_migrator' THEN
    RAISE EXCEPTION
      'schema ownership mismatch: app=%, public=% (expected medveris_migrator); migration 125/126 would fail',
      v_app_owner, v_public_owner;
  END IF;

  SELECT to_regprocedure('app.organization_role(uuid)') IS NOT NULL INTO v_role_fn;
  IF NOT v_role_fn THEN
    RAISE EXCEPTION 'app.organization_role(uuid) is missing; apply earlier migrations before 125';
  END IF;

  -- 1. Create the dedicated helper owner if missing.
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medveris_transfer_guard') INTO v_guard_exists;
  IF NOT v_guard_exists THEN
    CREATE ROLE medveris_transfer_guard NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
    RAISE NOTICE 'created role medveris_transfer_guard';
  ELSE
    RAISE NOTICE 'role medveris_transfer_guard already exists';
  END IF;

  -- 2. Enforce the exact least-privilege attributes even if it pre-existed.
  ALTER ROLE medveris_transfer_guard NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;

  -- 3. Confirm this session may administer the guard role (creator gets ADMIN automatically).
  IF NOT COALESCE(v_super,false) THEN
    SELECT COALESCE(m.admin_option,false) INTO v_admin
      FROM pg_auth_members m
      JOIN pg_roles r ON r.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member
     WHERE r.rolname = 'medveris_transfer_guard' AND u.rolname = v_me;
    IF NOT COALESCE(v_admin,false) THEN
      RAISE EXCEPTION
        'current_user % lacks ADMIN OPTION on medveris_transfer_guard; run as its creating/admin role',
        v_me;
    END IF;
  END IF;

  -- 4. If 125/126 are already recorded, do not create a new escalation window.
  SELECT count(*) INTO v_applied
    FROM schema_migrations
   WHERE version IN (
     '125_organization_link_dispatched_transfers.sql',
     '126_transfer_guard_privileges.sql'
   );
  IF v_applied > 0 THEN
    RAISE NOTICE '125/126 already recorded (% of 2); temporary migrator membership not granted', v_applied;
    RETURN;
  END IF;

  -- 5. Temporary memberships for migration 125.
  --    exchange: needed so migrator may GRANT EXECUTE on app.organization_role(uuid),
  --              which is owned by medveris_exchange. SET FALSE is sufficient for GRANT.
  --    guard:    INHERIT FALSE so migrator does NOT automatically gain BYPASSRLS;
  --              SET TRUE because ALTER ... OWNER TO requires SET ROLE ability.
  --    ADMIN FALSE on both: migrator cannot re-grant either role.
  --    These statements also *downgrade* any pre-existing inherited membership
  --    (staging currently has migrator -> exchange with INHERIT TRUE).
  GRANT medveris_exchange TO medveris_migrator
    WITH ADMIN FALSE, INHERIT FALSE, SET FALSE;
  GRANT medveris_transfer_guard TO medveris_migrator
    WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

  -- 6. Fail closed if the migrator would still inherit a BYPASSRLS role.
  IF pg_has_role('medveris_migrator','medveris_exchange','USAGE')
     OR pg_has_role('medveris_migrator','medveris_transfer_guard','USAGE') THEN
    RAISE EXCEPTION 'medveris_migrator still inherits BYPASSRLS helper membership';
  END IF;

  RAISE NOTICE 'temporary memberships granted: migrator -> exchange (INHERIT FALSE, SET FALSE), migrator -> transfer_guard (INHERIT FALSE, SET TRUE)';
END $$;

-- Evidence snapshot (run manually or keep in output):
--   SELECT rolname, rolsuper, rolcreaterole, rolbypassrls, rolcanlogin
--     FROM pg_roles WHERE rolname IN ('medveris_transfer_guard','medveris_migrator');
--   SELECT m.member::regrole, m.roleid::regrole, m.admin_option, m.inherit_option, m.set_option
--     FROM pg_auth_members m
--    WHERE m.roleid = 'medveris_transfer_guard'::regrole;
