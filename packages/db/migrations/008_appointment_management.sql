-- Appointment rescheduling and local status tracking. Arrival and completion
-- remain driven by the encounter workflow.

BEGIN;

ALTER TABLE appointments
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN status_note text,
  ADD COLUMN updated_by uuid REFERENCES users(id);

CREATE INDEX appointments_tenant_status_start_idx ON appointments(tenant_id, status, start_at);

COMMIT;
