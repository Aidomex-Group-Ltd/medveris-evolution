# Route Coverage Report — Phase 1.2

**Date:** 2026-11-12  
**Matrix version:** `2026-11-12.phase0-1.foundation`

## 1. Coverage Summary

| Category | Routes | Share of inventory |
|---|---|---|
| Matrix-covered | 422 | 59.4% |
| Exempt (non-permission) | 36 | 5.1% |
| Overlap (both) | 1 | 0.1% |
| **Total covered** | **457** | **64.3%** |
| **Uncovered (gaps)** | **254** | **35.7%** |
| Total inventory | 711 | 100.0% |

Total covered = matrix ∪ exemptions = 457 unique routes; uncovered + covered = inventory.

> **Post-approval adoption (2026-11-12):** the 24 reuse routes were bound, then the inventory NEW
> slice (15 routes), the small-domain batch (30 routes) and the operations/content batch (33 routes)
> were adopted. Stage 3 baseline was 320 matrix-covered / 355 covered / 356 gaps.

## 2. Coverage by Router

| Router | Total | Matrix | Exempt | Overlap | Uncovered | Covered % |
|---|---|---|---|---|---|---|
| `maternity.ts` | 20 | 3 | 0 | 0 | 17 | 15.0% |
| `fhir/router.ts` | 17 | 0 | 0 | 0 | 17 | 0.0% |
| `inpatient.ts` | 27 | 12 | 0 | 0 | 15 | 44.4% |
| `organization.ts` | 25 | 10 | 0 | 0 | 15 | 40.0% |
| `terminology/router.ts` | 15 | 0 | 0 | 0 | 15 | 0.0% |
| `diagnostics.ts` | 23 | 9 | 0 | 0 | 14 | 39.1% |
| `directory.ts` | 23 | 12 | 0 | 0 | 11 | 52.2% |
| `workforce-reference.ts` | 17 | 6 | 0 | 0 | 11 | 35.3% |
| `workflow.ts` | 11 | 0 | 0 | 0 | 11 | 0.0% |
| `admin.ts` | 20 | 10 | 0 | 0 | 10 | 50.0% |
| `billing.ts` | 19 | 9 | 0 | 0 | 10 | 47.4% |
| `radiology.ts` | 27 | 18 | 0 | 0 | 9 | 66.7% |
| `finance.ts` | 26 | 17 | 0 | 0 | 9 | 65.4% |
| `ehmis.ts` | 19 | 10 | 0 | 0 | 9 | 52.6% |
| `theatre.ts` | 13 | 4 | 0 | 0 | 9 | 30.8% |
| `auth.ts` | 21 | 0 | 13 | 0 | 8 | 61.9% |
| `reception.ts` | 19 | 11 | 0 | 0 | 8 | 57.9% |
| `pharmacy-pos.ts` | 12 | 4 | 0 | 0 | 8 | 33.3% |
| `pharmacy.ts` | 11 | 4 | 0 | 0 | 7 | 36.4% |
| `credentials.ts` | 10 | 3 | 0 | 0 | 7 | 30.0% |
| `workspace.ts` | 15 | 9 | 0 | 0 | 6 | 60.0% |
| `integrations.ts` | 14 | 8 | 0 | 0 | 6 | 57.1% |
| `programmes.ts` | 13 | 7 | 0 | 0 | 6 | 53.8% |
| `promotions.ts` | 12 | 6 | 0 | 0 | 6 | 50.0% |
| `onboarding.ts` | 19 | 15 | 0 | 0 | 4 | 78.9% |
| `organizations.ts` | 13 | 9 | 0 | 0 | 4 | 69.2% |
| `payment-callbacks.ts` | 5 | 0 | 3 | 0 | 2 | 60.0% |
| `clinical.ts` | 18 | 17 | 0 | 0 | 1 | 94.4% |
| `inventory.ts` | 51 | 51 | 0 | 0 | 0 | 100.0% |
| `content.ts` | 39 | 39 | 0 | 0 | 0 | 100.0% |
| `operations.ts` | 22 | 22 | 0 | 0 | 0 | 100.0% |
| `documents.ts` | 13 | 13 | 0 | 0 | 0 | 100.0% |
| `me.ts` | 10 | 6 | 5 | 1 | 0 | 100.0% |
| `consent.ts` | 8 | 8 | 0 | 0 | 0 | 100.0% |
| `platform-observability.ts` | 8 | 8 | 0 | 0 | 0 | 100.0% |
| `procurement.ts` | 8 | 8 | 0 | 0 | 0 | 100.0% |
| `care.ts` | 7 | 7 | 0 | 0 | 0 | 100.0% |
| `devices.ts` | 7 | 7 | 0 | 0 | 0 | 100.0% |
| `telehealth.ts` | 7 | 7 | 0 | 0 | 0 | 100.0% |
| `data-exchange.ts` | 6 | 6 | 0 | 0 | 0 | 100.0% |
| `emergency.ts` | 6 | 6 | 0 | 0 | 0 | 100.0% |
| `patient-merge.ts` | 6 | 6 | 0 | 0 | 0 | 100.0% |
| `public.ts` | 6 | 0 | 6 | 0 | 0 | 100.0% |
| `subscription-checkout.ts` | 6 | 6 | 0 | 0 | 0 | 100.0% |
| `legal.ts` | 4 | 0 | 4 | 0 | 0 | 100.0% |
| `ai.ts` | 3 | 3 | 0 | 0 | 0 | 100.0% |
| `facility-logo.ts` | 3 | 3 | 0 | 0 | 0 | 100.0% |
| `notifications.ts` | 2 | 0 | 2 | 0 | 0 | 100.0% |
| `ops.ts` | 2 | 1 | 1 | 0 | 0 | 100.0% |
| `realtime.ts` | 2 | 0 | 2 | 0 | 0 | 100.0% |
| `reports.ts` | 2 | 2 | 0 | 0 | 0 | 100.0% |

## 3. Largest Gaps

Routers with the most uncovered routes should be prioritised for adoption:

- `maternity.ts`: 17 uncovered of 20
- `fhir/router.ts`: 17 uncovered of 17
- `inpatient.ts`: 15 uncovered of 27
- `organization.ts`: 15 uncovered of 25
- `terminology/router.ts`: 15 uncovered of 15
- `diagnostics.ts`: 14 uncovered of 23
- `directory.ts`: 11 uncovered of 23
- `workforce-reference.ts`: 11 uncovered of 17
- `workflow.ts`: 11 uncovered of 11
- `admin.ts`: 10 uncovered of 20

## 4. Definitions

- **Matrix-covered:** route appears in at least one `AUTHORIZATION_MATRIX` `routePatterns`.
- **Exempt:** route appears in `NON_PERMISSION_ENDPOINTS` (public, health, webhook, flow-token, authenticated-self) with declared controls.
- **Uncovered:** route has neither a matrix binding nor a declared exemption. Not necessarily unauthorized in code today; it means the matrix does not yet describe its authorization.
- **Overlap:** route covered by both a matrix action and an exemption (e.g. `GET /me/records`); reviewed individually.

## 5. Notes

- This report measures *matrix description coverage*, not runtime enforcement. Endpoints not covered here may still enforce inline role/predicate checks.
- No coverage was claimed by weakening or exempting endpoints. Gaps are tracked for explicit, owner-approved adoption.