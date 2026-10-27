# Current state audit

Audit date: 2026-10-28. Branch `master`, clean working tree at `fddecc4` before this work. All data in every environment is synthetic.

## Repository and stack

| Area | Actual implementation |
|---|---|
| Web | React 19 + Vite + TypeScript SPA (`apps/web`, 52 pages), `react-router-dom` 7.18.5 |
| API | Hono on Node (`apps/api/src/server.ts`) locally and Cloudflare Workers (`apps/api/src/worker.ts`) in staging; 413 route handlers across 29 route modules |
| Jobs | Outbox drain and signed integrity checkpoints (`apps/jobs`), run by the Worker cron every 5 minutes in staging |
| Database | PostgreSQL with forced row-level security and separate `medveris_migrator`, `medveris_runtime`, `medveris_jobs` roles; 22 forward-only migrations in `packages/db/migrations` |
| Shared packages | `contracts` (zod request schemas), `domain` (state machines, IDs), `authz` (role checks), `auth` (password, TOTP, crypto), `db`, `ui` |
| Tests | Vitest unit (10 files) and PostgreSQL integration (12 files); Playwright browser journeys (7 specs) |

## Environments

| Environment | State | Evidence |
|---|---|---|
| Local | Working | `npm run dev`; local PostgreSQL; `.mail-sink` email; local file storage |
| Staging | Deployed and healthy | Worker `medveris-staging` on workers.dev, Hyperdrive (caching disabled) to an isolated Aiven PostgreSQL `medveris_staging`, private R2 bucket, Resend email from `medveris.online`, blue-green releases via `npm run deploy:staging` |
| Production | Does not exist | No production environment is configured; none was created or deployed |

## Authentication, tenancy and authorization

- Session cookie (HttpOnly, SameSite Strict) plus in-memory CSRF token; staff require TOTP MFA (`requireStaff`); patients do not.
- Every staff request carries one active facility; queries filter on `tenant_id` and RLS enforces tenant isolation (`tests/integration/rls.test.ts`).
- Roles are server-side membership roles; the client never supplies its role.

## Defects found and fixed during this audit

| Defect | Impact | Fix |
|---|---|---|
| `POST /patients/resolve` answered a failed identity confirmation with HTTP 404 and rejected IDs typed in lowercase, with spaces or with look-alike characters | Reception saw "failed to load resource" errors and could not find patients unless the ID was typed exactly | Typed IDs are canonicalised; non-matches return `200 {matched:false}`; new audited facility-scoped search (`GET /patients/search`) |
| Feature flags (`FEATURE_DEVICES`, `FEATURE_AI`, `FEATURE_TELEMEDICINE`) enabled code paths with no adapter behind them | Setting a flag stored manually posted readings as device observations, queued AI jobs no provider would process, and reported telehealth media as configured | Server-authoritative integration registry; a flag without a verified adapter reports `misconfigured` and the operation is refused |
| Imaging studies could be recorded with PACS state `pending`, `reconciled` or `quarantined` | Implied PACS connectivity that does not exist | Server refuses any PACS state other than `not-configured` while DICOMweb is unavailable; UI disables those options |
| Staff without MFA saw 403s on every facility page (fixed earlier today) | New facility admins could not use the app | `/mfa-setup` enrolment page and redirect |
| `react-router` advisories including open redirect via `<Link>`/`useNavigate` (GHSA-wrjc-x8rr-h8h6) | Shipped client bundle | Upgraded to 7.18.5; production `npm audit` reports 0 vulnerabilities |

See `FEATURE_GAP_MATRIX.md` for every module's status and `IMPLEMENTATION_LOG.md` for evidence.
