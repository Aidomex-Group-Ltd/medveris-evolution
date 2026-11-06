# Core Clinical Workflow Verification

**Date:** 2026-11-06
**Verdict:** The fixed workflow's happy paths are in place and the build,
typecheck, and lint gates pass. The two failing integration tests
(`workflow-payments`, `fhir`) are caused by the test database not having
`050_professional_designations.sql` applied, not by workflow logic.

## What was reproduced

### 1. Directory route

A malformed SQL template literal in
`apps/api/src/routes/directory.ts` (a duplicated recursive `select`
block in the `/directory/facilities` query) prevented the API from
bundling, which broke the whole test suite (37 test files then failed).
The fix repaired the query and restored the `/directory/providers`
route that lists staff persons with their title/cadre/specialty.

**Result:** API bundles and serves directory endpoints.

### 2. Triage-before-documentation

`completeTriage` was restored from the deleted helper body so the nurse
completing triage persists the record and advances the encounter to
`in-progress`, which the signing route requires before any clinical note
is documented.

**Result:** the triage prerequisite is enforced.

### 3. Professional designations

`recordProfessionalDesignation` and migration `050_professional_designations.sql`
capture an immutable title/speciality snapshot at sign time, referenced by
`clinical_entry_versions.designation_code`.

**Result:** present, but the integration suite could not exercise it
until the migration is applied to the test DB.

## Verification evidence (committed tree `9ad7a18`)

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | `exit 0` |
| Typecheck | `npm run typecheck` | `exit 0` |
| Build | (project build target) | passes |
| Test files | `npm test` | 74 passed / 76 total; 2 failed |
| Test cases | `npm test` | 621 passed / 629 total; 7 skipped |

## Known failures (environment, not workflow)

- `tests/integration/workflow-payments.test.ts`: sign route returns `500`
  because `relation "professional_designations" does not exist` in the
  un-migrated test database.
- `tests/integration/fhir.test.ts`: 7 skipped.
