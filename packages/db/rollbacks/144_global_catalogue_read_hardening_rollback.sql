-- Rollback for migration 144: restores dead-branch read policies.
-- WARNING: authenticated users regain read access to inactive master prices and sponsorship packages.

BEGIN;

DROP POLICY IF EXISTS reference_specialties_read ON public.reference_specialties;
CREATE POLICY reference_specialties_read ON public.reference_specialties
FOR SELECT TO public
USING (active OR true);

DROP POLICY IF EXISTS master_prices_read ON public.master_prices;
CREATE POLICY master_prices_read ON public.master_prices
FOR SELECT TO public
USING (active = true OR app.current_user() IS NOT NULL);

DROP POLICY IF EXISTS sponsored_packages_read ON public.sponsored_packages;
CREATE POLICY sponsored_packages_read ON public.sponsored_packages
FOR SELECT TO public
USING (active OR app.is_platform_operator() OR app.current_user() IS NOT NULL);

COMMIT;
