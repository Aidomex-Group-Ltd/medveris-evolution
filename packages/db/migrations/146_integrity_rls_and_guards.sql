-- RLS hardening migration 146: protect integrity/ledger tables and assert RLS role invariants.
-- Jobs keep role-scoped access; runtime reads only rows joined to its active tenant; the documented no-RLS allowlist shrinks accordingly.

BEGIN;

ALTER TABLE public.integrity_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrity_checkpoints FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integrity_checkpoints_migrator_all ON public.integrity_checkpoints;
CREATE POLICY integrity_checkpoints_migrator_all ON public.integrity_checkpoints
FOR ALL TO medveris_migrator
USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS integrity_checkpoints_jobs_select ON public.integrity_checkpoints;
CREATE POLICY integrity_checkpoints_jobs_select ON public.integrity_checkpoints
FOR SELECT TO medveris_jobs
USING (true);

DROP POLICY IF EXISTS integrity_checkpoints_jobs_insert ON public.integrity_checkpoints;
CREATE POLICY integrity_checkpoints_jobs_insert ON public.integrity_checkpoints
FOR INSERT TO medveris_jobs
WITH CHECK (true);

DROP POLICY IF EXISTS integrity_checkpoints_runtime_select ON public.integrity_checkpoints;
CREATE POLICY integrity_checkpoints_runtime_select ON public.integrity_checkpoints
FOR SELECT TO medveris_runtime
USING (tenant_id = app.current_tenant());

ALTER TABLE public.integrity_checkpoint_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrity_checkpoint_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integrity_checkpoint_events_migrator_all ON public.integrity_checkpoint_events;
CREATE POLICY integrity_checkpoint_events_migrator_all ON public.integrity_checkpoint_events
FOR ALL TO medveris_migrator
USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS integrity_checkpoint_events_jobs_select ON public.integrity_checkpoint_events;
CREATE POLICY integrity_checkpoint_events_jobs_select ON public.integrity_checkpoint_events
FOR SELECT TO medveris_jobs
USING (true);

DROP POLICY IF EXISTS integrity_checkpoint_events_jobs_insert ON public.integrity_checkpoint_events;
CREATE POLICY integrity_checkpoint_events_jobs_insert ON public.integrity_checkpoint_events
FOR INSERT TO medveris_jobs
WITH CHECK (true);

DROP POLICY IF EXISTS integrity_checkpoint_events_runtime_select ON public.integrity_checkpoint_events;
CREATE POLICY integrity_checkpoint_events_runtime_select ON public.integrity_checkpoint_events
FOR SELECT TO medveris_runtime
USING (
  EXISTS (
    SELECT 1
    FROM public.integrity_checkpoints k
    WHERE k.id = integrity_checkpoint_events.checkpoint_id
      AND k.tenant_id = app.current_tenant()
  )
);

ALTER TABLE public.ledger_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_anchors FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ledger_anchors_migrator_all ON public.ledger_anchors;
CREATE POLICY ledger_anchors_migrator_all ON public.ledger_anchors
FOR ALL TO medveris_migrator
USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ledger_anchors_jobs_select ON public.ledger_anchors;
CREATE POLICY ledger_anchors_jobs_select ON public.ledger_anchors
FOR SELECT TO medveris_jobs
USING (true);

DROP POLICY IF EXISTS ledger_anchors_runtime_select ON public.ledger_anchors;
CREATE POLICY ledger_anchors_runtime_select ON public.ledger_anchors
FOR SELECT TO medveris_runtime
USING (
  EXISTS (
    SELECT 1
    FROM public.integrity_checkpoints k
    WHERE k.id = ledger_anchors.checkpoint_id
      AND k.tenant_id = app.current_tenant()
  )
);

REVOKE INSERT ON public.ledger_anchors FROM medveris_jobs;

DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT count(*) INTO bad_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relrowsecurity
    AND NOT c.relforcerowsecurity;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'RLS not forced on % public tables', bad_count;
  END IF;

  SELECT count(*) INTO bad_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relrowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'RLS enabled without policies on % public tables', bad_count;
  END IF;

  SELECT count(*) INTO bad_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND NOT c.relrowsecurity
    AND c.relname <> ALL (ARRAY[
      'auth_challenges', 'email_tokens', 'sessions', 'users', 'tenants', 'schema_migrations', 'usage_resources'
    ]);
  IF bad_count > 0 THEN
    RAISE EXCEPTION '% public tables have RLS disabled outside the reviewed allowlist', bad_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'medveris_app'
      AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'medveris_app must not have SUPERUSER or BYPASSRLS';
  END IF;

  SELECT count(*) INTO bad_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND r.rolname = 'medveris_app';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'medveris_app owns % relations in public', bad_count;
  END IF;
END
$$;

COMMIT;
