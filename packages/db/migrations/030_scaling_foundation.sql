-- Scaling foundation: a tenant shard directory and queue delivery state for the outbox.
--
-- The directory maps each tenant to the shard holding its data. Today every tenant is on the
-- single shard `primary`; the table exists so shard placement is explicit, versioned and
-- audited before any physical split. Only the migration role changes assignments, and every
-- insert or change is recorded in tenant_shard_assignment_history by trigger.
--
-- Outbox rows gain a `queued` state for relay to Cloudflare Queues, a claim time so rows left
-- `processing` by a crashed run can be reclaimed, and an operator replay record. Additive: a
-- build without queue relay keeps working against the migrated schema.

BEGIN;

CREATE TABLE tenant_shard_assignments (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  shard_id text NOT NULL DEFAULT 'primary' CHECK (shard_id ~ '^[a-z][a-z0-9-]{0,30}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'frozen', 'migrating')),
  routing_version integer NOT NULL DEFAULT 1 CHECK (routing_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL DEFAULT 'initial-assignment' CHECK (length(reason) BETWEEN 3 AND 500)
);

CREATE TABLE tenant_shard_assignment_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  from_shard text,
  to_shard text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  routing_version integer NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text NOT NULL,
  reason text NOT NULL
);
CREATE INDEX tenant_shard_history_tenant_idx ON tenant_shard_assignment_history(tenant_id, changed_at);

-- Every change bumps routing_version, so a router holding an older assignment can detect it.
CREATE FUNCTION app.record_shard_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id <> OLD.tenant_id THEN
      RAISE EXCEPTION 'tenant_id of a shard assignment cannot change';
    END IF;
    IF NEW.shard_id = OLD.shard_id AND NEW.state = OLD.state THEN
      RETURN NEW;
    END IF;
    NEW.routing_version := OLD.routing_version + 1;
    NEW.updated_at := now();
  END IF;
  INSERT INTO tenant_shard_assignment_history (tenant_id, from_shard, to_shard, from_state, to_state, routing_version, changed_by, reason)
  VALUES (NEW.tenant_id,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.shard_id END, NEW.shard_id,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.state END, NEW.state,
          NEW.routing_version, session_user, NEW.reason);
  RETURN NEW;
END $$;

CREATE TRIGGER tenant_shard_assignment_history
  BEFORE INSERT OR UPDATE ON tenant_shard_assignments
  FOR EACH ROW EXECUTE FUNCTION app.record_shard_assignment();

CREATE FUNCTION app.reject_shard_assignment_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shard assignments are never deleted; move or freeze the tenant instead';
END $$;

CREATE TRIGGER tenant_shard_assignment_no_delete
  BEFORE DELETE ON tenant_shard_assignments
  FOR EACH ROW EXECUTE FUNCTION app.reject_shard_assignment_delete();

-- New facilities are placed on the single shard. With several shards, placement becomes an
-- operator decision recorded through the same table before the facility is activated.
CREATE FUNCTION app.assign_new_tenant_shard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO tenant_shard_assignments (tenant_id, reason) VALUES (NEW.id, 'new-tenant-default-shard')
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assign_new_tenant_shard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_shard_assignment() FROM PUBLIC;

CREATE TRIGGER tenants_assign_shard
  AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.assign_new_tenant_shard();

ALTER TABLE tenant_shard_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_shard_assignments FORCE ROW LEVEL SECURITY;
-- Routing metadata holds no personal data; the runtime needs it for every facility request.
CREATE POLICY shard_assignment_read ON tenant_shard_assignments FOR SELECT TO medveris_runtime, medveris_jobs USING (true);
CREATE POLICY shard_assignment_admin ON tenant_shard_assignments TO medveris_migrator USING (true) WITH CHECK (true);

ALTER TABLE tenant_shard_assignment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_shard_assignment_history FORCE ROW LEVEL SECURITY;
CREATE POLICY shard_history_admin_read ON tenant_shard_assignment_history FOR SELECT TO medveris_migrator USING (true);
CREATE POLICY shard_history_admin_insert ON tenant_shard_assignment_history FOR INSERT TO medveris_migrator WITH CHECK (true);

GRANT SELECT ON tenant_shard_assignments TO medveris_runtime, medveris_jobs;

INSERT INTO tenant_shard_assignments (tenant_id, reason)
SELECT id, 'initial-assignment' FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- Outbox delivery through a queue.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
     WHERE contype = 'c' AND conrelid = 'outbox_events'::regclass
       AND pg_get_constraintdef(oid) LIKE '%dead-letter%'
  LOOP
    EXECUTE format('ALTER TABLE outbox_events DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_status_check CHECK (status IN ('pending', 'processing', 'queued', 'processed', 'dead-letter')),
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN queued_at timestamptz,
  ADD COLUMN publish_count integer NOT NULL DEFAULT 0;

CREATE INDEX outbox_inflight_idx ON outbox_events(status, claimed_at) WHERE status IN ('processing', 'queued');

CREATE TABLE outbox_replays (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES outbox_events(id),
  replayed_at timestamptz NOT NULL DEFAULT now(),
  operator text NOT NULL CHECK (length(operator) BETWEEN 2 AND 120),
  reason text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  previous_status text NOT NULL,
  previous_attempts integer NOT NULL,
  previous_error text
);
CREATE INDEX outbox_replays_event_idx ON outbox_replays(event_id);

ALTER TABLE outbox_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_replays FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_replays_jobs ON outbox_replays TO medveris_jobs USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON outbox_replays TO medveris_jobs;

-- Aggregate backlog for platform operators: counts and ages only, no tenant or event detail.
CREATE FUNCTION app.outbox_backlog()
RETURNS TABLE (status text, events bigint, oldest_seconds double precision, max_attempts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.status, count(*), extract(epoch FROM now() - min(o.occurred_at)), max(o.attempt_count)
    FROM outbox_events o
   WHERE o.status <> 'processed'
     AND current_setting('app.platform_role', true) = 'platform_operator'
   GROUP BY o.status
$$;
GRANT SELECT ON outbox_events TO medveris_exchange;
ALTER FUNCTION app.outbox_backlog() OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.outbox_backlog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_backlog() TO medveris_runtime;

COMMIT;
