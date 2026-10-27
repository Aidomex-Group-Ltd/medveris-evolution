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
