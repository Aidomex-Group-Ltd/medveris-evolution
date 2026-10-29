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
