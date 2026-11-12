# API Route Inventory — Phase 1.2

**Date:** 2026-11-12  
**Source:** static extraction of `Hono` route registrations from `apps/api/src`  
**Method:** parse exported `Hono` instances + `app.route()` mounts; normalize by stripping the `/api/v1` prefix.

## Summary

- Routers inventoried: **51**
- Unique `METHOD path` registrations: **712**
- Dynamic (template-literal) paths flagged for manual review: **2**

| Router file | Mount prefix(es) | Routes |
|---|---|---|
| `admin.ts` | `/api/v1/admin` | 20 |
| `ai.ts` | `/api/v1` | 3 |
| `auth.ts` | `/api/v1/auth` | 21 |
| `billing.ts` | `/api/v1` | 19 |
| `care.ts` | `/api/v1` | 7 |
| `clinical.ts` | `/api/v1` | 18 |
| `consent.ts` | `/api/v1` | 8 |
| `content.ts` | `/api/v1` | 39 |
| `credentials.ts` | `/api/v1` | 10 |
| `data-exchange.ts` | `/api/v1` | 6 |
| `devices.ts` | `/api/v1` | 7 |
| `diagnostics.ts` | `/api/v1` | 23 |
| `directory.ts` | `/api/v1` | 23 |
| `documents.ts` | `/api/v1` | 13 |
| `ehmis.ts` | `/api/v1` | 19 |
| `emergency.ts` | `/api/v1` | 6 |
| `facility-logo.ts` | `/api/v1` | 3 |
| `finance.ts` | `/api/v1` | 26 |
| `inpatient.ts` | `/api/v1` | 27 |
| `integrations.ts` | `/api/v1` | 14 |
| `inventory.ts` | `/api/v1` | 51 |
| `legal.ts` | `/api/v1` | 4 |
| `maternity.ts` | `/api/v1` | 20 |
| `me.ts` | `/api/v1` | 10 |
| `notifications.ts` | `/api/v1` | 2 |
| `onboarding.ts` | `/api/v1` | 19 |
| `operations.ts` | `/api/v1` | 22 |
| `ops.ts` | `/api/v1` | 2 |
| `organization.ts` | `/api/v1` | 25 |
| `organizations.ts` | `/api/v1` | 13 |
| `patient-merge.ts` | `/api/v1` | 6 |
| `payment-callbacks.ts` | `/api/v1` | 5 |
| `pharmacy-pos.ts` | `/api/v1` | 12 |
| `pharmacy.ts` | `/api/v1` | 11 |
| `platform-observability.ts` | `/api/v1` | 8 |
| `procurement.ts` | `/api/v1` | 8 |
| `programmes.ts` | `/api/v1` | 13 |
| `promotions.ts` | `/api/v1` | 12 |
| `public.ts` | `/api/v1` | 6 |
| `radiology.ts` | `/api/v1` | 27 |
| `realtime.ts` | `/api/v1` | 2 |
| `reception.ts` | `/api/v1` | 19 |
| `reports.ts` | `/api/v1` | 2 |
| `subscription-checkout.ts` | `/api/v1` | 6 |
| `telehealth.ts` | `/api/v1` | 7 |
| `theatre.ts` | `/api/v1` | 13 |
| `workflow.ts` | `/api/v1` | 11 |
| `workforce-reference.ts` | `/api/v1` | 17 |
| `workspace.ts` | `/api/v1` | 15 |
| `fhir/router.ts` | `/` | 17 |
| `terminology/router.ts` | `/` | 15 |

## `admin.ts`

| Method | Path |
|---|---|
| GET | `/admin/memberships` |
| POST | `/admin/invitations` |
| GET | `/admin/invitations` |
| POST | `/admin/invitations/:id/revoke` |
| PATCH | `/admin/memberships/:id` |
| DELETE | `/admin/memberships/:id` |
| GET | `/admin/facility` |
| GET | `/admin/duplicate-candidates` |
| POST | `/admin/duplicate-candidates/:id/review` |
| GET | `/admin/integrations` |
| POST | `/admin/integrations/dicomweb/verify` |
| POST | `/admin/integrations/ai/verify` |
| POST | `/admin/platform-operator/elevate` |
| POST | `/admin/platform-operator/revoke` |
| GET | `/admin/platform-operator/requests` |
| POST | `/admin/platform-operator/requests` |
| POST | `/admin/platform-operator/requests/:id/approve` |
| POST | `/admin/platform-operator/requests/:id/deny` |
| POST | `/admin/platform-operator/requests/:id/cancel` |
| POST | `/admin/platform-operator/grants/:userId/revoke` |

## `ai.ts`

| Method | Path |
|---|---|
| GET | `/ai/jobs` |
| POST | `/ai/jobs` |
| GET | `/ai/jobs/:id` |

## `auth.ts`

