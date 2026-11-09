# Medveris Repository Handoff Summary

**Generated:** 2026-10-31
**Current Branch:** master
**Last Commit:** cadc7cd feat: pharmacy POS, patient enrolment, PACS/DICOMweb and LivePay config

## 📊 Repository State

### Git Status
- **Modified files:** `.gitignore` (added `+.aider*`)
- **Untracked:** `.claude/` directory
- **Clean:** Core implementation files

### Recent Commits (5 most recent)
1. `cadc7cd` - feat: pharmacy POS, patient enrolment, PACS/DICOMweb and LivePay config
2. `f7ee580` - feat: public support pages and per-period Yo! subscription checkout
3. `e758f30` - docs: reconcile status matrices with delivered features and the final gate
4. `584fa64` - docs: record staging and production release of d88bb21
5. `d88bb21` - feat: contextual LOINC/UCUM terminology and reviewed laboratory ConceptMaps

## 🏗️ Architecture Overview

### Technology Stack
| Layer | Technology |
|---|---|
| **Frontend** | React + TypeScript, Vite |
| **Backend** | Hono.js (Workers-compatible) |
| **Database** | PostgreSQL with RLS, Hyperdrive |
| **Auth** | JWT + TOTP MFA, session revocation |
| **Testing** | Vitest + Playwright |
| **Deployment** | Cloudflare Workers, Wrangler |

### Directory Structure
```
medveris/
├── apps/
│   ├── api/         # Hono API server (src/server.ts)
│   ├── web/         # React Vite app
│   └── jobs/        # Background job processor
├── packages/
│   ├── auth/        # Authentication & MFA
│   ├── authz/       # Authorization & RBAC
│   ├── contracts/   # API contracts & schemas
│   ├── db/          # Database driver & SQL builder
│   ├── domain/      # Domain models & invariants
│   ├── ui/          # React UI components
│   └── platform/    # Cloudflare platform bindings
└── docs/            # Comprehensive specification docs (19+ files)
```

## ✅ Implemented Functionality (M1 Complete)

### Core Clinical Operations
- Patient registration with synthetic IDs
- Staff/facility onboarding and credential management
- Encounters, appointments, and clinical documentation
- Structured observations with LOINC/UCUM coding
- Allergies, conditions, and follow-up workflows
- Clinical note signing and amendment with audit trails

### Multi-Tenant Architecture
- Two tenant isolation (tenantA, tenantB)
- Role-based access control with facility isolation
- Cross-facility exchange grants with consent scoping
- Break-glass emergency access with MFA reauthentication

### Standards Integration
- FHIR R4 restricted `/fhir/r4` facade
- SNOMED CT coded entries with versioned mappings
- LOINC laboratory tests with UCUM units
- DICOMweb mock integration for PACS

### Testing Coverage
- **Unit/Integration:** PostgreSQL RLS tests, constraint validation
- **API Contract:** Schema contracts, status codes, denial semantics
- **Browser/End-to-End:** 30+ Playwright scenarios (AT01-AT36)
- **Acceptance Tests:** Full traceability from requirements to implementation

## 🔄 Partial / Incomplete Areas

### Configuration & Environment
- `.env.example` has placeholder values
- Production deployment scripts exist but not verified
- Environment variable documentation incomplete

### CI/CD Pipeline
- No automated testing pipeline configured
- Deployment scripts exist (`staging-deploy.mjs`, `production-deploy.mjs`)
- No CI/CD automation for test execution on PRs

### Monitoring & Observability
- Basic request telemetry in API server
- No health check endpoints beyond `/health/live`
- Limited structured logging

### Documentation
- Comprehensive `MASTER_BUILD_PROMPT.md` exists
- 19+ documentation files in `docs/`
- Gap analysis and status matrices partially complete

## 🎯 Next Steps for Completion

### Immediate Priorities (M0 Completion)
1. **Finalize Repository Audit**: Document gap analysis matrix (in progress - REPOSITORY_AUDIT_REPORT.md created)
2. **Complete Environment Setup**: Finalize `.env` configuration with proper secrets
3. **Add CI/CD Pipeline**: Configure automated testing and deployment
4. **Implement Monitoring**: Health checks, observability, structured logging

### M1 Verification
Run acceptance tests to confirm:
```bash
npm test              # Unit/integration tests
npm run test:e2e      # Playwright end-to-end tests
npm run verify:runtime # Runtime smoke test
```

### Production Readiness
1. Configure production database roles and passwords
2. Set up Cloudflare Workers secrets
3. Verify DICOMweb and PACS integration (currently mock)
4. Configure Yo! Payments and LivePay (currently disabled)
5. Run production deployment checks

## 📋 Key Files for Continuing Work

### Configuration
- `.env` - Local development environment (copy from `.env.example`)
- `.env.example` - Placeholder configuration template
- `wrangler.jsonc` - Cloudflare Workers configuration

