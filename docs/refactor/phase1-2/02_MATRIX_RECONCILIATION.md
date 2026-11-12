# Matrix Reconciliation — Phase 1.2

**Date:** 2026-11-12  
**Baseline matrix version:** `2026-11-12.phase0-1.foundation`  
**Inputs:** `01_API_ROUTE_INVENTORY.md`, `AUTHORIZATION_MATRIX`, `NON_PERMISSION_ENDPOINTS`

## 1. Summary

| Metric | Value |
|---|---|
| Matrix actions | 231 |
| Matrix route patterns | 473 |
| Matrix patterns matched to a real route | 473 |
| Unique routes claimed by the matrix | 468 |
| Non-permission endpoint patterns | 36 |
| Non-permission patterns matched | 36 |
| Unique routes covered by exemptions | 36 |
| Total unique routes covered (matrix ∪ exemptions) | 503 |
| Inventory routes | 711 |
| Uncovered inventory routes (gaps) | 208 |
| Stale matrix patterns | 0 |

**Post-approval adoption (2026-11-12):** after owner approval of the gap mappings, the 24 reuse routes were bound (5 new action entries), the inventory NEW slice was adopted (13 new permissions, 13 new action entries; all 15 remaining inventory routes bound), the small-domain batch was adopted (22 new permissions/action entries; 30 routes across emergency, telehealth, documents, AI, devices, facility logo, subscription checkout, procurement and platform observability, plus the clinical draft route), the operations/content batch was adopted (27 new permissions/action entries; 33 routes), and the maternity/inpatient/diagnostics batch was adopted (40 new permissions/action entries; 46 routes). Totals above reflect all slices; the Stage 3 baseline was 125 actions / 325 patterns / 320 matrix routes / 356 gaps.

## 2. Corrections Applied

Reconciliation found 10 matrix route bindings for `admin.ts` that omitted the `/admin` mount prefix. 
The routes were mounted at `/api/v1/admin`, so the normalized paths are `/admin/...`. The bindings were corrected:

| Action key | Before | After |
|---|---|---|
| `organization.membership.manage` | `GET /memberships` | `GET /admin/memberships` |
| `organization.membership.manage` | `POST /invitations` | `POST /admin/invitations` |
| `organization.membership.manage` | `PATCH /memberships/:id` | `PATCH /admin/memberships/:id` |
| `organization.membership.manage` | `DELETE /memberships/:id` | `DELETE /admin/memberships/:id` |
| `organization.duplicate.review` | `GET /duplicate-candidates` | `GET /admin/duplicate-candidates` |
| `organization.duplicate.review` | `POST /duplicate-candidates/:id/review` | `POST /admin/duplicate-candidates/:id/review` |
| `platform.operations.manage` | `GET /platform-operator/requests` | `GET /admin/platform-operator/requests` |
| `platform.operations.manage` | `POST /platform-operator/requests` | `POST /admin/platform-operator/requests` |
| `platform.operations.manage` | `POST /platform-operator/requests/:id/approve` | `POST /admin/platform-operator/requests/:id/approve` |
| `platform.operations.manage` | `POST /platform-operator/grants/:userId/revoke` | `POST /admin/platform-operator/grants/:userId/revoke` |

After correction: **0 stale matrix patterns**, **0 stale exemption patterns**.

## 3. Routes Claimed by Multiple Actions

These routes are intentionally bound to more than one action (layered/dual checks). They must not be reduced to a single permission:

| Route | Actions |
|---|---|
| `GET /me/records` | `patient.profile.read_self`, `patient.record.read_released_self` |
| `POST /pharmacy/sales` | `medication.dispense`, `pharmacy.pos.payment` |
| `POST /lab-results/:id/finalize` | `diagnostic.report.sign`, `diagnostic.result.validate` |
| `POST /lab-results/:id/release` | `diagnostic.report.sign`, `diagnostic.result.validate` |
| `POST /procurement/purchase-orders/:id/action` | `inventory.procurement.manage`, `inventory.procurement.approve` |

## 4. Uncovered Inventory Routes (Coverage Gaps)

0 inventory routes remain uncovered. The final adoption batch and the verified exemptions closed the
remaining 208 gaps (see §1). The per-router table below is retained as the Stage 3 baseline record.