| Method | Path |
|---|---|
| POST | `/auth/register/patient` |
| POST | `/auth/register/facility` |
| POST | `/auth/register/workspace` |
| GET | `/auth/organizations/search` |
| POST | `/auth/join-codes/lookup` |
| POST | `/auth/login` |
| POST | `/auth/login/mfa/email` |
| POST | `/auth/login/mfa` |
| POST | `/auth/logout` |
| GET | `/auth/session` |
| POST | `/auth/verify-email` |
| POST | `/auth/verify-email/resend` |
| POST | `/auth/forgot-password` |
| POST | `/auth/reset-password` |
| POST | `/auth/mfa/enroll/start` |
| POST | `/auth/mfa/enroll/verify` |
| POST | `/auth/invitations/status` |
| POST | `/auth/invitations/register` |
| POST | `/auth/invitations/accept` |
| POST | `/auth/invitations/decline` |
| GET | `/auth/totp/dev` |

## `billing.ts`

| Method | Path |
|---|---|
| GET | `/billing/status` |
| GET | `/billing/overview` |
| GET | `/billing/plans` |
| POST | `/billing/subscription/quote` |
| POST | `/billing/subscription/accept` |
| POST | `/billing/subscription/cancel` |
| POST | `/billing/subscription/resume` |
| POST | `/billing/notifications/:id/read` |
| GET | `/billing/invoices/:id` |
| GET | `/platform/billing/accounts` |
| GET | `/platform/billing/accounts/:id/invoices` |
| GET | `/platform/billing/invoices/:id` |
| POST | `/platform/billing/invoices/:id/payments` |
| POST | `/platform/billing/payments/:id/refund` |
| POST | `/platform/billing/subscriptions/:id/status` |
| POST | `/platform/billing/usage/:id/correct` |
| GET | `/platform/billing/plans` |
| POST | `/platform/billing/plans` |
| POST | `/platform/billing/plans/:id/approve` |

## `care.ts`

| Method | Path |
|---|---|
| GET | `/care/follow-ups` |
| POST | `/care/follow-ups/:id/status` |
| GET | `/care/referrals` |
| POST | `/care/referrals/:id/status` |
| GET | `/care/referral-recipients` |
| POST | `/care/referrals/:id/share` |
| POST | `/care/referrals/:id/share/revoke` |

## `clinical.ts`

| Method | Path |
|---|---|
| POST | `/encounters/:id/entries` |
| PUT | `/entries/:id/draft` |
| POST | `/entries/:id/sign` |
| POST | `/entries/:id/amendments` |
| POST | `/entries/:id/entered-in-error` |
| GET | `/entries/:id/versions` |
| POST | `/entries/:id/void` |
| POST | `/entries/:id/archive` |
| POST | `/entries/:id/attachments` |
| DELETE | `/entries/:entryId/attachments/:uploadId` |
| GET | `/encounters/:id/timeline` |
| POST | `/encounters/:id/observations` |
| POST | `/encounters/:id/conditions` |
| POST | `/encounters/:id/allergies` |
| POST | `/encounters/:id/follow-ups` |
| POST | `/encounters/:id/referrals` |
| POST | `/ai/encounters/:id/suggest` |
| GET | `/maternity/episodes/:id/alerts` |

## `consent.ts`

| Method | Path |
|---|---|
| POST | `/patients/:patientId/consents` |
| POST | `/consents/:consentId/revoke` |
| GET | `/exchange/grants` |
| GET | `/exchange/patients/:publicId/records` |
| POST | `/patients/:patientId/emergency-overrides` |
| GET | `/emergency-overrides` |
| POST | `/emergency-overrides/:id/review` |
| GET | `/emergency-overrides/:id/records` |

## `content.ts`

| Method | Path |
|---|---|
| GET | `/access/summary` |
| GET | `/dashboards/patient` |
| GET | `/dashboards/clinician` |
| GET | `/dashboards/specialist` |
| GET | `/content` |
| GET | `/content/:id` |
| POST | `/content/:id/bookmark` |
| DELETE | `/content/:id/bookmark` |
| GET | `/content/bookmarks/mine` |
| GET | `/content/preferences/mine` |
| PUT | `/content/preferences/mine` |
| POST | `/content/:id/report` |
| GET | `/opportunities` |
| POST | `/opportunities/:id/bookmark` |
| POST | `/opportunities/:id/report` |
| GET | `/content/editorial/items` |
| POST | `/content/editorial/items` |
| PATCH | `/content/editorial/items/:id` |
| POST | `/content/editorial/items/:id/review` |
| POST | `/content/editorial/items/:id/publish` |
| POST | `/content/editorial/items/:id/archive` |
| GET | `/content/sources` |
| POST | `/content/sources` |
| GET | `/content-feeds` |
| POST | `/content-feeds/:id/ingest` |
| POST | `/content-feeds/items/:id/withdraw` |
| POST | `/content-feeds/opportunities/:id/withdraw` |
| GET | `/opportunities/moderation` |
| POST | `/opportunities` |
| PATCH | `/opportunities/:id` |
| POST | `/opportunities/:id/submit` |
| POST | `/opportunities/:id/moderate` |
| GET | `/admin/role-grants` |
| POST | `/admin/role-grants` |
| POST | `/admin/role-grants/:id/decision` |
| GET | `/admin/care-team` |
| POST | `/admin/care-team` |
| POST | `/admin/care-team/:id/revoke` |
| GET | `/admin/access-review` |

