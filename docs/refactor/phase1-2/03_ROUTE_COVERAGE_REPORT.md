# Route Coverage Report — Phase 1.2

**Date:** 2026-11-12  
**Matrix version:** `2026-11-12.phase0-1.foundation`

## 1. Coverage Summary

| Category | Routes | Share of inventory |
|---|---|---|
| Matrix-covered | 666 | 93.7% |
| Exempt (non-permission) | 46 | 6.5% |
| Overlap (both) | 1 | 0.1% |
| **Total covered** | **711** | **100.0%** |
| **Uncovered (gaps)** | **0** | **0.0%** |
| Total inventory | 711 | 100.0% |

Total covered = matrix ∪ exemptions = 711 unique routes; uncovered + covered = inventory.

> **Post-approval adoption (2026-11-12):** all 346 approved permission mappings (24 reuse + 322 NEW) were adopted in slices, and the 10 authenticated-self/webhook exemption candidates were verified and added to `NON_PERMISSION_ENDPOINTS`. Stage 3 baseline was 320 matrix-covered / 355 covered / 356 gaps.

## 2. Coverage by Router

| Router | Total | Matrix | Exempt | Overlap | Uncovered | Covered % |
|---|---|---|---|---|---|---|
| `inventory.ts` | 51 | 51 | 0 | 0 | 0 | 100.0% |
| `content.ts` | 39 | 39 | 0 | 0 | 0 | 100.0% |
| `inpatient.ts` | 27 | 27 | 0 | 0 | 0 | 100.0% |
| `radiology.ts` | 27 | 27 | 0 | 0 | 0 | 100.0% |
| `finance.ts` | 26 | 26 | 0 | 0 | 0 | 100.0% |
| `organization.ts` | 25 | 25 | 0 | 0 | 0 | 100.0% |
| `diagnostics.ts` | 23 | 23 | 0 | 0 | 0 | 100.0% |
| `directory.ts` | 23 | 23 | 0 | 0 | 0 | 100.0% |
| `operations.ts` | 22 | 22 | 0 | 0 | 0 | 100.0% |
| `auth.ts` | 21 | 0 | 21 | 0 | 0 | 100.0% |
| `admin.ts` | 20 | 20 | 0 | 0 | 0 | 100.0% |
| `maternity.ts` | 20 | 20 | 0 | 0 | 0 | 100.0% |
| `billing.ts` | 19 | 19 | 0 | 0 | 0 | 100.0% |
| `ehmis.ts` | 19 | 19 | 0 | 0 | 0 | 100.0% |
| `onboarding.ts` | 19 | 19 | 0 | 0 | 0 | 100.0% |
| `reception.ts` | 19 | 19 | 0 | 0 | 0 | 100.0% |
| `clinical.ts` | 18 | 18 | 0 | 0 | 0 | 100.0% |
| `fhir/router.ts` | 17 | 17 | 0 | 0 | 0 | 100.0% |
| `workforce-reference.ts` | 17 | 17 | 0 | 0 | 0 | 100.0% |
| `terminology/router.ts` | 15 | 15 | 0 | 0 | 0 | 100.0% |
| `workspace.ts` | 15 | 15 | 0 | 0 | 0 | 100.0% |
| `integrations.ts` | 14 | 14 | 0 | 0 | 0 | 100.0% |
| `documents.ts` | 13 | 13 | 0 | 0 | 0 | 100.0% |
| `organizations.ts` | 13 | 13 | 0 | 0 | 0 | 100.0% |
| `programmes.ts` | 13 | 13 | 0 | 0 | 0 | 100.0% |
| `theatre.ts` | 13 | 13 | 0 | 0 | 0 | 100.0% |
| `pharmacy-pos.ts` | 12 | 12 | 0 | 0 | 0 | 100.0% |
| `promotions.ts` | 12 | 12 | 0 | 0 | 0 | 100.0% |
| `pharmacy.ts` | 11 | 11 | 0 | 0 | 0 | 100.0% |
| `workflow.ts` | 11 | 11 | 0 | 0 | 0 | 100.0% |
| `credentials.ts` | 10 | 10 | 0 | 0 | 0 | 100.0% |
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
| `payment-callbacks.ts` | 5 | 0 | 5 | 0 | 0 | 100.0% |
| `legal.ts` | 4 | 0 | 4 | 0 | 0 | 100.0% |
| `ai.ts` | 3 | 3 | 0 | 0 | 0 | 100.0% |
| `facility-logo.ts` | 3 | 3 | 0 | 0 | 0 | 100.0% |
| `notifications.ts` | 2 | 0 | 2 | 0 | 0 | 100.0% |
| `ops.ts` | 2 | 1 | 1 | 0 | 0 | 100.0% |
| `realtime.ts` | 2 | 0 | 2 | 0 | 0 | 100.0% |
| `reports.ts` | 2 | 2 | 0 | 0 | 0 | 100.0% |

## 3. Largest Gaps

No uncovered routes remain; all 711 inventory routes are matrix-covered or explicitly exempt.

## 4. Definitions

- **Matrix-covered:** route appears in at least one `AUTHORIZATION_MATRIX` `routePatterns`.
- **Exempt:** route appears in `NON_PERMISSION_ENDPOINTS` (public, health, webhook, flow-token, authenticated-self) with declared controls.
- **Uncovered:** route has neither a matrix binding nor a declared exemption. Not necessarily unauthorized in code today; it means the matrix does not yet describe its authorization.
- **Overlap:** route covered by both a matrix action and an exemption (e.g. `GET /me/records`); reviewed individually.

## 5. Notes

- This report measures *matrix description coverage*, not runtime enforcement. Endpoints not covered here may still enforce inline role/predicate checks.
- No coverage was claimed by weakening or exempting endpoints. Gaps are tracked for explicit, owner-approved adoption.