### API Server
- `apps/api/src/server.ts` - Main application entry point
- `apps/api/src/app.ts` - Hono app with middleware and routes
- `apps/api/src/config.ts` - Configuration loading

### Database & Migrations
- `scripts/db-setup.ts` - Role provisioning and database setup
- `scripts/db-migrate.ts` - Migration application
- `scripts/seed.ts` - Synthetic data population
- `packages/db/migrations/` - SQL migration files

### Testing
- `tests/e2e/` - Playwright end-to-end scenarios
- `tests/integration/` - Integration test suites
- `tests/unit/` - Unit tests

### Documentation
- `MASTER_BUILD_PROMPT.md` - Core build instructions
- `docs/15_ACCEPTANCE_TESTS.md` - Test scenarios AT01-AT36
- `docs/LOCAL_DEVELOPMENT.md` - Local setup guide

## 🔧 Running the System

### Local Development
```bash
# 1. Install dependencies
npm install

# 2. Set up database
cp .env.example .env
# Edit .env with local values (or use defaults)
npm run db:setup      # Create roles and databases
npm run db:migrate    # Apply migrations
npm run db:seed       # Populate synthetic data

# 3. Start development server
npm run dev           # Runs API (port 8787) and Web (port 5173) concurrently
```

### Access Credentials (after seed)
- **Patient:** `patient@medveris.local` / *(password printed by `npm run db:seed`)*
- **Clinician:** `clinician@medveris.local` / *(password printed by `npm run db:seed`)* (requires TOTP)
- **Admin:** `admin@medveris.local` / *(password printed by `npm run db:seed`)* (requires TOTP)
- **Reception:** `reception@medveris.local` / *(password printed by `npm run db:seed`)* (requires TOTP)
- **Nurse:** `nurse@medveris.local` / *(password printed by `npm run db:seed`)* (requires TOTP)

### Test Environment
- Open: <http://localhost:5173>
- API: <http://localhost:8787>
- MFA codes: Use `/api/v1/auth/totp/dev?email=...` endpoint (with `DEV_SHOW_TOTP_SECRETS=true`)

## ⚠️ Known Limitations & Blockers

### Currently Disabled Features
- `FEATURE_DICOMWEB=false` - PACS integration disabled
- `FEATURE_PAYMENTS=false` - Yo!/LivePay disabled
- `FEATURE_LAB=false` - Laboratory module disabled
- `FEATURE_TELEMEDICINE=false` - Telemedicine disabled
- `FEATURE_DEVICES=false` - Device integration disabled
- `FEATURE_AI=false` - AI features disabled
- `FEATURE_PUBLIC_HEALTH=false` - Public health disabled

### Security Notes
- All patient data is synthetic (no real PHI)
- MFA required for all staff clinical access
- Tenant isolation enforced at database and application levels
- No shared caching for authenticated responses
- Audit trails on all clinical writes

### Environment Requirements
- PostgreSQL 14+ with RLS support
- Node.js >= 22.12
- Cloudflare Workers account (for production deployment)
- Optional: Resend API key (for email), R2 bucket (for storage)

## 📞 Handoff Checklist

### ✅ Completed
- [x] Repository structure and package management
- [x] Database schema with RLS and roles
- [x] Core clinical workflows (M1)
- [x] FHIR R4 facade implementation
- [x] SNOMED CT/LOINC/UCUM terminology
- [x] Multi-tenant isolation
- [x] Authentication and MFA
- [x] Acceptance test coverage (AT01-AT36)
- [x] Comprehensive audit trails
- [x] Exchange grant management

### 🔄 In Progress
- [ ] Repository audit gap matrix (REPOSITORY_AUDIT_REPORT.md created)
- [ ] Finalize local development environment
- [ ] Configure CI/CD pipeline
- [ ] Add monitoring and observability

### ⏳ Pending
- [ ] Production deployment verification
- [ ] DICOMweb/PACS real integration
- [ ] Payment processing (Yo!, LivePay)
- [ ] Clinical AI features
- [ ] Device integration
- [ ] Public health reporting

---
*This handoff generated from repository inspection on 2026-10-31. For continuation, run `npm install && cp .env.example .env && npm run db:setup && npm run db:migrate && npm run db:seed && npm run dev` to start local development.*
## Global Mobile-First UI/UX Audit (2026-11-09)

**Scope:** global responsive foundations, facility workspace top bar and navigation, mobile bottom navigation and sheets, public information site, pricing, forms/inputs, data tables, modals, grid/split layouts, safe-area and dynamic-viewport behaviour, and a Playwright responsive regression suite.

### What changed

