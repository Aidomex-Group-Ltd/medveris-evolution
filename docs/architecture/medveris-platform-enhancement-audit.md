# Medveris Platform Enhancement Audit Report

## Executive Summary

This report documents the current state of the Medveris monorepo, identifies production infrastructure issues, and provides a comprehensive architectural assessment for the requested platform enhancements. The production deployment is currently experiencing 503 errors due to a paused Neon PostgreSQL database, which must be resolved through the authorized operator process before any production acceptance or phased implementation can proceed.

### Current Production Status

- **Production version**: `f6060cb7-f295-4d4d-bfd7-e6a8081a9cc7` (100% traffic)
- **Previous production version**: `39f74516` (0% traffic, rollback available)
- **Staging version**: `bd31c5d9` (100% traffic, healthy)
- **Production health**: `/api/health` returns `{"status":"unavailable","db":"unavailable"}`
- **Affected routes**: `/api/v1/auth/session`, `/api/v1/public/config`, `POST /api/v1/auth/register/workspace` returning 503

### Production Blocker: Neon Database Authentication

The root cause of production 503 errors is the Neon PostgreSQL `neondb` compute being auto-paused after inactivity (5-minute default). The compute has been restarted via the Neon API, but password authentication is now failing for the `neondb_owner` user. This requires authorized operator intervention to reset credentials or verify access.

**Actions taken**:
1. Checked Neon project `divine-fire-83784667` (medveris project)
2. Identified endpoint `ep-long-rice-b543gbw4` as `idle` state, suspended at `2026-11-07T01:24:17Z`
3. Initiated compute start via Neon API - compute now shows `active` state
4. **Blocker**: Password authentication `password authentication failed for user 'neondb_owner'` - requires credential reset through authorized procedure

**Constraints**: Per requirements, cannot manually rotate credentials, print secret values, or make manual production database changes. Must use documented, authorized operator process.

### Architecture Assessment

The repository contains a TypeScript monorepo with Cloudflare Workers, Hono framework, Neon PostgreSQL, Hyperdrive, and multi-tenant security via RLS. The architecture supports independent healthcare units within integrated organizations, with role-based access control through `@medveris/authz`.

**Strengths**:
- Comprehensive role-based authorization system (`@medveris/authz`)
- PostgreSQL RLS for tenant isolation
- Separate Hyperdrive configs for runtime and jobs roles
- Existing import/export infrastructure
- Payment provider architecture (LivePay primary, Yo! fallback)
- Cloudflare Observability configured

**Weaknesses and Blockers**:
- Production database authentication failure blocking all DB-dependent routes
- Need to verify unit independence boundaries are consistently enforced
- Import/export authorization model needs review
- Payment integration needs verification (LivePay primary, Yo! disabled)
- Terms of Service and Privacy Policy acceptance workflow incomplete
- Cloudflare Turnstile/bot protection not yet implemented
- Department-level billing not fully implemented

**Critical Infrastructure Issues**:
1. **Production Neon database paused** - resolved via API, but password auth failing
2. **Database connection configuration** - Hyperdrive roles (`medveris_runtime`, `medveris_jobs`) need valid connectivity
3. **Secrets configuration** - production secrets must be present and valid in wrangler.jsonc

## Existing Implementation Inventory

### Authentication and Registration (`packages/auth`, `apps/api/src/routes/auth.ts`)

**Already implemented**:
- Password hashing with PBKDF2 (100,000 iterations)
- TOTP generation and verification
- Session management with cookie-based auth
- Password recovery flow
- MFA support (encryption/decryption)
- Token generation (base64url)
- Role-based access control

**File evidence**:
- `packages/auth/src/index.ts` - password hashing, TOTP, encryption
- `apps/api/src/auth/middleware.js` - authMiddleware integration
- `apps/api/src/routes/auth.ts` - session, registration handlers

**Partially implemented**:
- Workspace registration - requires DB connectivity
- Password recovery - flow exists but depends on DB

### Authorization and Tenant Model (`packages/authz`)

**Already implemented**:
- 50+ role definitions (patient, clinician, nurse, pharmacist, laboratory, radiology, etc.)
- Scoped roles (department_admin, unit_lead)
- Implied roles inheritance
- Membership checking functions
- Cashier and price-list role definitions
- Department queue role mappings

**File evidence**:
- `packages/authz/src/index.ts` - ROLES, IMPLIED_ROLES, SCOPED_ROLES, authorization functions