| Router | Uncovered (baseline, closed) |
|---|---|
| `inventory.ts` | 30 |
| `fhir/router.ts` | 17 |
| `operations.ts` | 17 |
| `maternity.ts` | 17 |
| `content.ts` | 16 |
| `inpatient.ts` | 15 |
| `organization.ts` | 15 |
| `radiology.ts` | 15 |
| `terminology/router.ts` | 15 |
| `diagnostics.ts` | 14 |
| `workflow.ts` | 11 |
| `directory.ts` | 11 |
| `workforce-reference.ts` | 11 |
| `admin.ts` | 10 |
| `billing.ts` | 10 |
| `ehmis.ts` | 9 |
| `finance.ts` | 9 |
| `theatre.ts` | 9 |
| `reception.ts` | 8 |
| `auth.ts` | 8 |
| `pharmacy-pos.ts` | 8 |
| `credentials.ts` | 7 |
| `pharmacy.ts` | 7 |
| `integrations.ts` | 6 |
| `programmes.ts` | 6 |
| `promotions.ts` | 6 |
| `workspace.ts` | 6 |
| `organizations.ts` | 6 |
| `onboarding.ts` | 5 |
| `platform-observability.ts` | 5 |
| `procurement.ts` | 5 |
| `documents.ts` | 4 |
| `telehealth.ts` | 4 |
| `subscription-checkout.ts` | 3 |
| `emergency.ts` | 3 |
| `ai.ts` | 2 |
| `devices.ts` | 2 |
| `payment-callbacks.ts` | 2 |
| `facility-logo.ts` | 1 |
| `clinical.ts` | 1 |

### Full list by router

#### `inventory.ts` (30)

| Method | Path |
|---|---|
| GET | `/inventory/adjustments` |
| GET | `/inventory/assets` |
| GET | `/inventory/assets/:id` |
| GET | `/inventory/counts` |
| GET | `/inventory/items` |
| GET | `/inventory/locations` |
| GET | `/inventory/policies` |
| GET | `/inventory/recalls` |
| GET | `/inventory/reports/asset-downtime` |
| GET | `/inventory/reports/consumption` |
| GET | `/inventory/reports/count-variance` |
| GET | `/inventory/reports/expiry` |
| GET | `/inventory/reports/low-stock` |
| GET | `/inventory/reports/maintenance-due` |
| GET | `/inventory/reports/recall-status` |
| GET | `/inventory/reports/requisition-fulfilment` |
| GET | `/inventory/reports/transfer-discrepancies` |
| GET | `/inventory/reports/valuation` |
| GET | `/inventory/requisitions` |
| GET | `/inventory/requisitions/:id` |
| GET | `/inventory/transfers` |
| GET | `/inventory/transfers/:id` |
| POST | `/inventory/assets` |
| POST | `/inventory/assets/:id/events` |
| POST | `/inventory/counts` |
| POST | `/inventory/movements/:id/reverse` |
| POST | `/inventory/requisitions` |
| POST | `/inventory/requisitions/:id/submit` |
| POST | `/inventory/reservations` |
| POST | `/inventory/reservations/:id/release` |

#### `fhir/router.ts` (17)

| Method | Path |
|---|---|
| ALL | `/fhir/r4/*` |
| GET | `/fhir/r4/AuditEvent` |
| GET | `/fhir/r4/AuditEvent/:id` |
| GET | `/fhir/r4/Consent` |
| GET | `/fhir/r4/Consent/:id` |
| GET | `/fhir/r4/DocumentReference` |
| GET | `/fhir/r4/DocumentReference/:id` |
| GET | `/fhir/r4/Organization` |
| GET | `/fhir/r4/Organization/:id` |
| GET | `/fhir/r4/Patient` |
| GET | `/fhir/r4/Patient/:id` |
| GET | `/fhir/r4/Practitioner` |
| GET | `/fhir/r4/Practitioner/:id` |
| GET | `/fhir/r4/PractitionerRole/:id` |
| GET | `/fhir/r4/Provenance` |
| GET | `/fhir/r4/Provenance/:id` |
| GET | `/fhir/r4/metadata` |

#### `operations.ts` (17)

| Method | Path |
|---|---|
| GET | `/housekeeping/tasks` |
| GET | `/mortuary/cases` |
| GET | `/mortuary/cases/:id` |
| GET | `/operations/beds` |
| GET | `/porter/tasks` |
| GET | `/technical/assets` |
| GET | `/technical/cssd-cycles` |
| GET | `/technical/work-orders` |
| POST | `/housekeeping/tasks/:id/transition` |
| POST | `/mortuary/cases/:id/effects` |
| POST | `/mortuary/cases/:id/movements` |
| POST | `/mortuary/cases/:id/release` |
| POST | `/porter/tasks/:id/transition` |
| POST | `/technical/assets` |
| POST | `/technical/cssd-cycles` |
| POST | `/technical/cssd-cycles/:id/release` |
| POST | `/technical/work-orders/:id/transition` |