- `packages/ui/src/styles.css`
  - `html/body/#root` base rules: `100dvh` body sizing, `-webkit-text-size-adjust`, `overflow-wrap: break-word`, and `max-width: 100%` for media.
  - Shared layout tokens now use `min()` in every `auto-fit` grid (`mv-grid--2`, `mv-grid--3`, `mv-form-grid`, `mv-datalist`, `mv-quick-actions`, `mv-pos-totals` equivalent in web styles) so no track forces horizontal overflow on 320/375/390 px viewports.
  - `.mv-app` and `.mv-auth` use `100dvh` with `100vh` fallback; sidebar and top/bottom chrome account for `env(safe-area-inset-*)`; `.mv-content` padding bottom on mobile accounts for the fixed bottom navigation plus safe area.
  - `.mv-table-wrap` supports `min-width: 0`, `max-width: 100%`, horizontal containment and touch scrolling; `.mv-input` uses `font-size: 1rem` and `min-height: 44px` to avoid iOS zoom and keep touch targets.
  - Fixed the dead-code state in which the menu button and sidebar close button were permanently `display: none`, and the scrim was also `display: none`; the scrim is now a real fixed overlay and the menu button is available at every viewport.
  - `.mv-nav-strip` is hidden at `<= 900px`; a fixed `.mv-bottom-nav` is shown at `<= 900px` instead.
  - Consolidated duplicate `.mv-content` declarations and added `.mv-split` with a single-column collapse for note/entry split views.
- `apps/web/src/styles.css` — same `min()` grid fix for `mv-grid-2`, `mv-form-grid`, `mv-pos-totals`; `100dvh` for `.mv-public`.
- `apps/web/src/components/AppShell.tsx`
  - Mobile navigation is now wired: `Home` navigates to `/dashboard` (staff) or `/portal` (patient); `Care`, `Analytics`, `Knowledge` and `More` open the `MobileSheet` bottom sheet derived from the navigation SSOT (`mobileTabsFor` / `mobileSectionsFor` / `activeMobileTabForPath` from `apps/web/src/lib/nav.ts`).
  - Opening a sheet locks body scroll; the sheet is focus-trapped, closable by scrim/Escape/close button and closes on route change.
- `apps/web/src/pages/EncounterPage.tsx` — inline fixed two-column grid replaced by responsive `.mv-split`.
- `apps/web/src/pages/CatalogueEditorPage.tsx` — modal uses `90dvh` and fluid padding.

### Test evidence

- `npm run build:web` — passes (Vite production build completed).
- `tsc -p tsconfig.json --noEmit` (full monorepo) — **not green** for the same reason recorded in prior work: pre-existing uncommitted `apps/api` WIP, e.g. `apps/api/src/integrations/ollama.ts(100,3) TS1016`. No web/UI type errors were reported.
- `npx eslint AppsShell.tsx CatalogueEditorPage.tsx DashboardPage.tsx` — touched files clean. Note: `apps/web/src/pages/EncounterPage.tsx:92` still carries a pre-existing unused `loadTimeline` left by earlier in-progress work.
- `npx vitest run tests/unit/nav-route-parity.test.ts tests/unit/site-content.test.ts` — 17 passed.
- `npx playwright test tests/e2e/responsive.spec.ts` — 8 passed. Covers public routes (`/`, `/pricing`, `/about`, `/help`, `/contacts`) at 390x844 and 320x640, authenticated clinician mobile shell navigation (bottom nav, sidebar drawer, sheet), authenticated patient portal, and a desktop control (bottom nav absent, nav strip and menu button present).
  - The suite accepts the updated legal documents for the local synthetic `clinician@medveris.local` and `patient@medveris.local` accounts when the reacceptance gate is shown; this is a one-time database change in the local synthetic data set.
  - Horizontal overflow is asserted with `document.documentElement.scrollWidth <= window.innerWidth + 1`.
- `playwright.config.ts` — added the `chromium` project so the `npm run test:e2e` script's `--project chromium` resolves.

### Known gaps and not performed

- No separate requirement #14 checklist with exact sub-requirements was found in this repository (`grep` found none). The changes above implement standard mobile-first/responsive requirements and the desktop control test; they were not audited against any external requirement specification.
- Pages rendered *inside* tables still scroll horizontally within `.mv-table-wrap` on narrow screens; a per-page card-based mobile table refactor was not done.
- No physical device testing; no automated screenshot comparison; no low-bandwidth/high-zoom testing beyond `320px` viewport coverage.
- Charts, DICOM/imaging viewers, print styles, and full acceptance-test coverage of every role are not covered by the responsive suite; `@media print` paths remain unverified on this branch.
- The repository still contains large pre-existing uncommitted work across `apps/api`, migrations and reports; `npm run typecheck` and a full `npm run test:e2e` gate were not re-verified against that work.
- Nothing was deployed. No changes to Cloudflare, VPS, databases or secrets were made.
