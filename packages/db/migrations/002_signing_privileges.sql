-- Signing a draft is a narrow, trigger-guarded transition (draft -> signed).
-- The runtime role needs UPDATE for that transition only; the immutability
-- trigger still rejects every other mutation and DELETE remains revoked.
GRANT UPDATE ON clinical_entry_versions TO medveris_runtime;
GRANT UPDATE ON clinical_entries TO medveris_runtime;

-- Attach a signature to entered-in-error versions too. Existing rows are
-- retained; the column was already nullable.
COMMENT ON COLUMN clinical_entry_versions.signature IS
  'HMAC over canonical version metadata; required for signed, amended and entered-in-error versions';