#### `maternity.ts` (17)

| Method | Path |
|---|---|
| GET | `/maternity/children/:patientId/events` |
| GET | `/maternity/children/:patientId/immunization-catch-up` |
| GET | `/maternity/children/:patientId/immunization-due` |
| GET | `/maternity/children/:patientId/immunizations` |
| GET | `/maternity/episodes` |
| GET | `/maternity/episodes/:id` |
| GET | `/maternity/episodes/:id/alerts` |
| GET | `/maternity/episodes/:id/antenatal-visits` |
| GET | `/maternity/immunization-schedule` |
| PATCH | `/maternity/episodes/:id` |
| PATCH | `/maternity/newborns/:newbornId/status` |
| POST | `/maternity/children/:patientId/events` |
| POST | `/maternity/children/:patientId/immunizations` |
| POST | `/maternity/episodes/:id/alerts` |
| POST | `/maternity/episodes/:id/newborns` |
| POST | `/maternity/episodes/:id/observations` |
| POST | `/maternity/newborns/:newbornId/patient` |

#### `content.ts` (16)

| Method | Path |
|---|---|
| DELETE | `/content/:id/bookmark` |
| GET | `/access/summary` |
| GET | `/admin/care-team` |
| GET | `/content/bookmarks/mine` |
| GET | `/content/editorial/items` |
| GET | `/content/preferences/mine` |
| GET | `/content/sources` |
| GET | `/dashboards/patient` |
| GET | `/dashboards/specialist` |
| GET | `/opportunities` |
| POST | `/content-feeds/opportunities/:id/withdraw` |
| POST | `/content/:id/bookmark` |
| POST | `/content/:id/report` |
| POST | `/opportunities/:id/bookmark` |
| POST | `/opportunities/:id/report` |
| PUT | `/content/preferences/mine` |

#### `inpatient.ts` (15)

| Method | Path |
|---|---|
| GET | `/admissions/:id` |
| GET | `/admissions/:id/fluid-balance` |
| GET | `/admissions/:id/transfers` |
| GET | `/directory/clinical-members` |
| GET | `/wards/:id/capacity` |
| PATCH | `/admissions/:id/tasks/:taskId/assign` |
| POST | `/admissions` |
| POST | `/admissions/:id/administrations` |
| POST | `/admissions/:id/administrations/:administrationId/omit` |
| POST | `/admissions/:id/handoffs` |
| POST | `/admissions/:id/tasks/:taskId/escalate` |
| POST | `/admissions/:id/tasks/:taskId/omit` |
| POST | `/admissions/:id/transition` |
| POST | `/wards` |
| POST | `/wards/:id/beds` |

#### `organization.ts` (15)

| Method | Path |
|---|---|
| GET | `/organization/cadres` |
| GET | `/organization/departments` |
| GET | `/organization/job-titles` |
| GET | `/organization/locations` |
| GET | `/organization/units` |
| GET | `/workforce/onboarding/:id` |
| GET | `/workforce/privileges` |
| GET | `/workforce/staff` |
| GET | `/workforce/summary` |
| PATCH | `/organization/departments/:id` |
| PATCH | `/workforce/onboarding/:id` |
| POST | `/organization/catalogue` |
| POST | `/organization/departments/:id/units` |
| POST | `/workforce/engagements/:id/training` |
| POST | `/workforce/onboarding/:id/decision` |

#### `radiology.ts` (15)

| Method | Path |
|---|---|
| GET | `/radiology/catalogue` |
| GET | `/radiology/clinical-recipients` |
| GET | `/radiology/critical-communications` |
| GET | `/radiology/images/status` |
| GET | `/radiology/orders/:orderItemId/report` |
| GET | `/radiology/reports/:id` |
| GET | `/radiology/studies/:id` |
| GET | `/radiology/studies/:id/images/series/:seriesUid` |
| GET | `/radiology/studies/:id/images/series/:seriesUid/instances/:instanceUid/frames/:frame` |
| GET | `/radiology/worklist` |
| POST | `/radiology/critical-communications/:id/acknowledge` |
| POST | `/radiology/critical-communications/:id/escalate` |
| POST | `/radiology/reports/:id/critical-communications` |
| POST | `/radiology/studies/:id/pacs-link` |
| POST | `/radiology/studies/:id/pacs-unlink` |