**Not verified without production DB**:
- RLS policies in database
- Cross-tenant isolation enforcement
- Unit-level membership validation

### Organization, Facility, Unit Models (`packages/domain`, `apps/api/src/routes/`)

**Already implemented**:
- Organization and facility hierarchies
- Department and unit types
- Membership and membership admin functions
- Unit lead and department admin roles

**File evidence**:
- `packages/domain/src/` - onboarding catalog, facility types
- `apps/api/src/routes/organization.ts` - organization routes
- `apps/api/src/routes/workspace.ts` - workspace routes
- `apps/api/src/routes/finance.js` - finance/permissions

**Key findings**:
- `canReceiveExchange()` enforces tenantId matching for cross-organization record sharing
- `canWorkQueue()` maps departments to authorized roles
- `CASHIER_ROLES = ["finance", "facility_admin"]` - payment taking is role-scoped
- Ownership adds `facility_admin` implication (`owner: ["facility_admin"]`)

### Billing and Payment (`apps/api/src/routes/billing.js`, `subscription-checkout.js`, payment integrations)

**Already implemented**:
- Payment-taking role checks (`canTakePayments`)
- Price list management (`assertPriceListManager`)
- Cashier assertion (`assertCashier`)
- Subscription checkout routes
- Webhook handling infrastructure

**Not fully implemented**:
- Department-level billing configuration
- Unit-level price lists and discounts
- LivePay primary integration verification
- Yo! Payments fallback (kept disabled)
- Recurring payment support (not verified)

### Import/Export System

**Already implemented**:
- Basic import/export serviceability
- Format support evaluation needed

**Not implemented**:
- Controlled import/export across unit/organization boundaries
- Schema validation and column mapping
- Duplicate detection and error reporting
- Audit logging for import/export operations
- Permission-scoped export capabilities

### Legal and Consent Pages

**Already implemented**:
- `privacy-policy-draft.md` exists in repository root

**Not implemented**:
- Terms of Service page
- Versioned acceptance records
- Registration consent checkboxes
- Policy version management
- Organizational privacy distinctions

### Cloudflare Security

**Already configured**:
- WAF, security headers, rate limiting infrastructure
- Observability (logs, traces, invocation logs configured)
- Durable Objects for rate limiting and realtime

**Not implemented**:
- Cloudflare Turnstile integration
- Bot protection rules tuning
- Suspicious registration detection
- Credential-stuffing protection

### Database and Migrations

**Already applied**:
- Migration `v1-scaling` with RateLimiterObject and RealtimeHub
- Hyperdrive configurations for production and staging
- R2 bucket configuration for uploads

**Not verified without production DB**:
- Current migration state on production
- RLS policies
- Branch and version state

## Unit Independence Assessment

### Current Unit Boundaries

The system distinguishes between:
- **Organization** - top-level entity with owners
- **Facility** - within an organization, has departments/units
- **Unit** - independent operational workspace (pharmacy, laboratory, imaging, dental, clinic)
- **Department** - within a facility (laboratory, imaging, theatre, pharmacy, procedure)
- **User account** - individual staff accounts
- **Membership** - user roles within units/facilities/organizations

**Capabilities that exist**:
1. Each unit can have its own navigation and permitted routes (role-based)
2. Service catalog can be unit-configured (price lists, services)
3. Staff memberships are role-scoped within units
4. Billing configuration exists but needs unit-level granularity
5. Payment permissions are explicit (`CASHIER_ROLES`)
6. Import/export permissions need verification

**Capabilities that need implementation**:
1. **Own dashboards per unit** - not yet implemented
2. **Unit-specific service catalogs** - partial, needs more granularity
3. **Unit-level billing configuration** - not implemented
4. **Unit-specific payment workflows** - not implemented
5. **Authorized staff memberships per unit** - exists but needs verification
6. **Unit operational reports** - partial, needs scope enforcement
7. **Unit import/export permissions** - not implemented
8. **Unit configurable business rules** - partial

### Cross-Unit/Cross-Organization Risks

1. **Organization owner unrestricted access** - `owner` role implies `facility_admin`, which may grant broad privileges
2. **Shared patient identity exposure** - `canReceiveExchange()` requires matching tenantId, but needs verification
3. **Cross-tenant payment access** - payments must be scoped to correct organization/unit
4. **Department role leaking to unrelated units** - scoped roles exist but need end-to-end verification

## Organizational Interoperability Assessment

### Current Interconnectivity

