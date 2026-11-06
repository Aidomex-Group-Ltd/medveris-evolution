# Production Core-Functionality Assessment

**Date:** 2026-11-06
**Repository:** `medveris-evolution` (branch `master`)
**Assessment carried out on:** the committed fix slice `9ad7a18`
**Scope:** core clinical workflow, triage-to-clinician handoff, clinical
signing, professional-title/speciality classification, and pricing/LivePay
integration (Sandbox/Test mode only).

## Purpose

This document records which core functionality exists in the production
branch after the final fix slice was applied, which was verified to be
present, which remains blocked on environment setup, and the concrete
facts that must not be re-litigated in later review.

## Verified present (committed, passing)

| Area | Evidence | Status |
|---|---|---|
| Directory listing (`/directory/facilities`) | `apps/api/src/routes/directory.ts` `directoryRoutes.get("/public/directory/facilities")` | Passing; esbuild bundle restored from the malformed SQL template literal |
| Directory provider lookup (`/directory/providers`) | `directoryRoutes.get("/directory/providers")` + `withStaffActor` | Restored; requires staff; joins `staff_persons`, `engagements`, `job_titles`, `cadres`, `department_assignments`, `departments` |
| Complete triage (`completeTriage`) | `apps/api/src/services/clinical.ts` | Restored; persists `triage_records`, advances the encounter and `clinical_entries` to `in-progress`, re-queues the encounter for the clinician, writes audit + outbox |
| Professional designation capture (`recordProfessionalDesignation`) | `apps/api/src/services/clinical.ts` + `packages/db/migrations/050_professional_designations.sql` | Implemented; immutable snapshot inserted at sign time |
| Signing authorization preserved | Sign route preconditions in `clinical.ts` | Unchanged by this slice; existing sign/amendment gates retained |

## Lint/typecheck/build gate

- `npm run lint` — passes (exit `0`, `max-warnings=0`).
- `npm run typecheck` — passes (`tsc --noEmit`).
- Commit `9ad7a18` verified with clean `npm run lint` and `npm run typecheck`.
- `npm test` — **74 of 76 test files pass**; **621/629 tests pass**; **7 skipped**.

## Remaining failures (not code regressions)

1. `tests/integration/workflow-payments.test.ts` — 1 failed.
   Root cause: the test database was not migrated with
   `packages/db/migrations/050_professional_designations.sql`, so
   `recordProfessionalDesignation` threw
   `PostgresError: relation "professional_designations" does not exist`
   at sign time. This is an **environment / migration-application** gap,
   not a code bug.
2. `tests/integration/fhir.test.ts` — **7 skipped**. No failing tests.

## Business-rule invariants that are preserved

- The triage prerequisite is **not bypassed**: clinical notes may only be
  documented once an encounter has been triaged and moved to `in-progress`.
- Signing/amendment authorization is untouched by this slice.
- `professional_designations` (title/speciality) is **immutable at sign
  time** and never grants permissions to titles.
- LivePay is **Sandbox/Test only**: no real payment is initiated in this
  branch.

## State of the remaining work

- Documentation listed below (this file, `core-clinical-workflow-map.md`,
  `core-clinical-workflow-verification.md`,
  `consultation-professional-classification.md`,
  `production-recovery-deployment-checklist.md`).
- Migration ordering verification: `050_professional_designations.sql`
  correctly sorts after `049_*` and references only tables/functions
  defined by earlier migrations.
- Payment-integration final cutover decision is gated on the test-DB
  migration step and on a Warehouse inspecting the approved commercial
  pricing tier catalog.

## Open questions requiring the team (not blockers)

- Choose the exact step to apply `050_professional_designations.sql`
  (test harness reset vs. migration loader) before rerunning the two
  failing test files.
- Approve the three-tier pricing values in
  `packages/db/migrations/035_pricing_subscriptions_usage.sql` and the
  LivePay sandbox endpoint wiring before production cutover.