## `credentials.ts`

| Method | Path |
|---|---|
| POST | `/uploads` |
| GET | `/uploads/:id/content` |
| POST | `/credentials` |
| GET | `/credentials/mine` |
| GET | `/credentials/facility` |
| GET | `/credentials/queue` |
| GET | `/credentials/facility/queue` |
| POST | `/credentials/:id/facility-decision` |
| GET | `/credentials/:id/history` |
| POST | `/credentials/:id/decision` |

## `data-exchange.ts`

| Method | Path |
|---|---|
| GET | `/data/datasets` |
| POST | `/data/import/preview` |
| POST | `/data/import` |
| POST | `/data/exports` |
| GET | `/data/exchange` |
| GET | `/data/exchange/:id/download` |

## `devices.ts`

| Method | Path |
|---|---|
| GET | `/devices` |
| POST | `/devices` |
| POST | `/devices/:id/assign` |
| POST | `/devices/:id/ingest` |
| GET | `/devices/:id/observations` |
| GET | `/device-alerts` |
| POST | `/device-alerts/:id/acknowledge` |

## `diagnostics.ts`

| Method | Path |
|---|---|
| GET | `/lab-tests` |
| POST | `/lab-tests` |
| GET | `/diagnostic-orders` |
| POST | `/diagnostic-orders` |
| GET | `/diagnostic-orders/:id` |
| POST | `/diagnostic-orders/:id/transitions` |
| POST | `/specimens` |
| PATCH | `/specimens/:id` |
| POST | `/lab-results` |
| POST | `/lab-results/:id/finalize` |
| POST | `/lab-results/:id/correct` |
| POST | `/lab-results/:id/critical-communications` |
| POST | `/imaging-studies` |
| POST | `/diagnostic-reports` |
| POST | `/diagnostic-reports/:id/correct` |
| GET | `/patients/:id/diagnostics` |
| GET | `/diagnostic-reporting/worklist` |
| POST | `/diagnostic-orders/:id/assign` |
| GET | `/critical-communications` |
| POST | `/critical-communications/:id/acknowledge` |
| POST | `/lab-results/:id/release` |
| POST | `/diagnostic-reports/:id/release` |
| GET | `/diagnostic-reporting/releasable` |

## `directory.ts`

| Method | Path |
|---|---|
| GET | `/public/directory/facilities` |
| GET | `/public/directory/facilities/:publicId` |
| GET | `/public/directory/meta` |
| GET | `/public/directory/map-config` |
| POST | `/public/directory/events` |
| POST | `/public/directory/reports` |
| GET | `/directory/providers` |
| GET | `/directory/facilities` |
| POST | `/directory/facilities` |
| PATCH | `/directory/facilities/:id` |
| POST | `/directory/facilities/:id/branches` |
| POST | `/directory/facilities/:id/services` |
| POST | `/directory/facilities/:id/capabilities` |
| POST | `/directory/facilities/:id/confirm` |
| POST | `/directory/facilities/:id/edit-requests` |
| POST | `/directory/claims` |
| GET | `/directory/claims` |
| POST | `/directory/claims/:id/decision` |
| GET | `/directory/moderation` |
| POST | `/directory/facilities/:id/moderation` |
| POST | `/directory/reports/:id/resolution` |
| POST | `/directory/duplicates/:id/review` |
| POST | `/directory/edit-requests/:id/decision` |

## `documents.ts`

| Method | Path |
|---|---|
| GET | `/document-templates` |
| POST | `/document-templates` |
| GET | `/document-templates/:id` |
| POST | `/document-templates/:id/versions` |
| POST | `/document-templates/:id/publish` |
| POST | `/document-templates/:id/retire` |
| GET | `/documents` |
| POST | `/documents` |
| GET | `/documents/:id` |
| PATCH | `/documents/:id/draft` |
| POST | `/documents/:id/sign` |
| POST | `/documents/:id/amend` |
| POST | `/documents/:id/error` |

## `ehmis.ts`

| Method | Path |
|---|---|
| GET | `/ehmis` |
| PUT | `/ehmis/settings` |
| POST | `/ehmis/eligibility-request` |
| POST | `/ehmis/credentials` |
| DELETE | `/ehmis/credentials` |
| POST | `/ehmis/connection-test` |
| POST | `/ehmis/live-submission` |
| PUT | `/ehmis/rules` |
| GET | `/ehmis/eligibility-requests` |
| POST | `/ehmis/eligibility/:tenantId/decision` |
| POST | `/ehmis/mappings` |
| POST | `/ehmis/mappings/:id/approve` |
| POST | `/ehmis/mappings/:id/retire` |
| POST | `/ehmis/periods` |
| POST | `/ehmis/periods/:id/approve` |
| POST | `/ehmis/periods/:id/reopen` |
| GET | `/ehmis/periods/:id/export` |
| POST | `/ehmis/periods/:id/manual-submission` |
| POST | `/ehmis/periods/:id/submit` |