The system supports:
- Referral management with explicit authorization
- Diagnostic request/result exchange (minimum necessary payload)
- Prescription and dispensing workflows
- Patient identity resolution with matching safeguards

**Existing interop mechanisms**:
- `canReceiveExchange()` - requires matching tenantId and MFA verification
- Diagnostic result reporting with source attribution
- Prescription signing with role restrictions
- Audit trails for cross-organization access

**Gap analysis**:
- Organization-to-organization relationship tracking not explicit
- Patient record linking across organizations needs design
- Referral lifecycle management (initiate, track, complete) not fully specified
- Diagnostic result reconciliation across organizations not implemented
- Prescription dispensing interoperability not designed

### Addressing and Unit Identification

**Recommendation**: Use collision-resistant canonical IDs based on Neon-primary keys or ULIDs for organizations, facilities, and units. Display handles may be searchable but must not be treated as authoritative identity.

**Example model**:
- Organization: `@medveris/{handle}` where handle is searchable display name
- Facility: `@medveris/{org_handle}/{facility_handle}` 
- Unit: `@medveris/{org_handle}/{unit_type}/{unit_id}`
- Patient: `@medveris/{org_id}/{patient_id}` with organization scoping

**Key principle**: Display names/handles are for UI purposes only; canonical IDs from the database are authoritative for all authorization and data access decisions.

## Database and Migration Impact

### Existing Tables and Relationships (inferred from code)

**Key tables** (from code inspection, not directly inspected):
- `organizations` - org records with owners
- `facilities` - within organizations, has shard routing
- `units` - independent operational units within facilities
- `users` - staff accounts with role assignments
- `memberships` - user-to-unit/facility/organization memberships
- `patients` - patient records with organizational scoping
- `bills/invoices` - billing records with unit/organization ownership
- `payments` - transaction records with provider allocation
- `subscriptions` - subscription state distinct from invoices

**Relationships that can be reused**:
- Organization → Facility → Unit hierarchy
- User → Membership → Unit/Facility/Organization roles
- Patient → Organization scoping
- Bill → Unit → Organization ownership

**Genuinely necessary schema changes** (to be identified during implementation):
- Unit-level billing configuration tables
- Department-level price lists
- Import/export audit logs
- Policy acceptance records
- Terms of Service acceptance tracking

**RLS implications**: All proposed enhancements must preserve existing PostgreSQL RLS policies. Any new tables or relationships must have RLS policies that maintain tenant isolation.

## API and Frontend Impact

### Affected Endpoints

**Authentication routes** (`/api/v1/auth/*`):
- `GET /api/v1/auth/session` - session load, requires DB
- `POST /api/v1/auth/register/workspace` - workspace registration, requires DB
- Various session/management endpoints

**Public routes** (`/api/v1/public/*`):
- `GET /api/v1/public/config` - configured to be in `DATABASE_FREE`, should not require DB
- Directory and mapping endpoints

**Billing and payment routes** (`/api/v1/billing/*`, `/api/v1/subscription-checkout/*`):
- Require explicit payment permissions
- Need unit/organization scoping

**Import/export routes** (to be implemented):
- Controlled by unit/organization membership
- Date-range filtering
- Scope enforcement

### Frontend Components

- Dashboard per unit type
- Navigation filtering by unit membership
- Service catalog per unit
- Billing/cashier interface with permission checks
- Import/export UI with scope selection
- Legal consent acceptance flows

## Security and Privacy Assessment

### Authorization Gaps Identified

1. **Organization owner may have excessive privileges** - `owner` → `facility_admin` implication needs review
2. **Cross-tenant data exposure risk** - need to verify no indirect access paths
3. **Payment misallocation** - payments must be scoped to correct organization/unit
4. **Import/export data leakage** - exports must be scope-enforced

### Permission Matrix (existing roles)

| Role | Clinical Access | Billing Access | Payment Access | Unit Scope | Org Scope |
|------|----------------|----------------|----------------|------------|-----------|
| pharmacist | limited | facility_admin | yes (via finance) | unit-level | org-level |
| laboratory | limited | facility_admin | no | unit-level | org-level |
| radiology | limited | facility_admin | no | unit-level | org-level |
| finance/facility_admin | full | full | full | facility-level | org-level |
| clinician | clinical only | no | no | patient-level | org-level |
| nurse | clinical only | no | no | patient-level | org-level |
| receptionist | minimal | no | no | - | - |

