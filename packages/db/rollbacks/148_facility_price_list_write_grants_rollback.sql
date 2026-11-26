-- Rollback for migration 148: removes the facility price-list write grants and the
-- price-history INSERT policy. Facility price-list writes fail afterwards, so roll the Worker
-- back first (or accept that price administration is unavailable).

BEGIN;

DROP POLICY IF EXISTS price_history_insert ON public.price_history;

REVOKE INSERT, UPDATE ON public.price_list_prices FROM medveris_runtime;
REVOKE INSERT, UPDATE ON public.price_lists FROM medveris_runtime;
REVOKE INSERT ON public.price_history FROM medveris_runtime;

COMMIT;
