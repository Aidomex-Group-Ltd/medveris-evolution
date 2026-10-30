# Implementation log

## 2026-10-28 — patient lookup, integration registry, dependency fix

### Changes

| Change | Files |
|---|---|
| Typed public IDs canonicalised (case, spaces, dashes, O→0, I/L→1) | `packages/contracts/src/index.ts` |
| `POST /patients/resolve` returns `200 {matched, patient, message}`; dates as `YYYY-MM-DD` | `apps/api/src/routes/reception.ts` |
| `GET /patients/search` (facility-linked patients only, prefix match on name/ID/MRN, optional DOB, paginated, rate-limited, audited without the search term) | `apps/api/src/routes/reception.ts`, `apps/api/src/lib/http.ts` (`parseQuery`) |
| Reception UI: no-match notice, facility search with paging and select | `apps/web/src/pages/PatientsPage.tsx` |
| Server-authoritative integration registry and typed `integration_unavailable` refusal | `apps/api/src/integrations/registry.ts` |
| Telehealth join, AI jobs, device ingestion and PACS state gated by the registry | `routes/telehealth.ts`, `routes/ai.ts`, `routes/devices.ts`, `routes/diagnostics.ts` |
| Admin integration table shows state, reason, effect, missing prerequisites, verification and remediation; PACS options disabled | `apps/web/src/pages/AdminPage.tsx`, `apps/web/src/pages/OrderDetailPage.tsx` |
| `react-router-dom` 7.9.4 → 7.18.5 | `apps/web/package.json`, `package-lock.json` |

No database migration was added. No integration was enabled.

### Tests written first (TDD)

`tests/integration/patients.test.ts` lookup suite failed 4/4 before the change (missing `matched`, 422 for typed IDs, 404 for non-match, 404 for search) and passed 6/6 after. Device, PACS, telehealth and AI assertions in `tests/integration/departments.test.ts` were changed from accepting flag-enabled behaviour to requiring refusal.

### Verification commands and results

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | no errors |
| `npx eslint <changed files> --max-warnings=0` | 0 | no warnings |
| `npm test` | 0 | 21 files, 159 tests passed, 0 skipped (unit + PostgreSQL integration, local database) |
| `npx playwright test` | 0 | 21 browser tests passed, 0 skipped, 0 flaky (local stack) |
| `npm audit --omit=dev` | 0 | 0 vulnerabilities in production dependencies |
| `npm audit` | 1 | 8 advisories in dev tooling only (vitest, wrangler/miniflare/undici, concurrently/shell-quote, esbuild) |
| `npm run deploy:staging` | see release section | blue-green release |

### Not done in this pass

Structured radiology templates, authorized patient merge, reports framework, separate §16 roles, concurrency tests for bed allocation and dispensing, browser journeys A–G, backup restore drill and legal review. Status and next actions are in `FEATURE_GAP_MATRIX.md`.

## 2026-10-28 — Scalability, real-time and resilience layer

Added multi-layer caching (allowlisted public routes only), primary/replica read routing with lag-aware health and read-your-writes, a tenant shard directory (migration 030) with freeze and move tooling, Cloudflare Queues relay and consumers on top of the transactional outbox, authenticated WebSockets on Durable Objects, Durable Object rate limiting, timeouts/retries/circuit breakers, database outage handling and privacy-safe telemetry. Design, status (VERIFIED/PARTIAL/BLOCKED), measurements and risks: `SCALABILITY_AND_RESILIENCE.md`; procedures: `RESILIENCE_RUNBOOK.md`. Not deployed: staging needs the two queues, migration 030 and one `--apply-durable-object-migrations` release; production remains blocked.

## 2026-10-29 — Autonomous workspaces, organizations, purchasing, eHMIS/DHIS2 reporting and DICOMweb PACS

Design, rules, sources and outstanding approvals: `docs/21_WORKSPACES_ORGANIZATIONS_AND_EHMIS.md`.

### Changes