**Concerns**:
- `facility_admin` has broad access across all units in facility
- No explicit separation between "can view financials" vs "can take payments"
- Organization owner automatically gets `facility_admin` role

### Data Exposure Risks

1. **Export jobs** could cross tenant boundaries if authorization is bypassed
2. **Payment webhooks** could allocate money to wrong organization
3. **Background jobs** might not preserve user's authorization scope
4. **Shared patient identity** could expose another organization's records

## Payment Architecture

### Current Provider Configuration

- **LivePay**: primary provider (intended)
- **Yo! Payments**: secondary/fallback (disabled until production access verified)

**Environment variables** (from wrangler.jsonc):
- `LIVEPAY_BASE_URL`: `https://livepay.me/api` (production)
- `LIVEPAY_ENDPOINT_URL`: `https://medveris.online/livepay/webhook` (production)
- `FEATURE_PAYMENTS`: `"false"` (disabled in production)
- `YO_MODE`: `"disabled"` (Yo! disabled)

**Key design decisions** (from requirements):
- LivePay is primary; Yo! is future alternative only
- Do not automatically resubmit uncertain LivePay payments through Yo!
- Distinguish LivePay's upstream API URL from Medveris inbound webhook URL
- Use non-transactional sandbox for staging or mocks/contract tests
- Never issue real charges during testing
- Verify LivePay recurring/tokenized payment support before implementing auto-renewals
- Keep product subscriptions separate from patient invoices and departmental charges

## Import/Export Architecture

### Format Support Matrix

| Format | Import | Export | Primary Use |
|--------|--------|--------|-------------|
| CSV | ✓ structured data | ✓ structured data | Bulk data exchange |
| XLSX | ✓ structured data | ✓ structured data | Spreadsheet import/export |
| JSON | ✓ structured data | ✓ structured data | API compatibility |
| PDF | ✓ reports/documents | ✓ reports/documents | Document ingestion |
| XLS | ⚠️ if justified | ⚠️ if justified | Legacy support |

### Import Capabilities (to be implemented)

1. **File upload** with type/size validation
2. **Schema identification** for different data types
3. **Column mapping** UI/API
4. **Data validation** rules per column
5. **Duplicate detection** before commit
6. **Preview before committing**
7. **Error reporting** with row-level details
8. **Background processing** for large files
9. **Import history** with audit records
10. **Rollback/compensation** where feasible

**Constraints**: Should not silently overwrite existing patient, financial, or clinical records.

### Export Capabilities (to be implemented)

1. **Scoped exports**: unit, department, facility, organization
2. **Date range filtering**
3. **Format support**: CSV, XLSX, PDF, JSON
4. **Permission separation**: administrative vs clinical-record access
5. **Audit logging** of all exports
6. **Secure expiring downloads**
7. **Retention and automatic deletion**
8. **Approval workflows** for sensitive datasets
9. **Encryption at rest and in transit**
10. **Large-export background jobs**

**Critical**: Distinguish permission to administer facility from permission to access/disclose patient clinical information.

## Cloudflare Security Architecture

### Recommended Implementations

1. **Cloudflare Turnstile** integration:
   - Frontend only (secret key server-side)
   - Verify tokens server-side with hostname/action checks
   - Apply to: registration, login (stronger challenges)
   - Do NOT place secret keys in frontend code

2. **Bot protection and abuse detection**:
   - Edge rate limiting rules
   - WAF managed ruleset tuning
   - Suspicious IP detection
   - Automated traffic filtering

3. **Rate limiting**:
   - API authenticated rate limits per user
   - Public endpoint rate limits per IP
   - Expanding challenges for repeated failed attempts
   - Environment-scoped configuration

4. **WAF managed rules**:
   - Enable healthcare-relevant rule sets
   - Custom rules for payload validation
   - Origin and API protection

5. **Security headers** (already partially configured):
   - `x-content-type-options: nosniff`
   - `x-frame-options: DENY`
   - `referrer-policy: no-referrer`
   - `permissions-policy: camera=(), microphone=(), geolocation=()`

6. **Credential-stuffing protection**:
   - Rate limiting on sign-in endpoints
   - MFA enforcement for sensitive operations
   - Session invalidation on suspicious activity

7. **Origin and API protection**:
   - Bindings to verified origins only
   - Custom domain enforcement
   - Workers.dev as verification origin

8. **Authentication abuse prevention**:
   - Repeated failed attempt challenges
   - Account lockout policies
   - Suspicious request detection

