# Production Functional Readiness Matrix

| Item | Value |
|---|---|
| Audit timestamp | `2026-11-23T09:49:39Z` (UTC) |
| Scope | Read-only review of local test evidence, reviewed migration/test tree, and production configuration readiness |
| Production execution | No writes, no real payments, no synthetic PHI creation, no external side effects |
| Final verdict | **B. DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA** |

## Commands and test results performed

| Command / artifact | Result |
|---|---|
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npx vitest run --config vitest.config.ts tests/unit/production-gate.test.ts` | `26` tests passed |
| Full suite log `/tmp/medveris-npm-test.log` | `RC=1`, `Test Files 8 failed \| 99 passed (107)`, `Tests 7 failed \| 929 passed \| 33 skipped (969)` |
| Targeted log `/tmp/medveris-targeted.log` | `RC=1`, `Test Files 5 failed \| 3 passed (8)`, `Tests 8 failed \| 97 passed (105)` |
| Targeted rerun `/tmp/medveris-targeted2.log` | `RC=1`, `Test Files 3 failed \| 5 passed (8)`, `Tests 6 failed \| 99 passed (105)` |
| Radiology-only log `/tmp/medveris-radiology.log` | `RC=1`, `1` failed, `10` passed |

Observed failure classes:

- `new row violates row-level security policy for table "sponsored_daily_metrics"`
- `permission denied for table integration_clients`
- `TypeError: Cannot read properties of undefined (reading 'stage')`
- Audit-event RLS failures in earlier targeted logs.
- Scope/export and cross-tenant patient tests failing in earlier logs.

Follow-up fixes were made after those logs for audit context, integration-client grant, and sponsored metric read policy, but the full suite was not rerun after those changes.

## Readiness matrix

| Area | Status | Evidence | Go-live impact |
|---|---|---|---|
| Deployment provenance | Fail | Worker tag `18f842a`; reviewed HEAD `7117f36`; dirty tree blocks non-dry-run deploy | Cannot prove reviewed code is live |
| Migration parity | Fail | Production ledger `89`; pending `139`–`146` | RLS/integrity fixes absent |
| Lint/typecheck | Pass | `npm run lint`, `npm run typecheck` passed | No static gate blocker |
| Unit gate tests | Pass | `26` production-gate unit tests passed | Gate logic locally consistent |
| Full automated suite | Fail | `7` failed tests across `8` failed files in full log | Not releasable |
| Tenant isolation | Fail | Production broad policies; local cross-tenant helper defect | Blocks real patient data |
| Patient enrollment/linking | Partial/Fail | `patients.test.ts` and directory linkage failures in logs | Core workflow unverified |
| Facility export scope | Fail | `data-exchange.test.ts` failure; membership guard mismatch identified | Authorization risk |
| Radiology workflow | Fail | `TypeError ... reading 'stage'` | Core clinical workflow unverified |
| Directory / sponsored campaigns | Fail | RLS/audit failures in targeted logs | Public event accounting unverified |
| Integration clients/tokens | Fail | `permission denied for table integration_clients` in targeted log | Partner exchange unverified |
| Onboarding/workspaces | Partial | Invitation reactivation regression added; earlier failures observed | Needs clean rerun |
| Auth/MFA/password reset | Partial | Audit context fixes made; earlier failures observed | Needs clean rerun |
| Payments/finance | Fail | Yo-only adapter vs LivePay-capable checkout/webhook; gate config mismatch | Payment path not production-ready |
| Backup/PITR | Fail | Empty backup label; missing inventory; pgBackRest crash loop | Recovery unverified |
| Monitoring/alerting | Partial | URL reachability checked; alert destination/token not verified | Operational response unverified |
| Legal/privacy | Fail | Privacy notice promises missing settings routes | Compliance gap |
| Integration availability | Partial | Static labels only; live provider callbacks not exercised | Availability claims unverified |
| Performance | Unverified | No placement/DB region proof, no slow-query evidence, storage buffers full objects | Capacity not proven |
| Production data state | Informational | Count-only: `patients=0`, `memberships=0`, `audit_events=0` | No PHI observed, but does not prove functionality |

## Known local fixes not yet fully retested

- `apps/api/src/routes/auth.ts`: MFA enrolment, email verification, and password-reset audit context.
- `apps/api/src/routes/me.ts`: `/me/context` audit context.
- `apps/api/src/routes/organizations.ts`: organization link decision `setLocalContext`.
- `apps/api/src/routes/promotions.ts`: payment confirmation `setLocalContext`.
- `packages/db/migrations/140_integration_tokens_tenant_scope.sql`: removal of runtime `integration_clients` `EXISTS` checks and grant to `medveris_exchange`.
- `packages/db/migrations/142_patient_scope_rls_hardening.sql`: patient scope changes and enrollment helper.
- `packages/db/migrations/143_remaining_rls_overgrant_hardening.sql`: anonymous sponsored metrics read policy.
- `tests/integration/invitations.test.ts`: invitation reactivation regression.
- `tests/integration/rls.test.ts`: expired-grant test and migration URL cleanup.

## Functional conclusion

Functional readiness is not achieved. The automated suite is red, several core clinical and tenant-isolation workflows have unresolved failures, and production has not received the reviewed migration set. Approval for real patient data is withheld.