| Change | Files |
|---|---|
| Category, official level, Medveris equivalent and level status kept separate, with recommendations | `packages/domain/src/facility-classification.ts`, migration `032` |
| Three onboarding paths (independent, new organization, join with a code) | `routes/auth.ts` (`POST /auth/register/workspace`), `services/workspaces.ts`, `components/WorkspaceSignup.tsx`, `components/LevelFields.tsx` |
| Workspace profile, licences/registry IDs, modules, level history, organization link, shared supply | `routes/workspace.ts`, `pages/WorkspacePage.tsx` |
| Organizations: sites, join codes, duplicate-checked approvals, history visibility, inventory-mode proposals, members, consolidated reports | `routes/organizations.ts`, `pages/OrganizationsPage.tsx` |
| Scoped roles `owner`, `department_admin`, `unit_lead`, `staff`, `report_viewer`; scoped invitations and membership management; last-owner protection | `packages/authz`, `routes/admin.ts`, `services/invitations.ts`, `lib/scope.ts`, `pages/AdminPage.tsx` |
| Department/unit attribution of encounters and invoices; department report filter and `department-operations` report | `routes/reception.ts`, `routes/finance.ts`, `reports/definitions.ts`, `routes/reports.ts` |
| Suppliers and purchase orders received into the stock ledger with lots and expiry | `routes/procurement.ts`, `pages/ProcurementPage.tsx` |
| Facility-scoped eHMIS/DHIS2 aggregate reporting with platform-verified eligibility, mappings, validation, export, idempotent live submission and ledger | `routes/ehmis.ts`, `services/ehmis.ts`, `integrations/dhis2.ts`, `packages/domain/src/hmis.ts`, migration `033`, `pages/EhmisPage.tsx` |
| DICOMweb PACS adapter with recorded conformance runs, study search and linking with identity comparison, rendered frames | `integrations/dicomweb.ts`, `integrations/verification.ts`, `routes/radiology.ts`, migration `031`, `components/PacsImagesPanel.tsx` |
| Registry: DICOMweb implemented (available only after a passing run), eHMIS facility-scoped, NHFR listed as unavailable | `integrations/registry.ts` |

### Tests

New: `tests/unit/facility-classification.test.ts` (10), `tests/integration/workspaces.test.ts` (11), `tests/integration/ehmis.test.ts` (8, fake DHIS2 server), `tests/integration/pacs.test.ts` (fake PACS). `tests/e2e/registration.spec.ts` now onboards a standalone drug shop.

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | no errors |
| `npm run lint` | 0 | no warnings |
| `npm test` | 0 | 48 files, 439 tests passed (local PostgreSQL 14, schema rebuilt from all 33 migrations) |
| `npx playwright test tests/e2e/registration.spec.ts` | 0 | 5 passed |
| `npm run build:web` | 0 | built |

No integration was enabled. eHMIS live submission needs the Ministry authorization and configuration listed in the design document; NHFR has no interface.

## 2026-10-29 — Self-onboarding, unit workspaces, organization patient workflow, price list and point of sale with Yo! mobile money

### Changes