## `emergency.ts`

| Method | Path |
|---|---|
| GET | `/emergency/cases` |
| POST | `/emergency/cases` |
| GET | `/emergency/cases/:id` |
| POST | `/emergency/cases/:id/observations` |
| POST | `/emergency/cases/:id/handoffs` |
| POST | `/emergency/cases/:id/disposition` |

## `facility-logo.ts`

| Method | Path |
|---|---|
| POST | `/logo` |
| GET | `/logo` |
| DELETE | `/logo` |

## `finance.ts`

| Method | Path |
|---|---|
| GET | `/service-catalog` |
| POST | `/service-catalog` |
| PATCH | `/service-catalog/:id` |
| GET | `/service-catalog/:id/history` |
| GET | `/billing-settings` |
| PUT | `/billing-settings` |
| POST | `/service-catalog/:id/convert` |
| POST | `/service-catalog/:id/convert/apply` |
| GET | `/encounters/:id/billable` |
| POST | `/encounters/:id/bill` |
| POST | `/invoices/:id/items/:itemId/remove` |
| GET | `/invoices` |
| POST | `/invoices` |
| GET | `/invoices/:id` |
| POST | `/invoices/:id/payments` |
| POST | `/payments/:id/reverse` |
| POST | `/payments/:id/refunds` |
| POST | `/invoices/:id/void` |
| POST | `/encounters/:id/waive` |
| POST | `/claims` |
| GET | `/finance/summary` |
| POST | `/invoices/:id/cash` |
| POST | `/invoices/:id/mobile-money` |
| GET | `/mobile-money/:id` |
| POST | `/mobile-money/:id/check` |
| GET | `/payments/:id/receipt` |

## `inpatient.ts`

| Method | Path |
|---|---|
| GET | `/directory/clinical-members` |
| GET | `/wards/dashboard` |
| GET | `/wards/:id/capacity` |
| GET | `/wards` |
| POST | `/wards` |
| PATCH | `/wards/:id` |
| POST | `/wards/:id/beds` |
| GET | `/beds` |
| PATCH | `/beds/:id/status` |
| GET | `/admissions` |
| POST | `/admissions` |
| GET | `/admissions/:id` |
| POST | `/admissions/:id/bed` |
| POST | `/admissions/:id/transition` |
| POST | `/admissions/:id/assessments` |
| POST | `/admissions/:id/tasks` |
| PATCH | `/admissions/:id/tasks/:taskId` |
| POST | `/admissions/:id/handoffs` |
| GET | `/admissions/:id/fluid-balance` |
| POST | `/admissions/:id/fluid-balance` |
| PATCH | `/admissions/:id/tasks/:taskId/assign` |
| POST | `/admissions/:id/tasks/:taskId/escalate` |
| POST | `/admissions/:id/tasks/:taskId/omit` |
| GET | `/admissions/:id/transfers` |
| POST | `/admissions/:id/administrations/:administrationId/omit` |
| POST | `/admissions/:id/medication-schedules` |
| POST | `/admissions/:id/administrations` |

## `integrations.ts`

| Method | Path |
|---|---|
| GET | `/public/integrations/products` |
| POST | `/integrations/applications` |
| GET | `/integrations/clients` |
| POST | `/integrations/clients/:id/decision` |
| POST | `/integrations/clients/:id/rotate-secret` |
| POST | `/integrations/clients/:id/revoke-tokens` |
| POST | `/public/integrations/oauth/token` |
| GET | `/integrations/directory/facilities` |
| POST | `/integrations/patients/match` |
| POST | `/integrations/patients/links` |
| GET | `/integrations/patients/links` |
| DELETE | `/integrations/patients/links/:id` |
| GET | `/integrations/products` |
| POST | `/integrations/products` |

## `inventory.ts`

