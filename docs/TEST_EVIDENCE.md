# Test evidence

Date: 25 October 2026. All data is synthetic. Commands were run from the repository root with Node v22.22.3 and PostgreSQL 14.

## Executed successfully

| Command | Result |
|---|---|
| `npm run lint` | Passed, zero warnings |
| `npm run typecheck` | Passed |
| `npm test` | 8 files, 50 tests passed |
| `npm run test:e2e` | 12 Playwright tests passed (smoke 3, departmental 9) |
| `npm run smoke:clinical` | Draft → sign → amend → versions: `[[1,"signed"],[2,"amended"]]` |
| `npm run smoke:workers` | Event processed once; dedup row present; signed Merkle checkpoint present |
| `npm run build` | Web 69 modules / 489.99 kB JS; API server bundle 398.9 kB; worker bundle 1.2 MB |
| `PORT=8788 node apps/api/dist/server.mjs` | Started successfully; `/api/v1/health/ready` returned `{"status":"ready","database":"reachable"}`; clean SIGTERM shutdown |
| `npm run db:migrate` | 001–007 applied cleanly on the development database |

## Unit tests

`tests/unit/domain.test.ts` and `tests/unit/authz.test.ts` cover:

- Patient public ID format, randomness and ambiguous-character rejection.
- Draft/sign/amend/entered-in-error state transitions and encounter transitions.
- Canonical JSON and content digest stability.
- Role boundaries: administrators cannot read or sign clinical notes; nurses document but do not sign; MFA requirements; reception/finance/auditor denial.

## PostgreSQL isolation tests

`tests/integration/rls.test.ts` verifies against the real `medveris_runtime` role:

- Clinical versions are filtered to the transaction-local tenant.
- Direct cross-tenant encounter reads return no rows.
- Cross-tenant inserts are rejected by the RLS check policy.
- Session variables reset after a pooled transaction; queries without context see no clinical versions.
- Audit reads require the active tenant plus a governance role; patient access is limited to their own subject records.

## HTTP contract tests

`tests/integration/http.test.ts` uses the real Hono app, PostgreSQL and local adapters:

- Unauthenticated protected reads return 401 with a correlation ID.
- Bad password and unknown account return the same 401 message.
- State-changing requests without CSRF are rejected.
- `/me` exposes verified MFA, facility and roles.
- Reception and facility administrators are denied the clinical worklist.
- Another tenant's encounter returns 404 without leaking its reason.
- Malformed UUIDs return 422 (previously an unhandled 500).
- FHIR metadata is public; FHIR writes return 405; FHIR Patient reads are facility-link scoped.
- Synthetic terminology expansion returns a labelled ValueSet.

## Patient registration tests

`tests/integration/patients.test.ts` verifies:

- Registering the same family name and date of birth twice at one facility queues exactly one review candidate.
- Registering the same identity at another facility queues no candidate and exposes no cross-facility candidate to the first facility's administrator.
- Duplicate review is audited, removes the candidate from the pending list and explicitly reports that no automatic merge occurred.
- Migration 006 scopes candidate rows and RLS to the active facility.

## Care coordination tests

`tests/integration/care.test.ts` verifies:

- An overdue pending follow-up appears in the overdue worklist.
- Completion increments the version; a stale version and a terminal-state transition both return 409.
- A referral moves pending → accepted → completed with one audit event per change.
- Reception is denied both care-coordination lists.

`tests/e2e/departments.spec.ts` additionally schedules a follow-up and referral from an encounter, completes the overdue follow-up from the care page, and records local referral acceptance. The UI states that no external referral transmission occurred.

## Emergency API tests

`tests/integration/emergency.test.ts` runs the emergency workflow through the real API:

- Registers an unidentified patient, records triage and serial observations, hands off to a named clinician and discharges with a disposition.
- Rejects a stale disposition with 409 rather than overwriting the earlier decision.
- Requires a real admission before an `admitted` disposition is recorded.
- Denies emergency access to a role without clinical emergency permission.

## Departmental API tests

`tests/integration/departments.test.ts` runs the full synthetic departmental flows through the real API:

- Admission, bed assignment, nursing assessments/tasks, handoff and discharge.
- Theatre preop, consent, safety checklists, anesthesia, counts, recovery and completion, including refusal to skip checkpoints.
- Diagnostics order, specimen receive/verify, result release, correction and critical-result communication.
- Pharmacy review, dispensing, administration and stock controls.
- Invoicing, payment/reversal, claims, programmes, public health and cross-role denial.

## Browser tests

`tests/e2e/smoke.spec.ts` runs against the Vite app and live API:

1. Clinician signs in with password + TOTP, reaches the overview, opens the worklist and a patient chart.
2. Receptionist signs in but cannot see or open the clinical worklist.
3. Patient signs in without MFA and reaches their portal with released records and consent navigation.

`tests/e2e/departments.spec.ts` additionally verifies that each departmental workspace opens with the correct roles, that a clinician can place a laboratory order, and that a clinician can schedule and open a theatre case with its safety-checkpoint surface. It also covers the pharmacist, finance and public-health permission boundaries, and an emergency journey that registers, triages and hands off an unidentified patient. The navigation test covers the left-side mobile drawer (open, anchor at the left edge, focus trap, Escape restore, collapse a stacked group, choose a link, auto-close).

## Worker smoke

`scripts/workers-smoke.mjs` inserts a synthetic outbox event with the `medveris_jobs` role, runs one drain cycle, and asserts:

- Event status is `processed` after one attempt.
- `processed_outbox_events` contains the deduplication record.
- A signed integrity checkpoint exists with `ledgerState=not-requested`.

## Not covered

No load, penetration, backup/restore, accessibility, FHIR validation, interoperability, failover, production email/storage or Cloudflare runtime tests have been performed. See `docs/IMPLEMENTATION_GAPS.md`.