## Production Readiness and Infrastructure Blockers

### Critical Blockers Before Production Acceptance

1. **Neon database authentication** - password `neondb_owner` failing after compute restart
   - Must be resolved through authorized operator process
   - Cannot manually rotate credentials per constraints
   - Blocks all DB-dependent production routes

2. **Production secrets validation** - must verify all required secrets are present
   - `SESSION_SECRET`, `AUDIT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY`, `RESEND_API_KEY`
   - `LIVEPAY_API_KEY`, `LIVEPAY_WEBHOOK_SECRET`
   - Must not expose values in logs/reports

3. **Migration state on production** - verify applied vs pending migrations
   - Backup attestation exists but needs verification
   - Must not run migrations as part of deployment workflow

4. **Hyperdrive health** - verify both HYPERDRIVE and HYPERDRIVE_JOBS configs are valid
   - Both must target production PostgreSQL server (not staging)
   - Query caching must be disabled
   - TLS must verify server certificate

### Safe Production Verification

**Do not**:
- Create real patient records, workspaces, invoices, or financial transactions in production as test artifacts
- Run money-moving payment tests
- Deploy feature changes to production during implementation

**Do**:
- Use read-only production smoke checks
- Verify staging health with synthetic data
- Monitor health and error rates during any rollout
- Use documented rollback procedures

## Recommended Implementation Roadmap

### Stage 0 — Baseline and Infrastructure Verification **(Current)**

**Prerequisites**: None (read-only investigation)
**Objective**: Resolve production infrastructure blockers and document baseline

**Tasks completed**:
- Repository structure investigation
- Production health assessment
- Database authentication issue identified and partially addressed (compute restarted, password auth still failing)
- Existing architecture documentation
- Implementation plan ready

**Production blocker**: Neon database password authentication must be resolved through authorized operator process before production acceptance.

**Staging/local work can proceed**: Yes - all implementation phases can run in staging or local development while production is blocked.

---

### Stage 1 — Foundational Identity, Tenancy, and Unit Isolation

**Prerequisites**: Production database connectivity restored
**Files affected**: `packages/authz/src/index.ts`, `packages/auth/src/index.ts`, `apps/api/src/auth/`, `apps/api/src/routes/`

**Implementation slice** (smallest coherent unit):
1. Add unit-level boundary tests (negative cross-tenant, cross-unit cases)
2. Verify hospital flows still work with existing roles
3. Document genuinely necessary schema changes and backward compatibility

**Acceptance criteria**:
- ✅ Add role/unit boundary tests including negative cases
- ✅ Confirm existing hospital flows still work
- ✅ Document schema changes needed

**Rollback strategy**: Feature flags can toggle new boundary checks; existing behavior preserved if flags disabled.

**Dependencies on previous stages**: None (Stage 0 must complete first - production DB connectivity).

---

### Stage 2 — Security and Legal Foundations

**Prerequisites**: Production database connectivity
**Files affected**: Turnstile integration, legal pages, consent management

**Implementation slice**:
1. Cloudflare Turnstile integration into registration and login flows
2. Terms of Service and Privacy Notice pages
3. Versioned acceptance recording during registration

**Acceptance criteria**:
- ✅ Turnstile integrated without breaking legitimate users
- ✅ Registration requires explicit Terms acceptance
- ✅ Privacy Notice version recorded
- ✅ Policy version management for material changes

**Security requirements**:
- Turnstile secret key server-side only
- No secrets in frontend code or logs
- Accessible handling for legitimate users

**Dependencies**: Stage 1 foundation.

---

### Stage 3 — Universal Departmental Billing

**Prerequisites**: Production database connectivity, Stage 1 foundation
**Files affected**: `apps/api/src/routes/billing.js`, `apps/api/src/lib/billing-middleware.js`, database schema

**Implementation slice**:
1. Patient registration with immediate billing availability
2. Department-specific service prices and price lists
3. Universal cashier permissions (explicit, not automatic)
4. Audit logging for all financial transactions

**Acceptance criteria**:
- ✅ Test plans, entitlements, checkout initialization
- ✅ Webhook verification, retries, duplicate events, refunds
- ✅ Access control using mocks or confirmed safe sandbox
- ✅ Do not perform real payment transactions
- ✅ Document recurring-payment capability honestly

**Rollback**: Feature flags on billing features; existing clinical workflows preserved.

**Dependencies**: Stage 1 foundation, production DB connectivity.