| Method | Path |
|---|---|
| GET | `/inventory/items` |
| POST | `/inventory/items` |
| PATCH | `/inventory/items/:id` |
| GET | `/inventory/locations` |
| POST | `/inventory/locations` |
| GET | `/inventory/policies` |
| POST | `/inventory/policies` |
| GET | `/inventory/stock` |
| GET | `/inventory/lots` |
| GET | `/inventory/movements` |
| POST | `/inventory/receipts` |
| POST | `/inventory/issues` |
| POST | `/inventory/movements/:id/reverse` |
| POST | `/inventory/reservations` |
| POST | `/inventory/reservations/:id/release` |
| GET | `/inventory/requisitions` |
| GET | `/inventory/requisitions/:id` |
| POST | `/inventory/requisitions` |
| POST | `/inventory/requisitions/:id/submit` |
| POST | `/inventory/requisitions/:id/decision` |
| POST | `/inventory/requisitions/:id/issue` |
| GET | `/inventory/transfers` |
| GET | `/inventory/transfers/:id` |
| POST | `/inventory/transfers` |
| POST | `/inventory/transfers/:id/dispatch` |
| POST | `/inventory/transfers/:id/receive` |
| GET | `/inventory/counts` |
| POST | `/inventory/counts` |
| POST | `/inventory/counts/:id/decision` |
| GET | `/inventory/adjustments` |
| POST | `/inventory/adjustments` |
| POST | `/inventory/adjustments/:id/decision` |
| GET | `/inventory/recalls` |
| POST | `/inventory/recalls` |
| POST | `/inventory/recalls/:id/acknowledge` |
| POST | `/inventory/recalls/:id/close` |
| GET | `/inventory/assets` |
| POST | `/inventory/assets` |
| GET | `/inventory/assets/:id` |
| POST | `/inventory/assets/:id/events` |
| GET | `/inventory/reports/stock-on-hand` |
| GET | `/inventory/reports/low-stock` |
| GET | `/inventory/reports/expiry` |
| GET | `/inventory/reports/consumption` |
| GET | `/inventory/reports/valuation` |
| GET | `/inventory/reports/requisition-fulfilment` |
| GET | `/inventory/reports/transfer-discrepancies` |
| GET | `/inventory/reports/count-variance` |
| GET | `/inventory/reports/asset-downtime` |
| GET | `/inventory/reports/maintenance-due` |
| GET | `/inventory/reports/recall-status` |

## `legal.ts`

| Method | Path |
|---|---|
| GET | `/public/legal` |
| GET | `/public/legal/:kind` |
| GET | `/me/legal` |
| POST | `/me/legal/accept` |

## `maternity.ts`

| Method | Path |
|---|---|
| GET | `/maternity/episodes` |
| POST | `/maternity/episodes` |
| GET | `/maternity/episodes/:id` |
| PATCH | `/maternity/episodes/:id` |
| POST | `/maternity/episodes/:id/observations` |
| POST | `/maternity/episodes/:id/delivery` |
| POST | `/maternity/episodes/:id/newborns` |
| GET | `/maternity/episodes/:id/alerts` |
| POST | `/maternity/episodes/:id/alerts` |
| PATCH | `/maternity/newborns/:newbornId/status` |
| POST | `/maternity/newborns/:newbornId/patient` |
| GET | `/maternity/episodes/:id/antenatal-visits` |
| POST | `/maternity/episodes/:id/antenatal-visits` |
| GET | `/maternity/children/:patientId/events` |
| POST | `/maternity/children/:patientId/events` |
| GET | `/maternity/children/:patientId/immunizations` |
| POST | `/maternity/children/:patientId/immunizations` |
| GET | `/maternity/immunization-schedule` |
| GET | `/maternity/children/:patientId/immunization-due` |
| GET | `/maternity/children/:patientId/immunization-catch-up` |

## `me.ts`

| Method | Path |
|---|---|
| GET | `/me` |
| GET | `/me/facilities` |
| POST | `/me/context` |
| GET | `/me/sessions` |
| DELETE | `/me/sessions/:id` |
| GET | `/me/patient` |
| GET | `/me/records` |
| GET | `/me/appointments` |
| GET | `/me/consents` |
| GET | `/me/access-history` |

## `notifications.ts`

| Method | Path |
|---|---|
| GET | `/notifications` |
| POST | `/notifications/:id/read` |

## `onboarding.ts`

| Method | Path |
|---|---|
| GET | `/onboarding/catalogue` |
| GET | `/onboarding/facilities` |
| GET | `/onboarding/catalogue/versions` |
| POST | `/onboarding/catalogue/publish` |
| POST | `/onboarding/catalogue/:id/publish` |
| GET | `/onboarding/credential-requirements` |
| GET | `/onboarding/credential-policies` |
| POST | `/onboarding/credential-policies` |
| GET | `/onboarding/affiliations/mine` |
| POST | `/onboarding/custom-titles` |
| GET | `/onboarding/custom-titles/mine` |
| GET | `/onboarding/custom-titles/queue` |
| POST | `/onboarding/custom-titles/:id/decision` |
| GET | `/onboarding/me` |
| POST | `/onboarding/proxies/requests` |
| GET | `/onboarding/proxies` |
| GET | `/onboarding/proxies/mine` |
| GET | `/onboarding/proxies/queue` |
| POST | `/onboarding/proxies/:id/decision` |

## `operations.ts`

| Method | Path |
|---|---|
| GET | `/operations/beds` |
| POST | `/operations/beds/:id/readiness` |
| GET | `/housekeeping/tasks` |
| POST | `/housekeeping/tasks` |
| POST | `/housekeeping/tasks/:id/transition` |
| GET | `/porter/tasks` |
| POST | `/porter/tasks` |
| POST | `/porter/tasks/:id/transition` |
| GET | `/mortuary/cases` |
| POST | `/mortuary/cases` |
| GET | `/mortuary/cases/:id` |
| POST | `/mortuary/cases/:id/movements` |
| POST | `/mortuary/cases/:id/effects` |
| POST | `/mortuary/cases/:id/release` |
| GET | `/technical/assets` |
| POST | `/technical/assets` |
| GET | `/technical/work-orders` |
| POST | `/technical/work-orders` |
| POST | `/technical/work-orders/:id/transition` |
| GET | `/technical/cssd-cycles` |
| POST | `/technical/cssd-cycles` |
| POST | `/technical/cssd-cycles/:id/release` |

