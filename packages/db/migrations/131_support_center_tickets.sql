-- Observability Support Center — incident ticketing + append-only ticket timeline.
-- Additive only. Incidents are platform-level operations records: no patient data,
-- no tenant attribution, no clinical content. Accessible only to platform operators
-- (app.platform_role = 'platform_operator'); close instead of delete.

BEGIN;

CREATE TABLE support_tickets (
  id uuid PRIMARY KEY,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'alert', 'anomaly', 'dead-letter')),
  external_ref text,
  category text NOT NULL CHECK (category IN ('availability', 'integrity', 'confidentiality', 'clinical-sync', 'auth', 'infrastructure', 'other')),
  severity text NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 8 AND 200),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 20 AND 4000),
  resolution text CHECK (resolution IS NULL OR char_length(resolution) BETWEEN 5 AND 4000),
  assignee_user_id uuid REFERENCES users(id),
  opened_by uuid NOT NULL REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  assigned_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_tickets_status_severity_idx ON support_tickets(status, severity, opened_at DESC);
CREATE INDEX support_tickets_assignee_idx ON support_tickets(assignee_user_id) WHERE assignee_user_id IS NOT NULL;

CREATE TABLE support_ticket_events (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('opened', 'acknowledged', 'assigned', 'severity-change', 'note', 'resolved', 'closed')),
  note text CHECK (note IS NULL OR char_length(note) <= 4000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_ticket_events_ticket_idx ON support_ticket_events(ticket_id, created_at);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY support_tickets_operator_all ON support_tickets
  USING (current_setting('app.platform_role', true) = 'platform_operator')
  WITH CHECK (current_setting('app.platform_role', true) = 'platform_operator');

ALTER TABLE support_ticket_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket_events FORCE ROW LEVEL SECURITY;
CREATE POLICY support_ticket_events_operator_all ON support_ticket_events
  USING (current_setting('app.platform_role', true) = 'platform_operator')
  WITH CHECK (current_setting('app.platform_role', true) = 'platform_operator');

GRANT SELECT, INSERT, UPDATE ON support_tickets TO medveris_runtime;
GRANT SELECT, INSERT ON support_ticket_events TO medveris_runtime;

COMMIT;
