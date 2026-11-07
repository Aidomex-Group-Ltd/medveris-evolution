-- Align Standard and Professional package allowances with the uniform platform
-- specification on environments where 035 already inserted the standard/advanced
-- plan_resource_rules rows with NULL included_quantity: 102's
-- ON CONFLICT (plan_id, resource) DO NOTHING then skips them, leaving the staff
-- and storage limits unlimited (capacity.ts treats a NULL limit as unenforced).
-- Production, which ran the original 035 without those rows, receives its
-- quantities from 102 itself and is untouched here. Idempotent: only fills rows
-- that are still NULL, after 102 has run (lexical order guarantees 102 < 106).

BEGIN;

ALTER TABLE subscription_plans DISABLE ROW LEVEL SECURITY;
ALTER TABLE plan_resource_rules DISABLE ROW LEVEL SECURITY;
ALTER TABLE plan_resource_rules DISABLE TRIGGER plan_resource_rules_guard;

UPDATE plan_resource_rules r
   SET included_quantity = CASE r.resource
         WHEN 'users.active' THEN CASE p.code WHEN 'standard' THEN 50 WHEN 'advanced' THEN 250 END
         WHEN 'storage.file_bytes' THEN CASE p.code WHEN 'standard' THEN 53687091200 WHEN 'advanced' THEN 214748364800 END
       END
  FROM subscription_plans p
 WHERE r.plan_id = p.id
   AND p.code IN ('standard', 'advanced')
   AND r.resource IN ('users.active', 'storage.file_bytes')
   AND r.treatment = 'included'
   AND r.included_quantity IS NULL;

ALTER TABLE plan_resource_rules ENABLE TRIGGER plan_resource_rules_guard;
ALTER TABLE plan_resource_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;

COMMIT;
