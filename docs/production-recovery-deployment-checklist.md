# Production Recovery / Deployment Checklist

**Date:** 2026-11-06
**Purpose:** operational checklist for bringing the fixed branch to
production and re-verifying the two remaining test failures.

## Pre-flight (must be true before deploying)

- [ ] Branch `9ad7a18` merged to `master` and pushed to `origin`.
- [ ] `npm run lint` exits 0.
- [ ] `npm run typecheck` exits 0.
- [ ] Build target succeeds.
- [ ] Migration `packages/db/migrations/050_professional_designations.sql`
      is applied to the **runtime** database (it is a new DDL migration).
- [ ] Test databases are migrated with the full set `001_*` … `050_*`
      (ordering is alphabetical by timestamp prefix; `050` sorts after
      `049`).

## Test re-run after migration

- [ ] `npm test` — target the two failing files and confirm they pass:
      `tests/integration/workflow-payments.test.ts`
      `tests/integration/fhir.test.ts`
  Expected result: `workflow-payments` sign route no longer throws
  `relation "professional_designations" does not exist`.

## Edge cases and sign-offs

- [ ] Re-signing an existing record keeps the original `designation_code`
      from `clinical_entry_versions` (immutable snapshot).
- [ ] Inactive catalogue titles/specialities cannot rewrite historical
      signed documents.
- [ ] Pricing values verified against approved commercial three-tier
      pricing in `035_pricing_subscriptions_usage.sql` before production
      launch.
- [ ] LivePay endpoints verified in **Sandbox/Test mode only**; no real
      payment keys committed or used.

## Rollback

- [ ] Restore `apps/api/src/routes/directory.ts` from the last known-good
      commit (`1556731`).
- [ ] Revert the `completeTriage` body and the `/directory/providers`
      route if behavioral review requires.
- [ ] Confirm lint/typecheck pass and re-run `npm test`.

## Environment setup note

The current CI/CD pipeline applies a fixed migration set to test databases
that does not include `050_professional_designations.sql`. The
deployment checklist item above (full set `001_*`…`050_*`) is the correct
production-equivalent; for tests, either run a schema-rebuild against the
full ordered migration set, or add `050` to the test harness migration
loader. Do not disable the sign-time reference to
`professional_designations` — it is a required invariant.
