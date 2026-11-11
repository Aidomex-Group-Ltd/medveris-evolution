-- Reconcile privileges for the dedicated dispatched-transfer guard owner.
-- Ownership transfer and function EXECUTE grants are DBA prerequisites because the
-- migration role cannot alter privileges on a function it does not own.
DO $$
DECLARE
  v_func oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medveris_transfer_guard') THEN
    RAISE EXCEPTION 'medveris_transfer_guard role is missing (DBA provisioning required)';
  END IF;

  SELECT p.oid INTO v_func
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app'
     AND p.proname = 'organization_link_dispatched_transfers'
     AND pg_get_function_identity_arguments(p.oid) = 'p_org uuid, p_link uuid';

  IF v_func IS NULL THEN
    RAISE EXCEPTION 'app.organization_link_dispatched_transfers(uuid, uuid) is missing';
  END IF;

  IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = v_func)) <> 'medveris_transfer_guard' THEN
    RAISE EXCEPTION 'app.organization_link_dispatched_transfers(uuid, uuid) must be owned by medveris_transfer_guard (DBA ownership transfer required)';
  END IF;

  IF NOT has_function_privilege('medveris_transfer_guard', v_func, 'EXECUTE') THEN
    RAISE EXCEPTION 'medveris_transfer_guard must have EXECUTE on app.organization_link_dispatched_transfers(uuid, uuid) (DBA grant required)';
  END IF;
  IF NOT has_function_privilege('medveris_runtime', v_func, 'EXECUTE') THEN
    RAISE EXCEPTION 'medveris_runtime must have EXECUTE on app.organization_link_dispatched_transfers(uuid, uuid) (DBA grant required)';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM information_schema.routine_privileges rp
     WHERE rp.routine_schema = 'app'
       AND rp.routine_name = 'organization_link_dispatched_transfers'
       AND rp.grantee = 'PUBLIC'
       AND rp.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC must not have EXECUTE on app.organization_link_dispatched_transfers(uuid, uuid) (DBA revoke required)';
  END IF;

  IF NOT has_function_privilege('medveris_transfer_guard', 'app.organization_role(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'medveris_transfer_guard must have EXECUTE on app.organization_role(uuid) (DBA grant required)';
  END IF;
END $$;

-- Minimal schema usage for the dedicated helper owner.
GRANT USAGE ON SCHEMA public TO medveris_transfer_guard;
GRANT USAGE ON SCHEMA app TO medveris_transfer_guard;

-- Narrow column-level read required for dispatched-transfer existence/count checks.
REVOKE ALL ON TABLE public.organization_stock_transfers FROM medveris_transfer_guard;
GRANT SELECT (
  id,
  organization_id,
  status,
  source_tenant_id,
  destination_tenant_id
) ON public.organization_stock_transfers TO medveris_transfer_guard;

-- Narrow column-level read required to resolve the link's tenant within the same helper.
REVOKE ALL ON TABLE public.organization_links FROM medveris_transfer_guard;
GRANT SELECT (
  id,
  organization_id,
  tenant_id
) ON public.organization_links TO medveris_transfer_guard;