| Change | Files |
|---|---|
| Dropdown onboarding (Independent workspace / New organization or hospital / Join an organization) as a stepper with per-step validation, review and recovery; join by organization search or join-code lookup, or hand-off to a staff invitation; the new owner is signed in and sent to two-step verification, then the unit dashboard | `components/WorkspaceSignup.tsx`, `routes/auth.ts` (`/register/workspace`, `/organizations/search`, `/join-codes/lookup`), `services/workspaces.ts` |
| Standalone laboratory, imaging, pharmacy and drug-shop owners receive the unit's bench role plus reception and cashier; no prescribing, signing or reporting role is self-granted | `services/workspaces.ts` (`unitOwnerRoles`) |
| Last workspace remembered (`users.last_active_tenant_id`) and reopened at sign-in; `/me` carries the workspace's category, modules and organization link; navigation follows enabled modules and hides organization screens for independent workspaces; unit dashboards | `auth/session.ts`, `routes/me.ts`, `components/AppShell.tsx`, `lib/workspace.ts`, `pages/DashboardPage.tsx` |
| Recommendations from the consultation routed to laboratory, imaging, theatre, pharmacy or procedure queues; department progress with version checks; supplied items; append-only event trail; reception visit board; role-filtered fields (instructions for clinicians and the receiving department, prices for cashiers, department-only staff see only their own work) | `routes/workflow.ts`, `packages/domain/src/workflow.ts`, `packages/authz`, `components/VisitWorkflowPanel.tsx`, `pages/WorkQueuePage.tsx`, `pages/VisitsPage.tsx`, `pages/EncounterPage.tsx` |
| Consultation note integrity check: content digests recomputed, audit events located in their signed Merkle checkpoint, root and HMAC signature recomputed, anchoring reported as recorded; entered-in-error from the note panel | `routes/workflow.ts` (`/entries/:id/integrity`), `packages/domain/src/integrity.ts`, `components/ClinicalNotePanel.tsx` |
| Price list for services, procedures, supplies and pharmacy items with department, price, currency, active flag and versioned edits | `routes/finance.ts` (`/service-catalog`), `pages/PriceListPage.tsx` |
| Bills built from a visit's recommended, completed and supplied work, each charged once; line removal only while unpaid | `routes/finance.ts` (`/encounters/:id/billable`, `/encounters/:id/bill`, `/invoices/:id/items/:itemId/remove`), `services/billing.ts`, `pages/PointOfSalePage.tsx` |
| Point of sale: total, paid, balance; cash with change and idempotency; Yo! mobile money prompt with live status, status checks and signature-verified notifications; receipts | `routes/finance.ts` (`/invoices/:id/cash`, `/invoices/:id/mobile-money`, `/mobile-money/:id/check`, `/payments/:id/receipt`), `routes/payment-callbacks.ts`, `integrations/yo.ts`, `services/mobile-money.ts`, `pages/InvoiceDetailPage.tsx`, `pages/ReceiptPage.tsx` |
| Payments registry entry implemented (available when requested and configured); production gate allows `FEATURE_PAYMENTS=true` only with `YO_MODE=production` and the Yo! secrets declared; reconciliation report counts Yo!-confirmed payments | `integrations/registry.ts`, `scripts/production-gate.mjs`, `reports/definitions.ts`, `wrangler.jsonc`, `.env.example` |
| Migration `034_workflow_billing_mobile_money.sql` (additive) | `packages/db/migrations` |
| Login slogan changed to “Independent, affordable & Secure” | `pages/LoginPage.tsx` |

### Tests

New: `tests/unit/yo.test.ts` (7), `tests/integration/workflow-payments.test.ts` (13, fake Yo! gateway and a generated RSA key pair), e2e laboratory-owner landing and onboarding-path tests in `tests/e2e/registration.spec.ts`.

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | no errors |
| `npm run lint` | 0 | no warnings |
| `npm test` | 0 | 50 files, 461 tests passed after updating the reconciliation CSV header expectation |
| Fresh database from all 34 migrations | 0 | applied, no schema integrity problems |
| `npx playwright test` | 1 → 0 | 35 tests; 31 passed on the full run. Journey G and patient lookup were updated (removed "no online payment" text; a row locator matched two tables); the care-coordination and invitation tests failed only under concurrent database load and passed when rerun |
| `npm run build:web`, `npm run build:api` | 0 | built |

Mobile money stays disabled in every environment until `FEATURE_PAYMENTS`, `YO_MODE` and the Yo! credentials and public certificate are configured.

## 2026-10-30 — Credential expiry, operational notification inbox and FHIR facade acceptance tests

### Changes

