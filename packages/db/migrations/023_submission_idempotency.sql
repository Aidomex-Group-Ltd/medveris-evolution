-- Duplicate-submission protection for encounter creation and dispensing.
--
-- A retried or double-clicked request that carries the same Idempotency-Key
-- resolves to the original encounter or dispense instead of creating another.
-- An appointment or queue entry can have at most one open encounter, so two
-- concurrent check-ins cannot both succeed. Additive only.

BEGIN;

-- Existing duplicates are clinical records and are never rewritten here. If any
-- exist, creating the unique indexes fails ("Duplicate keys exist") and the whole
-- migration rolls back; an operator must mark the extra encounters
-- entered-in-error first. (A pre-check query cannot do this: forced RLS hides
-- encounters from the migrator role, while index builds see every row.)

ALTER TABLE encounters ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX encounters_idempotency ON encounters(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX encounters_open_appointment ON encounters(appointment_id)
  WHERE appointment_id IS NOT NULL AND state NOT IN ('cancelled', 'entered-in-error');
CREATE UNIQUE INDEX encounters_open_queue_entry ON encounters(queue_entry_id)
  WHERE queue_entry_id IS NOT NULL AND state NOT IN ('cancelled', 'entered-in-error');

ALTER TABLE dispenses ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX dispenses_idempotency ON dispenses(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;
