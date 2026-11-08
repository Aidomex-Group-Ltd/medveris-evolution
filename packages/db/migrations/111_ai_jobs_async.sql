BEGIN;

-- AI inference runs off the request path in the jobs runner. The jobs role may claim a queued job
-- and mark it running/completed/failed; it may not read patient-linked rows outside this table or
-- change any other column's meaning. The API performs enqueueing and human-facing reads.
GRANT SELECT, UPDATE ON ai_jobs TO medveris_jobs;

CREATE POLICY ai_jobs_system_read ON ai_jobs FOR SELECT
  USING (app.actor_kind() = 'system');
CREATE POLICY ai_jobs_system_update ON ai_jobs FOR UPDATE
  USING (app.actor_kind() = 'system') WITH CHECK (app.actor_kind() = 'system');

COMMIT;