## `ops.ts`

| Method | Path |
|---|---|
| GET | `/health/ready` |
| GET | `/ops/status` |

## `organization.ts`

| Method | Path |
|---|---|
| GET | `/organization/departments` |
| POST | `/organization/departments` |
| PATCH | `/organization/departments/:id` |
| POST | `/organization/catalogue` |
| GET | `/organization/units` |
| POST | `/organization/departments/:id/units` |
| GET | `/organization/locations` |
| POST | `/organization/units/:id/locations` |
| GET | `/organization/cadres` |
| POST | `/organization/cadres` |
| GET | `/organization/job-titles` |
| POST | `/organization/job-titles` |
| GET | `/workforce/staff` |
| GET | `/workforce/summary` |
| GET | `/workforce/onboarding` |
| POST | `/workforce/onboarding` |
| GET | `/workforce/onboarding/:id` |
| PATCH | `/workforce/onboarding/:id` |
| POST | `/workforce/onboarding/:id/decision` |
| POST | `/workforce/engagements/:id/assignments` |
| GET | `/workforce/privileges` |
| POST | `/workforce/engagements/:id/privileges` |
| GET | `/workforce/privilege-grants` |
| POST | `/workforce/privilege-grants/:id/decision` |
| POST | `/workforce/engagements/:id/training` |

## `organizations.ts`

| Method | Path |
|---|---|
| GET | `/organizations` |
| POST | `/organizations` |
| GET | `/organizations/:id` |
| POST | `/organizations/:id/sites` |
| POST | `/organizations/:id/join-codes` |
| POST | `/organizations/:id/join-codes/:codeId/revoke` |
| POST | `/organizations/:id/links/:linkId/decision` |
| POST | `/organizations/:id/links/:linkId/inventory-mode` |
| POST | `/organizations/:id/links/:linkId/end` |
| POST | `/organizations/:id/invitations` |
| POST | `/organizations/invitations/accept` |
| POST | `/organizations/:id/members/:memberId/remove` |
| GET | `/organizations/:id/reports/summary` |

## `patient-merge.ts`

| Method | Path |
|---|---|
| POST | `/patient-merges` |
| GET | `/patient-merges` |
| POST | `/patient-merges/:id/approve` |
| POST | `/patient-merges/:id/reject` |
| POST | `/patient-merges/:id/reverse` |
| GET | `/patients/:id/identity` |

## `payment-callbacks.ts`

| Method | Path |
|---|---|
| POST | `/public/payments/yo/notifications` |
| POST | `/public/payments/yo/failures` |
| POST | `/public/payments/livepay/webhook` |
| POST | `/public/payments/yo/subscriptions` |
| POST | `/public/payments/yo/subscriptions/failures` |

## `pharmacy-pos.ts`

| Method | Path |
|---|---|
| GET | `/pharmacy/pos/catalog` |
| GET | `/pharmacy/pos/items/:id/lots` |
| GET | `/pharmacy/pos/patients` |
| POST | `/pharmacy/prescriptions` |
| GET | `/pharmacy/prescriptions` |
| GET | `/pharmacy/prescriptions/:id` |
| POST | `/pharmacy/prescriptions/:id/cancel` |
| POST | `/pharmacy/sales` |
| POST | `/pharmacy/sales/:id/void` |
| GET | `/pharmacy/sales` |
| GET | `/pharmacy/sales/:id` |
| GET | `/pharmacy/reports/sales` |

## `pharmacy.ts`

| Method | Path |
|---|---|
| GET | `/medicines` |
| POST | `/medicines` |
| GET | `/medication-orders` |
| POST | `/medication-orders` |
| POST | `/medication-orders/:id/review` |
| GET | `/stock/lots` |
| POST | `/stock/lots` |
| POST | `/stock/movements` |
| POST | `/dispenses` |
| POST | `/medication-administrations` |
| GET | `/patients/:id/medication` |

## `platform-observability.ts`

| Method | Path |
|---|---|
| GET | `/platform/observability/overview` |
| GET | `/platform/observability/api-metrics` |
| GET | `/platform/observability/workers` |
| GET | `/platform/observability/logs` |
| GET | `/platform/observability/traces` |
| GET | `/platform/observability/jobs` |
| GET | `/platform/observability/integrations` |
| GET | `/platform/observability/security` |

## `procurement.ts`

| Method | Path |
|---|---|
| GET | `/procurement/suppliers` |
| POST | `/procurement/suppliers` |
| POST | `/procurement/suppliers/:id/status` |
| GET | `/procurement/purchase-orders` |
| GET | `/procurement/purchase-orders/:id` |
| POST | `/procurement/purchase-orders` |
| POST | `/procurement/purchase-orders/:id/action` |
| POST | `/procurement/purchase-orders/:id/receive` |

