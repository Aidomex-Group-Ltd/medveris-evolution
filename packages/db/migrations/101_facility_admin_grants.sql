-- app.is_facility_admin() is SECURITY DEFINER owned by medveris_exchange, so the owner
-- needs read access to the directory tables it inspects.

BEGIN;

GRANT SELECT ON directory_facilities, tenants TO medveris_exchange;

COMMIT;