#### `terminology/router.ts` (15)

| Method | Path |
|---|---|
| GET | `/terminology/autocomplete` |
| GET | `/terminology/fhir/r4/*` |
| GET | `/terminology/fhir/r4/CodeSystem/$lookup` |
| GET | `/terminology/fhir/r4/CodeSystem/$validate-code` |
| GET | `/terminology/fhir/r4/ConceptMap/$translate` |
| GET | `/terminology/fhir/r4/ValueSet/$expand` |
| GET | `/terminology/fhir/r4/ValueSet/$validate-code` |
| GET | `/terminology/fhir/r4/metadata` |
| GET | `/terminology/fields` |
| GET | `/terminology/search` |
| POST | `/terminology/fhir/r4/CodeSystem/$lookup` |
| POST | `/terminology/fhir/r4/CodeSystem/$validate-code` |
| POST | `/terminology/fhir/r4/ConceptMap/$translate` |
| POST | `/terminology/fhir/r4/ValueSet/$expand` |
| POST | `/terminology/fhir/r4/ValueSet/$validate-code` |

#### `diagnostics.ts` (14)

| Method | Path |
|---|---|
| GET | `/critical-communications` |
| GET | `/diagnostic-orders` |
| GET | `/diagnostic-orders/:id` |
| GET | `/diagnostic-reporting/releasable` |
| GET | `/diagnostic-reporting/worklist` |
| GET | `/lab-tests` |
| GET | `/patients/:id/diagnostics` |
| PATCH | `/specimens/:id` |
| POST | `/critical-communications/:id/acknowledge` |
| POST | `/diagnostic-orders/:id/assign` |
| POST | `/diagnostic-orders/:id/transitions` |
| POST | `/imaging-studies` |
| POST | `/lab-results/:id/critical-communications` |
| POST | `/lab-tests` |

#### `workflow.ts` (11)

| Method | Path |
|---|---|
| GET | `/encounters/:id/workflow` |
| GET | `/entries/:id/integrity` |
| GET | `/recommendations/:id` |
| GET | `/visits/board` |
| GET | `/work-queues` |
| GET | `/work-queues/:department` |
| PATCH | `/recommendations/:id` |
| POST | `/encounters/:id/recommendations` |
| POST | `/encounters/:id/supplies` |
| POST | `/recommendations/:id/transitions` |
| POST | `/supplies/:id/void` |

#### `directory.ts` (11)

| Method | Path |
|---|---|
| GET | `/public/directory/facilities` |
| GET | `/public/directory/facilities/:publicId` |
| GET | `/public/directory/map-config` |
| GET | `/public/directory/meta` |
| POST | `/directory/duplicates/:id/review` |
| POST | `/directory/facilities/:id/capabilities` |
| POST | `/directory/facilities/:id/edit-requests` |
| POST | `/directory/facilities/:id/moderation` |
| POST | `/directory/facilities/:id/services` |
| POST | `/public/directory/events` |
| POST | `/public/directory/reports` |

#### `workforce-reference.ts` (11)

| Method | Path |
|---|---|
| GET | `/reference/cadres/:code` |
| GET | `/reference/capabilities` |
| GET | `/reference/capabilities/:code` |
| GET | `/reference/departments/:code` |
| GET | `/reference/job-titles` |
| GET | `/reference/job-titles/:code` |
| GET | `/reference/onboarding/cadre-specialty` |
| GET | `/reference/payroll-grades/:code` |
| GET | `/reference/regulators` |
| GET | `/reference/regulators/:code` |
| GET | `/reference/specialties/:code` |

#### `admin.ts` (10)

| Method | Path |
|---|---|
| GET | `/admin/facility` |
| GET | `/admin/integrations` |
| GET | `/admin/invitations` |
| POST | `/admin/integrations/ai/verify` |
| POST | `/admin/integrations/dicomweb/verify` |
| POST | `/admin/invitations/:id/revoke` |
| POST | `/admin/platform-operator/elevate` |
| POST | `/admin/platform-operator/requests/:id/cancel` |
| POST | `/admin/platform-operator/requests/:id/deny` |
| POST | `/admin/platform-operator/revoke` |

#### `billing.ts` (10)