## `programmes.ts`

| Method | Path |
|---|---|
| GET | `/programmes` |
| POST | `/programmes` |
| GET | `/programmes/:id/enrolments` |
| POST | `/programmes/:id/enrolments` |
| POST | `/enrolments/:id/care-plans` |
| PUT | `/care-plans/:id` |
| POST | `/enrolments/:id/events` |
| GET | `/patients/:id/programmes` |
| POST | `/patients/:id/advance-care` |
| POST | `/public-health/reports` |
| GET | `/public-health/reports` |
| POST | `/public-health/reports/:id/review` |
| POST | `/public-health/reports/:id/release` |

## `promotions.ts`

| Method | Path |
|---|---|
| GET | `/promotions/packages` |
| POST | `/promotions/packages` |
| GET | `/promotions/campaigns` |
| POST | `/promotions/campaigns` |
| POST | `/promotions/campaigns/:id/payments` |
| GET | `/promotions/campaigns/:id/payments` |
| POST | `/promotions/payments/:id/confirm` |
| POST | `/promotions/campaigns/:id/decision` |
| POST | `/promotions/campaigns/:id/pause` |
| POST | `/promotions/campaigns/:id/cancel` |
| GET | `/promotions/campaigns/:id/metrics` |
| POST | `/public/promotions/webhooks/payments` |

## `public.ts`

| Method | Path |
|---|---|
| GET | `/public/facilities` |
| GET | `/public/config` |
| POST | `/public/terminology/status` |
| GET | `/public/terminology/status` |
| GET | `/public/ai/status` |
| GET | `/health/live` |

## `radiology.ts`

| Method | Path |
|---|---|
| GET | `/radiology/catalogue` |
| GET | `/radiology/templates` |
| POST | `/radiology/templates` |
| POST | `/radiology/studies` |
| POST | `/radiology/studies/:id/acquisition` |
| GET | `/radiology/worklist` |
| POST | `/radiology/reports` |
| GET | `/radiology/reports/:id` |
| PUT | `/radiology/reports/:id/draft` |
| POST | `/radiology/reports/:id/sign` |
| POST | `/radiology/reports/:id/corrections` |
| POST | `/radiology/reports/:id/addenda` |
| POST | `/radiology/reports/:id/release` |
| POST | `/radiology/reports/:id/critical-communications` |
| GET | `/radiology/critical-communications` |
| POST | `/radiology/critical-communications/:id/acknowledge` |
| POST | `/radiology/critical-communications/:id/escalate` |
| GET | `/radiology/clinical-recipients` |
| GET | `/radiology/orders/:orderItemId/report` |
| GET | `/radiology/images/status` |
| GET | `/radiology/studies/:id` |
| GET | `/radiology/studies/:id/pacs-candidates` |
| POST | `/radiology/studies/:id/pacs-link` |
| POST | `/radiology/studies/:id/pacs-unlink` |
| GET | `/radiology/studies/:id/images` |
| GET | `/radiology/studies/:id/images/series/:seriesUid` |
| GET | `/radiology/studies/:id/images/series/:seriesUid/instances/:instanceUid/frames/:frame` |

## `realtime.ts`

| Method | Path |
|---|---|
| POST | `/realtime/tickets` |
| GET | `/realtime/connect` |

## `reception.ts`

| Method | Path |
|---|---|
| POST | `/reception/patients` |
| POST | `/patients/enroll` |
| POST | `/patients/resolve` |
| GET | `/patients/search` |
| GET | `/patients/recent` |
| GET | `/appointments` |
| POST | `/appointments` |
| PATCH | `/appointments/:id` |
| POST | `/appointments/:id/status` |
| GET | `/queues` |
| POST | `/queues` |
| POST | `/queues/:queueId/entries` |
| GET | `/queues/:queueId/entries` |
| POST | `/encounters` |
| GET | `/encounters/worklist` |
| GET | `/encounters/:id` |
| POST | `/encounters/:id/transitions` |
| POST | `/encounters/:id/triage` |
| POST | `/encounters/:id/triage/complete` |

## `reports.ts`

| Method | Path |
|---|---|
| GET | `/reports` |
| GET | `/reports/:id` |

## `subscription-checkout.ts`

| Method | Path |
|---|---|
| GET | `/billing/subscription-checkout/quote` |
| POST | `/billing/subscription-checkout` |
| GET | `/billing/subscription-checkout/:id` |
| POST | `/billing/subscription-checkout/:id/check` |
| POST | `/billing/subscription-checkout/:id/cancel` |
| GET | `/billing/subscription-renewal` |

## `telehealth.ts`

| Method | Path |
|---|---|
| GET | `/telehealth/sessions` |
| POST | `/telehealth/sessions` |
| GET | `/telehealth/sessions/:id` |
| POST | `/telehealth/sessions/:id/consent` |
| POST | `/telehealth/sessions/:id/join` |
| POST | `/telehealth/sessions/:id/complete` |
| GET | `/telehealth/sessions/:id/participants` |

## `theatre.ts`

