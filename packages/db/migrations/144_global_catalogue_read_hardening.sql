-- RLS hardening migration 144: remove dead authenticated-user branches from global catalogue reads.
-- Active rows remain readable; inactive master prices and sponsorship packages are limited to platform operators.

BEGIN;

DROP POLICY IF EXISTS reference_specialties_read ON public.reference_specialties;
CREATE POLICY reference_specialties_read ON public.reference_specialties
FOR SELECT TO public
USING (true);

DROP POLICY IF EXISTS master_prices_read ON public.master_prices;
CREATE POLICY master_prices_read ON public.master_prices
FOR SELECT TO public
USING (active = true OR app.is_platform_operator());

DROP POLICY IF EXISTS sponsored_packages_read ON public.sponsored_packages;
CREATE POLICY sponsored_packages_read ON public.sponsored_packages
FOR SELECT TO public
USING (active = true OR app.is_platform_operator());

COMMIT;