| Method | Path |
|---|---|
| GET | `/billing/invoices/:id` |
| GET | `/billing/plans` |
| GET | `/platform/billing/accounts/:id/invoices` |
| GET | `/platform/billing/invoices/:id` |
| GET | `/platform/billing/plans` |
| POST | `/billing/notifications/:id/read` |
| POST | `/billing/subscription/quote` |
| POST | `/platform/billing/plans/:id/approve` |
| POST | `/platform/billing/subscriptions/:id/status` |
| POST | `/platform/billing/usage/:id/correct` |

#### `ehmis.ts` (9)

| Method | Path |
|---|---|
| GET | `/ehmis` |
| GET | `/ehmis/eligibility-requests` |
| GET | `/ehmis/periods/:id/export` |
| POST | `/ehmis/eligibility-request` |
| POST | `/ehmis/eligibility/:tenantId/decision` |
| POST | `/ehmis/mappings/:id/approve` |
| POST | `/ehmis/mappings/:id/retire` |
| POST | `/ehmis/periods/:id/manual-submission` |
| POST | `/ehmis/periods/:id/reopen` |

#### `finance.ts` (9)

| Method | Path |
|---|---|
| GET | `/encounters/:id/billable` |
| GET | `/mobile-money/:id` |
| GET | `/payments/:id/receipt` |
| GET | `/service-catalog/:id/history` |
| POST | `/claims` |
| POST | `/invoices` |
| POST | `/invoices/:id/items/:itemId/remove` |
| POST | `/mobile-money/:id/check` |
| POST | `/service-catalog/:id/convert` |

#### `theatre.ts` (9)

| Method | Path |
|---|---|
| GET | `/theatre-cases` |
| GET | `/theatre-cases/:id` |
| GET | `/theatres` |
| POST | `/theatre-cases/:id/consent` |
| POST | `/theatre-cases/:id/counts` |
| POST | `/theatre-cases/:id/preop` |
| POST | `/theatre-cases/:id/recovery` |
| POST | `/theatre-cases/:id/specimens` |
| POST | `/theatres` |

#### `reception.ts` (8)

| Method | Path |
|---|---|
| GET | `/appointments` |
| GET | `/queues/:queueId/entries` |
| POST | `/encounters` |
| POST | `/encounters/:id/transitions` |
| POST | `/encounters/:id/triage` |
| POST | `/encounters/:id/triage/complete` |
| POST | `/queues` |
| POST | `/queues/:queueId/entries` |

#### `auth.ts` (8)

| Method | Path |
|---|---|
| GET | `/auth/organizations/search` |
| GET | `/auth/totp/dev` |
| POST | `/auth/invitations/decline` |
| POST | `/auth/invitations/status` |
| POST | `/auth/join-codes/lookup` |
| POST | `/auth/login/mfa/email` |
| POST | `/auth/register/facility` |
| POST | `/auth/verify-email/resend` |

#### `pharmacy-pos.ts` (8)

| Method | Path |
|---|---|
| GET | `/pharmacy/pos/catalog` |
| GET | `/pharmacy/pos/items/:id/lots` |
| GET | `/pharmacy/pos/patients` |
| GET | `/pharmacy/prescriptions` |
| GET | `/pharmacy/prescriptions/:id` |
| GET | `/pharmacy/reports/sales` |
| GET | `/pharmacy/sales` |
| GET | `/pharmacy/sales/:id` |

#### `credentials.ts` (7)

| Method | Path |
|---|---|
| GET | `/credentials/:id/history` |
| GET | `/credentials/facility` |
| GET | `/credentials/facility/queue` |
| GET | `/credentials/mine` |
| GET | `/uploads/:id/content` |
| POST | `/credentials` |
| POST | `/uploads` |

#### `pharmacy.ts` (7)

| Method | Path |
|---|---|
| GET | `/medication-orders` |
| GET | `/medicines` |
| GET | `/patients/:id/medication` |
| GET | `/stock/lots` |
| POST | `/medicines` |
| POST | `/stock/lots` |
| POST | `/stock/movements` |

#### `integrations.ts` (6)

| Method | Path |
|---|---|
| GET | `/integrations/patients/links` |
| GET | `/public/integrations/products` |
| POST | `/integrations/clients/:id/decision` |
| POST | `/integrations/clients/:id/revoke-tokens` |
| POST | `/integrations/products` |
| POST | `/public/integrations/oauth/token` |

#### `programmes.ts` (6)