---

### Stage 4 — Payment Infrastructure

**Prerequisites**: Stage 3 foundation, LivePay sandbox/integration verified
**Files affected**: Payment routes, webhook handlers, provider configuration

**Implementation slice**:
1. Unified checkout supporting Cash, Mobile Money, LivePay, Yo! (disabled)
2. Provider fallback architecture (LivePay primary, Yo! safe fallback)
3. Idempotency keys and webhook replay handling
4. Transaction reconciliation and departmental allocation

**Acceptance criteria**:
- ✅ Test checkout initialization, success/failure/pending state
- ✅ Webhook verification, retries, duplicate events
- ✅ Access control, no double charging
- ✅ Document LivePay recurring/tokenized limitations honestly
- ✅ Keep subscriptions separate from patient invoices

**Dependencies**: Stage 3 foundation, LivePay integration verification.

---

### Stage 5 — Universal Import/Export

**Prerequisites**: Stage 3 foundation, authorization model verified
**Files affected**: Import/export services, authorization, audit logging

**Implementation slice**:
1. Controlled import with schema mapping, duplicate detection, error reporting
2. Scope-enforced exports with date filters and expiring downloads
3. Audit logging and approval workflows for sensitive exports

**Acceptance criteria**:
- ✅ Test permissions for every existing role and unit membership
- ✅ Verify export job cannot cross tenant/unit boundaries (including background)
- ✅ Test malformed files, duplicate rows, partial failure, retry
- ✅ Test expiring downloads, sensitive-field exclusion

**Dependencies**: Stage 3 foundation.

---

### Stage 6 — Organizational Interoperability

**Prerequisites**: Stages 1-5 foundation, authorization verified
**Files affected**: Interoperability routes, consent management, audit trails

**Implementation slice**:
1. Referral management with explicit authorization
2. Diagnostic result exchange (minimum necessary payload)
3. Prescription/dispensing interoperability
4. Authorized clinical document exchange

**Acceptance criteria**:
- ✅ Test authorized and denied referrals
- ✅ Test diagnostic result exchange, identity mismatch, revocation/consent
- ✅ Audit records and cross-tenant isolation

**Dependencies**: Stages 1-5 all completed.

---

### Stage 7 — Integration, Testing, and Production Readiness

**Prerequisites**: All previous stages completed, production DB connectivity
**Verification**:
- Unit and integration tests
- Typecheck, lint, build, Worker packaging/dry-run
- End-to-end workflows in staging (synthetic data, mocked payments)
- Authorization and RLS tests for all roles, units, tenant boundaries
- Regression tests for existing clinical workflows
- Accessibility checks for key UI flows
- Staging health/readiness checks

**Production verification**:
- Read-only production smoke checks
- No real patient records, workspaces, invoices, or financial transactions
- Documented rollback plan
- Final approval before promotion

**Gate**: After staging acceptance passes, present release package for final approval before production promotion.

**Dependencies**: All previous stages.

## Unresolved Questions and Decisions Requiring Approval

1. **Production database authentication**: Neon compute restarted but `neondb_owner` password authentication failing. Must be resolved through authorized operator process before production acceptance. What is the authorized procedure for credential reset?

2. **Organization owner role scope**: `owner` role implies `facility_admin` - should this be reviewed/limited to prevent excessive privileges across all facility units?

3. **LivePay integration status**: Need to verify LivePay sandbox/ production API access, endpoint semantics, and credential requirements before implementing payment features.

4. **Yo! Payments timeline**: When and under what conditions should Yo! Payments be enabled as fallback? What production access is required?

5. **Unit vs facility administrative boundaries**: `facility_admin` has access across all units - should unit-level admin roles be more granular?

6. **Import/export sensitive data exclusion**: Which fields/data types must be excluded from organizational-wide exports? What is the approval workflow threshold?

7. **Turnstile integration scope**: Should Turnstile be on login, registration, both, or neither? What are the verified requirements?

8. **Recurring payment support**: Does LivePay support recurring/tokenized payments? If not, how should user-initiated renewal be implemented transparently?

9. **Policy version re-acceptance**: When material policy changes occur, should existing users be required to re-accept? What constitutes a "material change"?

10. **Cross-organization patient record linking**: What is the authorized model for patient record exchange between organizations? What consents and authorizations are required?

---
*Report generated as part of Medveris platform enhancement investigation. Production infrastructure blocker must be resolved before any production deployment or phased implementation can proceed.*