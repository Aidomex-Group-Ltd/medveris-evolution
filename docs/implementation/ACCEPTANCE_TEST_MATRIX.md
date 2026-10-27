# Acceptance test matrix

Evidence type: U = unit, I = PostgreSQL integration (real local database), E = Playwright browser against the local stack, S = staging HTTP checks. Mocks appear only in unit tests (`email.test.ts` stubs `fetch`); none establish integration availability.

| Acceptance criterion | Type | Test | Result (2026-10-28) |
|---|---|---|---|
| Registering a patient persists identity and returns a public ID | I, E | `patients.test.ts`, `patient-lookup.spec.ts` | PASS |
| Exact lookup confirms identity; typed ID variants resolve | I, E | `patients.test.ts`, `patient-lookup.spec.ts` | PASS |
| Failed confirmation reports `matched:false`, no failed HTTP request | I, E | same | PASS |
| Facility search never returns another facility's patients | I | `patients.test.ts` | PASS |
| Same-facility duplicates queued, never auto-merged | I | `patients.test.ts` | PASS |
| Repeated encounter submission does not duplicate encounters | — | none | NOT_TESTED |
| New staff must enrol MFA before facility data | E | `mfa-setup.spec.ts` | PASS |
| Integration flags without adapters are `misconfigured` and refused | U, I | `integration-registry.test.ts`, `departments.test.ts` | PASS |
| PACS connectivity cannot be claimed | I | `departments.test.ts` | PASS |
| Device ingestion stores nothing while unavailable | I | `departments.test.ts` | PASS |
| Telehealth join and AI jobs refused with typed error | I | `departments.test.ts` | PASS |
| Diagnostics order → specimen → verify → correct → critical communication | I | `departments.test.ts` | PASS |
| Radiology structured templates, draft persistence, sign-off, addenda | — | none | NOT_TESTED (not implemented) |
| Pharmacy review → dispense → stock decrement | I | `departments.test.ts` | PASS |
| Failed dispense leaves stock unchanged | — | not asserted | NOT_TESTED |
| Concurrent admissions cannot take the same bed | — | none | NOT_TESTED |
| Invoice, payment, reversal keep ledger state | I | `departments.test.ts` | PASS (manual payments only) |
| Department role boundaries and tenant isolation | I | `departments.test.ts`, `rls.test.ts` | PASS |
| Password reset and verification emails delivered in staging | S | delivery recorded as `delivered` with a Resend message ID | PASS |
| Staging blue-green release, verification and rollback | S | `npm run deploy:staging`, rollback drill | PASS |
| Backup restore drill | — | none | BLOCKED |
