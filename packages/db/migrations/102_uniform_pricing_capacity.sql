BEGIN;

-- Uniform platform packages. The only plan-based entitlements are staff seats and storage; every
-- package keeps the same features. The internal code for the public "Professional" package stays
-- "advanced" so existing subscriptions and APIs keep working.
--
-- Allowances live in plan_resource_rules, the same model used for metered usage. The rules for an
-- approved plan version are normally frozen, so this one-time forward backfill temporarily lifts the
-- guard to give the already-approved Basic rules the allowances defined by the platform specification.
-- The migration role owns these tables but row-level security is forced; the operator policies require a
-- signed-in platform operator. Lift RLS only for this controlled backfill transaction.
ALTER TABLE subscription_plans DISABLE ROW LEVEL SECURITY;
ALTER TABLE plan_resource_rules DISABLE ROW LEVEL SECURITY;
ALTER TABLE plan_resource_rules DISABLE TRIGGER plan_resource_rules_guard;

UPDATE plan_resource_rules SET included_quantity = 10
 WHERE plan_id = 'c0000000-0000-4000-8000-000000000002' AND resource = 'users.active';
UPDATE plan_resource_rules SET included_quantity = 10737418240
 WHERE plan_id = 'c0000000-0000-4000-8000-000000000002' AND resource = 'storage.file_bytes';

-- The free trial measures use but does not impose a staff or storage cap; the commercial packages do.
-- Insert the per-seat/per-storage allowances. The freeze guard is re-enabled only below so that the
-- allowance backfill can write to approved tiers; 104_clinical_bmi_and_labour_alerts.sql and later
-- migrations rely on the guard being active to protect later rule mutations.
INSERT INTO plan_resource_rules (plan_id, resource, treatment, included_quantity)
SELECT p.id, r.code, 'included',
       CASE
         WHEN p.code = 'standard' AND r.code = 'users.active' THEN 50
         WHEN p.code = 'standard' AND r.code = 'storage.file_bytes' THEN 53687091200
         WHEN p.code = 'advanced' AND r.code = 'users.active' THEN 250
         WHEN p.code = 'advanced' AND r.code = 'storage.file_bytes' THEN 214748364800
         ELSE NULL
       END
  FROM subscription_plans p CROSS JOIN usage_resources r
 WHERE p.code IN ('standard', 'advanced', 'enterprise')
ON CONFLICT (plan_id, resource) DO NOTHING;

ALTER TABLE plan_resource_rules ENABLE TRIGGER plan_resource_rules_guard;

-- Standard and Professional are now approved commercial packages with the published prices.
UPDATE subscription_plans
   SET status = 'approved', monthly_price_minor = 3000, approval_reference = 'Medveris uniform platform specification 2026: Standard USD 30/month, 50 staff, 50 GB',
       approved_at = now(), effective_from = now()
 WHERE code = 'standard' AND status = 'draft';

UPDATE subscription_plans
   SET name = 'Professional', status = 'approved', monthly_price_minor = 10000,
       approval_reference = 'Medveris uniform platform specification 2026: Professional USD 100/month, 250 staff, 200 GB',
       approved_at = now(), effective_from = now()
 WHERE code = 'advanced' AND status = 'draft';

-- Enterprise remains a configurable contract package; its allowances are set per account.
UPDATE subscription_plans SET name = 'Enterprise', contract_required = true WHERE code = 'enterprise';

ALTER TABLE plan_resource_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;

COMMIT;