| Change | Files |
|---|---|
| Effective credential status is computed at request time: a verified credential whose `expires_on` has passed reads as `expired` without mutating the reviewed row, and re-verification of an expired credential requires a future expiry date (AT25) | `routes/credentials.ts`, `tests/integration/onboarding.test.ts` |
| Durable operational notification inbox for low stock and lots nearing expiry: per-recipient rows, stable daily dedupe keys, acknowledgement with audit, and recipient-only row-level security | `routes/notifications.ts`, `packages/db/migrations/038_notifications.sql`, `tests/integration/notifications.test.ts` |
| The jobs cron scans inventory every five minutes and enqueues notifications through a `SECURITY DEFINER` function owned by `medveris_exchange`, so the jobs role needs no broad inventory grants | `apps/jobs/src/cycle.ts`, `packages/db/migrations/038_notifications.sql` |
| FHIR R4 facade acceptance coverage for `/metadata`, read/search projections, OperationOutcome errors, write rejection and cross-tenant isolation (AT27–AT28) | `tests/integration/fhir.test.ts` |
| Gap matrix records BK07 and BK11 as Verified and BK16 as Partial with AT27–AT28 evidenced and AT29–AT31 terminology validation remaining | `docs/implementation/GAP_MATRIX.md` |
| Deterministic ordering for the eHMIS submission ledger when a dry run and its import finish in the same transaction | `apps/api/src/routes/ehmis.ts` |

### Tests

New: `tests/integration/notifications.test.ts` (4), `tests/integration/fhir.test.ts` (7); `tests/integration/onboarding.test.ts` adds the AT25 expiry case.

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | no errors |
| `npm run lint` | 0 | no warnings |
| `npm test` | 0 | 53 files, 485 tests passed |
| `npm run build` | 0 | web and API bundles built |

Notifications remain pull-only until a facility configures inventory thresholds; no external delivery channel is claimed.


## 2026-10-30 — Contextual terminology, laboratory ConceptMaps and device metric validation

### Changes

| Change | Files |
|---|---|
| Reviewed laboratory ConceptMaps now carry specimen, method and UCUM unit context; `$translate` only returns a match when the submitted context matches, and unapproved draft maps are refused | `apps/api/src/terminology/{types,synthetic,router}.ts` |
| Added synthetic LOINC serum glucose (`2345-7`) and a serum-specific local laboratory map; unknown codes, inactive codes and superseded releases fail validation with explicit messages | `apps/api/src/terminology/synthetic.ts` |
| Laboratory test and device metric registration validate LOINC identity and UCUM units through the terminology facade; fabricated codes and non-UCUM units are rejected before storage | `apps/api/src/routes/diagnostics.ts`, `apps/api/src/routes/devices.ts`, `apps/api/src/services/clinical.ts` |
| Production terminology adapter accepts contextual translate input and keeps fail-closed behaviour; timeout and unlicensed/unauthorised upstream responses become dependency errors, never fabricated results | `apps/api/src/terminology/production.ts` |
| AT29–AT31 acceptance coverage: contextual search, inactive/fabricated/superseded codes, signed observation version stability, reviewed and unapproved ConceptMaps, UCUM validation and upstream failure | `tests/integration/terminology.test.ts`, `tests/unit/terminology-production.test.ts` |
| Gap matrix records BK16 and BK18 as Verified and BK12 device mapping validation as partial evidence | `docs/implementation/GAP_MATRIX.md` |

### Tests

New: `tests/integration/terminology.test.ts` (7), `tests/unit/terminology-production.test.ts` (3); existing FHIR, departments, terminology-unavailable and integration-registry suites re-run.

| Command | Exit | Result |
|---|---|---|
| `npx vitest run tests/integration/terminology.test.ts` | 0 | 7 tests passed |
| `npx vitest run tests/unit/terminology-production.test.ts` | 0 | 3 tests passed |
| `npx vitest run tests/integration/{departments,fhir}.test.ts tests/unit/{terminology-unavailable,integration-registry}.test.ts` | 0 | 28 tests passed |
| `npm run typecheck` | 0 | no errors |
| `npm run lint` | 0 | no warnings |
| `npm test` | 0 | 55 files, 495 tests passed |
| `npm run build` | 0 | web and API bundles built |

Terminology remains synthetic in development and unavailable in production until a licensed provider is configured; no unapproved mapping is applied automatically.
