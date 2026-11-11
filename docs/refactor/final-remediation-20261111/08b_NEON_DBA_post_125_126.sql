-- 08b — Neon DBA POST-verification and membership revocation for migrations 125/126
--
-- Run against `medveris_staging` as the same Neon admin role used for 08a, AFTER
-- the approved migration runner has applied 125/126 successfully.
--
-- This script removes the temporary migrator membership and fails closed if the
-- resulting security posture does not match production / migration 126.
-- It does not modify application data.

DO $$
DECLARE
  v_db              text := current_database();
  v_func            oid;
  v_owner           text;
  v_secdef          boolean;
  v_acl             text;
  v_public_exec     boolean;
  v_runtime_exec    boolean;
  v_guard_exec      boolean;
  v_mig_exec        boolean;
  v_guard_role_exec boolean;
  v_mig_member      boolean;
  v_mig_usage       boolean;
  v_applied         int;
  v_total           int;
  v_table_owner     text;
  v_rls_ok          boolean;
  v_guard_attr_ok   boolean;
  v_bad_cols        int;
BEGIN
  IF v_db NOT IN ('medveris_staging', 'medveris-prod') THEN
    RAISE EXCEPTION 'Refusing to verify unexpected database %', v_db;
  END IF;

  -- 1. Remove the temporary escalation window first, even if later checks fail.
  --    Staging had a pre-existing migrator -> exchange membership with INHERIT TRUE;
  --    production has no such membership. Revoke both to match production.
  REVOKE medveris_transfer_guard FROM medveris_migrator;
  REVOKE medveris_exchange FROM medveris_migrator;
  RAISE NOTICE 'revoked temporary memberships: migrator -> transfer_guard, migrator -> exchange';

  -- 2. Guard role attributes must match the approved posture.
  SELECT (NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND rolbypassrls)
    INTO v_guard_attr_ok
    FROM pg_roles WHERE rolname = 'medveris_transfer_guard';
  IF NOT COALESCE(v_guard_attr_ok,false) THEN
    RAISE EXCEPTION 'medveris_transfer_guard attributes are not (NOLOGIN,NOSUPERUSER,NOCREATEDB,NOCREATEROLE,BYPASSRLS)';
  END IF;

  -- 3. Migrator must no longer be a member and must not inherit/bypass.
  SELECT EXISTS (
    SELECT 1 FROM pg_auth_members m
     WHERE m.member = 'medveris_migrator'::regrole
       AND m.roleid = 'medveris_transfer_guard'::regrole
  ) INTO v_mig_member;
  IF v_mig_member THEN
    RAISE EXCEPTION 'medveris_migrator is still a member of medveris_transfer_guard';
  END IF;
  SELECT pg_has_role('medveris_migrator','medveris_transfer_guard','USAGE') INTO v_mig_usage;
  IF v_mig_usage THEN
    RAISE EXCEPTION 'medveris_migrator still inherits (USAGE) medveris_transfer_guard';
  END IF;
  IF pg_has_role('medveris_migrator','medveris_exchange','USAGE') THEN
    RAISE EXCEPTION 'medveris_migrator still inherits (USAGE) medveris_exchange (BYPASSRLS drift)';
  END IF;

  -- 4. Function must exist, be SECURITY DEFINER, and be owned by the guard.
  SELECT p.oid, pg_get_userbyid(p.proowner), p.prosecdef, p.proacl::text
    INTO v_func, v_owner, v_secdef, v_acl
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app'
     AND p.proname = 'organization_link_dispatched_transfers'
     AND pg_get_function_identity_arguments(p.oid) = 'p_org uuid, p_link uuid';
  IF v_func IS NULL THEN
    RAISE EXCEPTION 'app.organization_link_dispatched_transfers(uuid,uuid) is missing';
  END IF;
  IF v_owner <> 'medveris_transfer_guard' OR NOT v_secdef THEN
    RAISE EXCEPTION 'helper owner/security mismatch: owner=%, secdef=%', v_owner, v_secdef;
  END IF;

  -- 5. EXECUTE surface: guard + runtime only, never PUBLIC, never migrator.
  SELECT has_function_privilege('medveris_runtime', v_func, 'EXECUTE') INTO v_runtime_exec;
  SELECT has_function_privilege('medveris_transfer_guard', v_func, 'EXECUTE') INTO v_guard_exec;
  SELECT has_function_privilege('medveris_migrator', v_func, 'EXECUTE') INTO v_mig_exec;
  SELECT EXISTS (
    SELECT 1 FROM aclexplode(COALESCE((SELECT proacl FROM pg_proc WHERE oid = v_func), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_func)))) a
     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) INTO v_public_exec;
  IF NOT v_runtime_exec OR NOT v_guard_exec OR v_mig_exec OR v_public_exec THEN
    RAISE EXCEPTION
      'helper EXECUTE posture wrong: runtime=%, guard=%, migrator=%, public=%',
      v_runtime_exec, v_guard_exec, v_mig_exec, v_public_exec;
  END IF;

  SELECT has_function_privilege('medveris_transfer_guard','app.organization_role(uuid)','EXECUTE')
    INTO v_guard_role_exec;
  IF NOT v_guard_role_exec THEN
    RAISE EXCEPTION 'medveris_transfer_guard lacks EXECUTE on app.organization_role(uuid)';
  END IF;

  -- 6. Column-level reads must be present and table-level SELECT must not be.
  SELECT count(*) INTO v_bad_cols
    FROM (VALUES
      ('organization_stock_transfers','id'),
      ('organization_stock_transfers','organization_id'),
      ('organization_stock_transfers','status'),
      ('organization_stock_transfers','source_tenant_id'),
      ('organization_stock_transfers','destination_tenant_id'),
      ('organization_links','id'),
      ('organization_links','organization_id'),
      ('organization_links','tenant_id')
    ) AS need(tbl, col)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.column_privileges cp
      WHERE cp.table_schema = 'public'
        AND cp.table_name = need.tbl
        AND cp.column_name = need.col
        AND cp.grantee = 'medveris_transfer_guard'
        AND cp.privilege_type = 'SELECT'
   );
  IF v_bad_cols > 0 THEN
    RAISE EXCEPTION '% required guard column grant(s) are missing', v_bad_cols;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges tp
     WHERE tp.table_schema = 'public'
       AND tp.table_name IN ('organization_stock_transfers','organization_links')
       AND tp.grantee = 'medveris_transfer_guard'
       AND tp.privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'medveris_transfer_guard must not hold table-level SELECT (column grants only)';
  END IF;

  -- 7. Underlying tables must remain RLS-forced and migrator-owned.
  SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity) INTO v_rls_ok
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('organization_stock_transfers','organization_links');
  IF NOT COALESCE(v_rls_ok,false) THEN
    RAISE EXCEPTION 'RLS is not enabled+forced on organization_stock_transfers/organization_links';
  END IF;

  -- 8. Migration ledger must record 125/126 and be at the expected parity.
  SELECT count(*) INTO v_applied
    FROM schema_migrations
   WHERE version IN (
     '125_organization_link_dispatched_transfers.sql',
     '126_transfer_guard_privileges.sql'
   );
  IF v_applied <> 2 THEN
    RAISE EXCEPTION 'expected 125 and 126 recorded, found % of 2', v_applied;
  END IF;
  SELECT count(*) INTO v_total FROM schema_migrations;
  RAISE NOTICE 'schema_migrations count = % (expected 77 on staging after this rollout)', v_total;

  RAISE NOTICE 'POST verification passed: guard owned/least-privilege, runtime-only EXECUTE, no migrator membership';
END $$;

-- Evidence snapshot for the change record:
--   SELECT version FROM schema_migrations WHERE version LIKE '12%' ORDER BY version;
--   SELECT p.oid::regprocedure::text, pg_get_userbyid(p.proowner) AS owner, p.proacl::text
--     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--    WHERE n.nspname='app' AND p.proname='organization_link_dispatched_transfers';
--   SELECT m.member::regrole, m.roleid::regrole, m.admin_option, m.inherit_option, m.set_option
--     FROM pg_auth_members m WHERE m.roleid = 'medveris_transfer_guard'::regrole;
