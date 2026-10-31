# Acceptance test matrix

Status date: 31 October 2026. Evidence type: U = unit, I = PostgreSQL integration (real local database), E = Playwright browser against the local stack, S = staging HTTP checks. Mocks appear only in unit tests and in integration tests that stand in for an unavailable external system (fake PACS, fake Yo! gateway, fake DHIS2); none of those establish integration availability.

| Acceptance criterion | Type | Test | Result |
|---|---|---|---|
| Registering a patient persists identity and returns a public ID | I, E | `patients.test.ts`, `patient-lookup.spec.ts` | PASS |
| Exact lookup confirms identity; typed ID variants resolve | I, E | `patients.test.ts`, `patient-lookup.spec.ts` | PASS |
| Failed confirmation reports `matched:false`, no failed HTTP request | I, E | same | PASS |
| Facility search never returns another facility's patients | I | `patients.test.ts` | PASS |
| Same-facility duplicates queued, never auto-merged | I | `patients.test.ts` | PASS |
| A retried assisted registration with the same idempotency key returns the stored patient | I | `patients.test.ts` | PASS |
| A confirmed public ID enrols an existing patient at another facility without a new identity | I | `patients.test.ts` | PASS |
| Merge needs a second authorised person and is reversible with a reason | I | `patient-merge.test.ts` | PASS |
| Repeated encounter submission does not duplicate encounters | I | `reliability.test.ts` | PASS |
| New staff must enrol MFA before facility data | E | `mfa-setup.spec.ts` | PASS |
| Integration flags without adapters are `misconfigured` and refused | U, I | `integration-registry.test.ts`, `departments.test.ts` | PASS |
| PACS connectivity cannot be claimed without a passing conformance run | I | `pacs.test.ts`, `departments.test.ts`; setup in `docs/22_PACS_DICOMWEB_RUNBOOK.md` | PASS |
| Device ingestion stores nothing while unavailable | I | `departments.test.ts` | PASS |
| Telehealth join and AI jobs refused with typed error | I | `departments.test.ts` | PASS |
| Diagnostics order → specimen → verify → correct → critical communication | I | `departments.test.ts` | PASS |
| Radiology structured templates, draft persistence with conflict protection, radiologist-only sign-off, addenda and corrections | I, E | `radiology.test.ts`, `journeys.spec.ts` Journey C | PASS |
| Critical imaging finding blocks release until communicated, and escalates when unacknowledged | I | `radiology.test.ts` | PASS |
| Pharmacy review → dispense → stock decrement | I | `departments.test.ts` | PASS |
| Retail POS prices stock, allocates FEFO or untracked batches, replays retries, applies prescription limits and restores stock on void | I | `pharmacy-pos.test.ts` | PASS (synthetic) |
| A supplier invoice cannot be relinked or reused by another purchase order in the workspace | I | `workspaces.test.ts` | PASS |
| Failed dispense leaves stock, movements and dispense records unchanged | I | `reliability.test.ts` | PASS |
| Concurrent dispenses never take stock negative | I | `reliability.test.ts` | PASS |
| Concurrent admissions cannot take the same bed | I | `reliability.test.ts` | PASS |
| Invoice, cash and mobile-money payments, reversal and reconciliation keep ledger state | I | `departments.test.ts`, `workflow-payments.test.ts` | PASS (synthetic gateway; no real settlement) |
| Subscription checkout quotes every interval, confirms once from a signed notification and refuses mismatched or declined payments | I, U | `subscription-checkout.test.ts`, `subscription-interval.test.ts` | PASS (synthetic gateway) |
| Reports are role-scoped, bounded and export with audited CSV | I | `reports.test.ts` | PASS |
| Department role boundaries and tenant isolation | I | `departments.test.ts`, `rls.test.ts` | PASS |
| Password reset and verification emails delivered in staging | S | delivery recorded as `delivered` with a Resend message ID | PASS |
| Blue-green staging and production release, verification and rollback | S | `npm run deploy:staging`, `npm run deploy:production`, rollback drills | PASS |
| Backup restore drill | — | Aiven PITR confirmed; drill recorded 2026-10-28T17:35:12Z | PASS (recorded, synthetic) |
