# Production Functional Evidence

Date: 2026-11-23
Repo: `/home/aidomex/medveris`
Safety: synthetic test environment only; no real patient data was created, read in detail, modified, or exported.

## 1. Evidence

| Evidence | Path | Result |
|---|---|---|
| Lint | `/tmp/ready/phaseA/lint.out` | `rc=0` |
| Typecheck | `/tmp/ready/phaseA/typecheck.out` | `rc=0` |
| Gate unit test | `/tmp/ready/phaseA/production-gate-test.out` | `26/26` |
| Platform-role GUC test | `/tmp/ready/phaseA/platform-role-guc-test.out` | `6/6` |
| RLS test | `/tmp/ready/phaseA/rls-test.out` | `6/6` |
| Patients test | `/tmp/ready/phaseA/patients-test.out` | `9/9` |
| Older full suite | `/tmp/medveris-npm-test.log` | `RC=1`, `8` failed files, `7` failed tests, `929` passed, `33` skipped |
| Older targeted logs | `/tmp/medveris-targeted.log`, `/tmp/medveris-targeted2.log` | failing |

## 2. Locally verified in this pass

- `npm run lint` → `0`
- `npm run typecheck` → `0`
- `tests/unit/production-gate.test.ts` → `26/26`
- `tests/integration/platform-role-guc.test.ts` → `6/6`
- `tests/integration/rls.test.ts` → `6/6`, including expired-grant denial and audit tenant restriction
- `tests/integration/patients.test.ts` → `9/9`, including linkage of a patient registered elsewhere and facility-scoped lookup

These results support `VERIFIED IN LOCAL TEST DATABASE` for the targeted RLS, patient lookup, and platform-role behaviors. They do not prove production behavior because production is eight migrations behind.

## 3. Still-open functional blockers

| ID | Evidence | Disposition |
|---|---|---|
| `FUNC-01` | Older full suite still failing: `8` files, `7` tests | Must rerun full suite after current fixes; not closed |
| `FUNC-02` | Radiology `TypeError: Cannot read properties of undefined (reading 'stage')` in older log | Not re-verified this pass |
| `FUNC-03` | Directory sponsored/token/cross-tenant failures in older log | Not re-verified this pass |
| `FUNC-04` | Patient enrollment/link failure in older log | Targeted patients test now `9/9`; local retest passes, production still blocked by migration parity |
| `FUNC-05` | Data-exchange facility-wide export scope failure in older log | Not re-verified this pass |
| `RLS-MED-01` | Broader suite red in older logs | Partially retested; full suite still required |
| `IND-05` | Targeted logs showed `new row violates row-level security policy for table "sponsored_daily_metrics"` and `permission denied for table integration_clients` | Source fixes reviewed; targeted sponsored re-run not captured |

## 4. Product and integration gaps

- Privacy notice promises “Settings > Privacy”, but correction/deletion/export/preferences/withdrawal incident flows remain incomplete (`SEC-09`, `IND-07`).
- Payment provider mismatch remains: adapter/Yo gate/LivePay config are not aligned (`SEC-10`, `IND-08`).
- Alert delivery and integration health are not live-verified (`SEC-11`, `IND-09`).
- DICOMweb/PACS, lab, pharmacy, telemedicine, devices, AI, payments, and public-health integrations must be reported truthfully; reachability is not operational proof.
- No real patient data may be used to close these gaps.

## 5. Required final verification

```bash
npm test
npx vitest run --config vitest.config.ts tests/integration/rls.test.ts
npx vitest run --config vitest.config.ts tests/integration/patients.test.ts
npx vitest run --config vitest.config.ts tests/integration/platform-role-guc.test.ts
npm run audit:runtime
```

Expected: all commands `0`, with no failing file and no synthetic/patient data in production.

## 6. Decision

- `VERIFIED IN LOCAL TEST DATABASE`: targeted gate, RLS, patient, and platform-role slices.
- `VERIFIED IN PRODUCTION`: no functional sign-off.
- Functional approval is withheld until the full suite is green and product/integration truthfulness gaps are closed.
