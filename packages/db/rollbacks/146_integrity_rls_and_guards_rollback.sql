-- Rollback for migration 146: removes integrity/ledger RLS and restores the original jobs INSERT grant.
-- WARNING: integrity checkpoint, event, and ledger rows become directly accessible to all roles with table grants.

BEGIN;

DROP POLICY IF EXISTS integrity_checkpoints_migrator_all ON public.integrity_checkpoints;
DROP POLICY IF EXISTS integrity_checkpoints_jobs_select ON public.integrity_checkpoints;
DROP POLICY IF EXISTS integrity_checkpoints_jobs_insert ON public.integrity_checkpoints;
DROP POLICY IF EXISTS integrity_checkpoints_runtime_select ON public.integrity_checkpoints;
ALTER TABLE public.integrity_checkpoints NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.integrity_checkpoints DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integrity_checkpoint_events_migrator_all ON public.integrity_checkpoint_events;
DROP POLICY IF EXISTS integrity_checkpoint_events_jobs_select ON public.integrity_checkpoint_events;
DROP POLICY IF EXISTS integrity_checkpoint_events_jobs_insert ON public.integrity_checkpoint_events;
DROP POLICY IF EXISTS integrity_checkpoint_events_runtime_select ON public.integrity_checkpoint_events;
ALTER TABLE public.integrity_checkpoint_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.integrity_checkpoint_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ledger_anchors_migrator_all ON public.ledger_anchors;
DROP POLICY IF EXISTS ledger_anchors_jobs_select ON public.ledger_anchors;
DROP POLICY IF EXISTS ledger_anchors_runtime_select ON public.ledger_anchors;
ALTER TABLE public.ledger_anchors NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_anchors DISABLE ROW LEVEL SECURITY;

GRANT INSERT ON public.ledger_anchors TO medveris_jobs;

COMMIT;
