-- Least-privilege dispatched-transfer check for organization link transitions.
-- Avoids impersonating a facility role in app context by exposing only an existence/count
-- result for the specified organization/link pair.
CREATE OR REPLACE FUNCTION app.organization_link_dispatched_transfers(p_org uuid, p_link uuid)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid;
  v_count integer;
BEGIN
  IF app.organization_role(p_org) IS NULL THEN
    RAISE EXCEPTION 'organization access denied' USING ERRCODE = '42501';
  END IF;
  SELECT l.tenant_id INTO v_tenant
    FROM organization_links l
   WHERE l.id = p_link AND l.organization_id = p_org;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'organization link not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT count(*)::int INTO v_count
    FROM organization_stock_transfers t
   WHERE t.organization_id = p_org
     AND t.status = 'dispatched'
     AND (t.source_tenant_id = v_tenant OR t.destination_tenant_id = v_tenant);
  RETURN COALESCE(v_count, 0);
END;
$$;

-- Owner requires schema privileges for local/managed provisioning; migrator owns schema and can grant.
GRANT USAGE, CREATE ON SCHEMA app TO medveris_transfer_guard;
GRANT EXECUTE ON FUNCTION app.organization_role(uuid) TO medveris_transfer_guard;
ALTER FUNCTION app.organization_link_dispatched_transfers(uuid, uuid) OWNER TO medveris_transfer_guard;
REVOKE ALL ON FUNCTION app.organization_link_dispatched_transfers(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.organization_link_dispatched_transfers(uuid, uuid) TO medveris_runtime;