| Method | Path |
|---|---|
| GET | `/patients/:id/programmes` |
| GET | `/programmes` |
| GET | `/programmes/:id/enrolments` |
| GET | `/public-health/reports` |
| POST | `/enrolments/:id/events` |
| POST | `/patients/:id/advance-care` |

#### `promotions.ts` (6)

| Method | Path |
|---|---|
| GET | `/promotions/campaigns` |
| GET | `/promotions/campaigns/:id/metrics` |
| GET | `/promotions/campaigns/:id/payments` |
| GET | `/promotions/packages` |
| POST | `/promotions/campaigns/:id/cancel` |
| POST | `/public/promotions/webhooks/payments` |

#### `workspace.ts` (6)

| Method | Path |
|---|---|
| GET | `/workspace` |
| GET | `/workspace/organization` |
| POST | `/workspace/organization/history` |
| POST | `/workspace/organization/withdraw` |
| POST | `/workspace/registrations` |
| POST | `/workspace/registrations/:id/status` |

#### `organizations.ts` (6)

| Method | Path |
|---|---|
| POST | `/organizations/:id/join-codes` |
| POST | `/organizations/:id/join-codes/:codeId/revoke` |
| POST | `/organizations/:id/links/:linkId/end` |
| POST | `/organizations/:id/links/:linkId/inventory-mode` |
| POST | `/organizations/:id/members/:memberId/remove` |
| POST | `/organizations/invitations/accept` |

#### `onboarding.ts` (5)

| Method | Path |
|---|---|
| GET | `/onboarding/catalogue/versions` |
| GET | `/onboarding/facilities` |
| GET | `/onboarding/proxies` |
| GET | `/onboarding/proxies/queue` |
| POST | `/onboarding/proxies/requests` |

#### `platform-observability.ts` (5)

| Method | Path |
|---|---|
| GET | `/platform/observability/api-metrics` |
| GET | `/platform/observability/integrations` |
| GET | `/platform/observability/logs` |
| GET | `/platform/observability/traces` |
| GET | `/platform/observability/workers` |

#### `procurement.ts` (5)

| Method | Path |
|---|---|
| GET | `/procurement/purchase-orders` |
| GET | `/procurement/purchase-orders/:id` |
| GET | `/procurement/suppliers` |
| POST | `/procurement/purchase-orders/:id/receive` |
| POST | `/procurement/suppliers/:id/status` |

#### `documents.ts` (4)

| Method | Path |
|---|---|
| GET | `/document-templates` |
| GET | `/document-templates/:id` |
| GET | `/documents` |
| GET | `/documents/:id` |

#### `telehealth.ts` (4)

| Method | Path |
|---|---|
| GET | `/telehealth/sessions` |
| GET | `/telehealth/sessions/:id` |
| GET | `/telehealth/sessions/:id/participants` |
| POST | `/telehealth/sessions/:id/consent` |

#### `subscription-checkout.ts` (3)

| Method | Path |
|---|---|
| GET | `/billing/subscription-checkout/quote` |
| GET | `/billing/subscription-renewal` |
| POST | `/billing/subscription-checkout/:id/cancel` |

#### `emergency.ts` (3)

| Method | Path |
|---|---|
| GET | `/emergency/cases` |
| GET | `/emergency/cases/:id` |
| POST | `/emergency/cases/:id/observations` |

#### `ai.ts` (2)

| Method | Path |
|---|---|
| GET | `/ai/jobs` |
| GET | `/ai/jobs/:id` |

#### `devices.ts` (2)

| Method | Path |
|---|---|
| GET | `/device-alerts` |
| GET | `/devices` |

#### `payment-callbacks.ts` (2)

| Method | Path |
|---|---|
| POST | `/public/payments/yo/failures` |
| POST | `/public/payments/yo/subscriptions/failures` |

#### `facility-logo.ts` (1)

| Method | Path |
|---|---|
| GET | `/logo` |

#### `clinical.ts` (1)

| Method | Path |
|---|---|
| PUT | `/entries/:id/draft` |

## 5. Interpretation

- The matrix's own bindings are now fully consistent with the mounted routes (0 stale).
- Coverage is partial: roughly half of all API routes are not yet represented. This is expected for the foundation increment and is the input to route adoption.
- No endpoint was marked exempt to avoid authorization. Exemptions remain limited to intentionally public, health, webhook, flow-token and authenticated-self flows.
- The 5 multi-claim routes preserve layered authorization; adoption must keep all applicable checks.