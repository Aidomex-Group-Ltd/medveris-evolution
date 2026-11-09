BEGIN;

-- Stage 1 ward foundation: explicit ward on admission + bed reservation + capacity.
ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS ward_id uuid REFERENCES wards(id);

-- Backfill from the current active bed assignment where present.
UPDATE admissions a
   SET ward_id = w.id
  FROM bed_assignments ba
  JOIN beds b ON b.id = ba.bed_id
  JOIN wards w ON w.id = b.ward_id
 WHERE ba.admission_id = a.id
   AND ba.released_at IS NULL
   AND a.ward_id IS NULL;

CREATE INDEX IF NOT EXISTS admissions_ward_status_idx
  ON admissions (tenant_id, ward_id, status, admitted_at);

CREATE INDEX IF NOT EXISTS admissions_ward_type_idx
  ON admissions (tenant_id, ward_type, status);

-- Bed reservation: extend status check (previous list from 011 + reserved).
ALTER TABLE beds DROP CONSTRAINT IF EXISTS beds_status_check;
ALTER TABLE beds ADD CONSTRAINT beds_status_check CHECK (status IN (
  'available','occupied','vacated','awaiting-cleaning','cleaning-in-progress',
  'cleaning','ready','out-of-service','unavailable','reserved'
));

COMMIT;
