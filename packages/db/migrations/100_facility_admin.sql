-- Fix app.is_facility_admin(): a facility administrator is an active staff member whose
-- current tenant has claimed, active, published directory facility. The previous helper
-- compared the directory facility id to the tenant id, so it never matched real facilities.
--
-- The role check is explicit here because this helper gates the facility logo policies;
-- merely belonging to a tenant that claimed a facility must not grant logo management.

BEGIN;

CREATE OR REPLACE FUNCTION app.is_facility_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.current_user() IS NOT NULL
     AND app.has_any_role(ARRAY['facility_admin'])
     AND EXISTS (
       SELECT 1
       FROM directory_facilities f
       JOIN tenants t ON t.id = f.claimed_tenant_id
       WHERE t.id = app.current_tenant()
         AND f.status = 'active'
         AND f.publication_status = 'published'
     );
$$;

ALTER FUNCTION app.is_facility_admin() OWNER TO medveris_exchange;

REVOKE ALL ON FUNCTION app.is_facility_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_facility_admin() TO medveris_runtime, medveris_jobs;

COMMIT;