| Method | Path |
|---|---|
| GET | `/theatres` |
| POST | `/theatres` |
| GET | `/theatre-cases` |
| POST | `/theatre-cases` |
| GET | `/theatre-cases/:id` |
| POST | `/theatre-cases/:id/preop` |
| POST | `/theatre-cases/:id/consent` |
| POST | `/theatre-cases/:id/checklist` |
| POST | `/theatre-cases/:id/anesthesia` |
| POST | `/theatre-cases/:id/recovery` |
| POST | `/theatre-cases/:id/counts` |
| POST | `/theatre-cases/:id/specimens` |
| POST | `/theatre-cases/:id/transitions` |

## `workflow.ts`

| Method | Path |
|---|---|
| GET | `/encounters/:id/workflow` |
| POST | `/encounters/:id/recommendations` |
| GET | `/recommendations/:id` |
| PATCH | `/recommendations/:id` |
| POST | `/recommendations/:id/transitions` |
| GET | `/work-queues` |
| GET | `/work-queues/:department` |
| POST | `/encounters/:id/supplies` |
| POST | `/supplies/:id/void` |
| GET | `/visits/board` |
| GET | `/entries/:id/integrity` |

## `workforce-reference.ts`

| Method | Path |
|---|---|
| GET | `/reference/cadres` |
| GET | `/reference/cadres/:code` |
| GET | `/reference/job-titles` |
| GET | `/reference/job-titles/:code` |
| GET | `/reference/specialties` |
| GET | `/reference/specialties/:code` |
| GET | `/reference/departments` |
| GET | `/reference/departments/:code` |
| GET | `/reference/regulators` |
| GET | `/reference/regulators/:code` |
| GET | `/reference/capabilities` |
| GET | `/reference/capabilities/:code` |
| GET | `/reference/payroll-grades` |
| GET | `/reference/payroll-grades/:code` |
| GET | `/reference/admin/catalogue` |
| GET | `/reference/onboarding/cadre-specialty` |
| POST | `/reference/onboarding/validate-specialty` |

## `workspace.ts`

| Method | Path |
|---|---|
| GET | `/workspace` |
| PUT | `/workspace/profile` |
| PUT | `/workspace/modules` |
| POST | `/workspace/registrations` |
| POST | `/workspace/registrations/:id/status` |
| GET | `/workspace/organization` |
| POST | `/workspace/organization/link-request` |
| POST | `/workspace/organization/withdraw` |
| POST | `/workspace/organization/history` |
| POST | `/workspace/organization/inventory-mode` |
| POST | `/workspace/organization/end` |
| GET | `/workspace/shared-supply` |
| POST | `/workspace/shared-supply/transfers` |
| POST | `/workspace/shared-supply/transfers/:id/receive` |
| POST | `/workspace/shared-supply/transfers/:id/cancel` |

## `fhir/router.ts`

| Method | Path |
|---|---|
| GET | `/fhir/r4/metadata` |
| GET | `/fhir/r4/Patient` |
| GET | `/fhir/r4/Patient/:id` |
| GET | `/fhir/r4/Organization/:id` |
| GET | `/fhir/r4/Organization` |
| GET | `/fhir/r4/Practitioner/:id` |
| GET | `/fhir/r4/Practitioner` |
| GET | `/fhir/r4/PractitionerRole/:id` |
| GET | `/fhir/r4/DocumentReference` |
| GET | `/fhir/r4/DocumentReference/:id` |
| GET | `/fhir/r4/Provenance` |
| GET | `/fhir/r4/Provenance/:id` |
| GET | `/fhir/r4/Consent` |
| GET | `/fhir/r4/Consent/:id` |
| GET | `/fhir/r4/AuditEvent` |
| GET | `/fhir/r4/AuditEvent/:id` |
| ALL | `/fhir/r4/*` |

## `terminology/router.ts`

| Method | Path |
|---|---|
| GET | `/terminology/fhir/r4/metadata` |
| GET | `/terminology/fhir/r4/CodeSystem/$lookup` |
| POST | `/terminology/fhir/r4/CodeSystem/$lookup` |
| GET | `/terminology/fhir/r4/CodeSystem/$validate-code` |
| POST | `/terminology/fhir/r4/CodeSystem/$validate-code` |
| GET | `/terminology/fhir/r4/ValueSet/$expand` |
| POST | `/terminology/fhir/r4/ValueSet/$expand` |
| GET | `/terminology/fhir/r4/ValueSet/$validate-code` |
| POST | `/terminology/fhir/r4/ValueSet/$validate-code` |
| GET | `/terminology/fhir/r4/ConceptMap/$translate` |
| POST | `/terminology/fhir/r4/ConceptMap/$translate` |
| GET | `/terminology/fhir/r4/*` |
| GET | `/terminology/search` |
| GET | `/terminology/fields` |
| GET | `/terminology/autocomplete` |

## Dynamic paths (manual review)

- `fhir/router.ts` GET `/fhir/r4/${resourceType}`
- `fhir/router.ts` GET `/fhir/r4/${resourceType}/:id`
