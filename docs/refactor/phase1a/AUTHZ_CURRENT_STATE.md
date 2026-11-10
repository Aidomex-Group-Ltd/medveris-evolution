# Phase 1A — Current Authorization State (pre-implementation mapping)

Baseline: `master@79d91a8`, branch `phase1a/rbac-backend-authz`.

## 1. Roles, permissions, and policy primitives

### 1.1 Role catalog (`packages/authz/src/index.ts`)
- **Roles:** `patient, proxy, receptionist, nurse, midwife, clinician, specialist_clinician, diagnostic_practitioner, department_lead, facility_admin, finance, auditor, credential_reviewer, pharmacist, laboratory, radiology, radiographer, radiologist, lab_validator, ward_manager, privacy_officer, public_health, hr, records, theatre, housekeeping, porter, mortuary, cssd, biomedical, quality, it_admin, research, content_editor, content_reviewer, opportunity_moderator, owner, department_admin, unit_lead, staff, report_viewer`.
- **Implied roles:** `radiographer→radiology`, `radiologist→radiology`, `lab_validator→laboratory`, `ward_manager→nurse`, `midwife→nurse`, `owner→facility_admin`.
- **Scoped roles:** `department_admin`, `unit_lead` (membership-level unit/department scope; workspace-wide otherwise).
- **Helper predicates:** `canReadClinical`, `canWriteClinical`, `canSignClinical`, `canManageTenant`, `canReviewCredentials`, `canManageWardCare`, `canManageEmergencyCare`, `canManageDiagnostics`, `canDispenseMedication`, `canAdministerMedication`, `canManageFinance`, `canManageProgrammes`, `canManagePublicHealth`, `canManageWorkforce`, `canReviewPrivileges`, `canManageRecords`, `canManageHousekeeping`, `canManagePorters`, `canManageMortuary`, `canManageTechnicalServices`, `canViewOperationalReports`, `canUseEmergencyOverride`, queue/finance helpers (`RECOMMENDING_ROLES`, `DEPARTMENT_QUEUE_ROLES`, `CASHIER_ROLES`, `PRICE_LIST_ROLES`, `canRecommend`, `canWorkQueue`, `canTakePayments`, etc.).
- **Actor context type:** `ActorContext { userId, roles, tenantId, patientId, unitId?, departmentId?, mfaVerified, mfaEnrolled, platformRoles? }`.

### 1.2 Permission catalog (`packages/authz/src/permissions.ts`)
- Explicit action-based permissions (resource/action strings) grouped by domain: patient self/proxy/register/lookup, clinical worklist/record/note/order/result/referral/care-team/emergency, nursing/ward/medication, diagnostic/radiology, ward/privacy, exchange, organization/workforce/onboarding/role-grant/privilege/credential/care-team, finance, public-health, content/opportunity/source, dashboards, inventory/procurement/asset, workspace/organization-link/HMIS, directory/promotion/integration, audit, platform operations.
- `ROLE_PERMISSIONS` maps each role to a permission bundle; `permissionsForRoles()` unions bundles.
- **Observation:** permissions are coarse-grained bundles in places and do not fully encode resource+scope for every API action; policy engine adds contextual checks for a subset of actions/resources.

### 1.3 Policy engine (`packages/authz/src/policy.ts`)
- `PolicyActor` (trusted, assembled server-side) includes membership/engagement/department/cadre/specialty/privilege/credential/care-team/proxy/session-revocation context.
- `ResourceContext` supports `patient-record/profile/care-team/clinical-list/clinical-record/organization/role-grant/credential/finance/public-health/content/opportunity/audit/exchange/dashboard`.
- `authorize()` / `assertAuthorized()` enforce: authenticated/non-revoked session, role-permission presence, staff MFA/membership/engagement/tenant match for staff permissions, care-relationship for `clinical.record.read_authorized`, self/proxy scope for patient actions, consent for exchange/emergency, sensitivity privilege, credential validity, self-approval denial for role/privilege/credential review, content audience/specialty/publish/separation-of-duties rules, expiry checks, clinical sign/amend privilege+credential checks.
- Deny reasons are explicit (`PolicyDeniedError`, `AuthzError` mapping in app).

### 1.4 Centralized access actor assembly (`apps/api/src/services/access.ts`)
- `loadAccessActor` / `loadStaffAccessActor` build `PolicyActor` from live DB state (staff person, active engagement/assignments/cadres, approved/current privileges, care-team memberships, credential validity, proxy scopes/expiry) per request; revocation/expiry intended to take effect immediately.
- `policyDecision()` delegates to `assertAuthorized`.
- **Gap:** not universally used by routes; many routes rely on `requestActor()` + ad-hoc checks or `permissionsForRoles` only.

## 2. Authentication/session middleware and identity context

- `apps/api/src/auth/{middleware,session,integration}.ts`, `apps/api/src/lib/actor.ts`.
- `authMiddleware` resolves session cookie, loads auth context, enforces CSRF for state-changing `/api/`, `/fhir/`, `/terminology/` requests (with defined exemptions), sets deps/auth/correlation context.
- `requireAuth/requireStaff/requirePatient/requirePlatformReviewer`, `isPlatformOperator`, `withActor/withStaffActor/withPlatformActor/withReviewerActor`, `withStaleTolerantRead`, read-your-writes behavior.
- `AuthContext` (`apps/api/src/types.ts`) carries server-resolved user/session/memberships/activeTenant (id/name/slug/roles/membershipId/shard/scope/workspace), patientId, platformRoles, mfaVerified.
- **Tenant/organization context source of truth:** active tenant/membership/roles/scope resolved from session+DB in `loadAuthContext`; route handlers generally read `c.get("auth")!.activeTenant!.id` or membership-derived scope. Client-supplied tenant identifiers in request bodies/params are used for resource lookup/validation in some flows and must be constrained to actor scope (RLS + explicit checks) — requires per-route verification.
- **Finding:** identity/tenant/roles are not accepted from client as authority; they are server-resolved. Risk remains where a route takes tenant/resource IDs from input without confirming ownership/scope in addition to RLS.

## 3. Scope and RLS

- `apps/api/src/lib/scope.ts`: actor scope resolution (`workspace|department|unit`) for scoped roles, location/department/unit assertions and attribution resolution.
- `packages/db/src/index.ts`: per-transaction context GUCs (`app.tenant_id/user_id/patient_id/actor_kind/roles/platform_role/membership_id/unit_id/department_id`) via `setLocalContext`, `withContext`, `withReadOnlyContext`, `withStaffActor`/`withPlatformActor` wrappers in API.
- Migrations define extensive RLS policies/FORCE RLS/grants/triggers (e.g. workforce/reference/billing/registration/inventory/content/platform roles). `scripts/migrations.ts` validates required app functions, RLS-not-forced, missing policies, audit immutability trigger.

## 4. Route/service authorization inventory (high-level)

### 4.1 Enforcement patterns observed
- **Pattern A (session+actor DB context):** `requireAuth/requireStaff/requirePatient` + `withActor/withStaffActor/withPlatformActor/withReviewerActor` (most facility-scoped routes).
- **Pattern B (permission helper):** `permissionsForRoles(requestActor(c).roles).has(...)` (e.g. content, directory, promotions, radiology, workspace, ehmis, diagnostics, data-exchange, inventory, procurement).
- **Pattern C (role/predicate helpers):** `hasRole`, `canManageFinance`, `assertCashier`, `assertPriceListManager`, `assertDiagnostics`, custom role sets.
- **Pattern D (policy engine):** `assertAuthorized`/`loadAccessActor` used in clinical note signing/amend/error/void/archive and some services (`services/access.ts`); not widespread.
- **Pattern E (organization/platform membership):** `requireOrganizationActor` + `requireRole` (`organizations.ts`), `isPlatformOperator`/`withPlatformActor` (`admin`, billing platform ops, directory moderation, integrations, ops, platform-observability).

### 4.2 Route inventory summary (`apps/api/src/routes/*.ts`)
| Route file | Handlers (approx) | Guard signals (approx) | Notes |
|---|---:|---:|---|
| admin.ts | 56 | 41 | staff/platform guards, membership/role delegation checks, SoD/MFA step-up, platform operator workflows |
| ai.ts | 8 | 8 | staff + clinical write checks + integration availability |
| auth.ts | 49 | 14 | public/auth flows, rate limits, token/session handling; tenant context derived server-side |
| billing.ts | 30 | 40 | staff/platform actor separation, billing scope/manage checks |
| care.ts | 19 | 19 | staff/actor guards |
| clinical.ts | 55 | 48 | clinical read/write/sign assertions, policy engine for sensitive note actions, RLS contexts |
| consent.ts | 21 | 25 | patient/staff/proxy/emergency consent flows |
| content.ts | 79 | 61 | mixed auth/staff, permission checks, audience/tenant scoping, some SoD |
| credentials.ts | 18 | 38 | reviewer/staff/platform separation |
| data-exchange.ts | 17 | 21 | staff + permission checks + scope restrictions |
| devices.ts | 21 | 19 | staff/clinical guards |
| diagnostics.ts | 66 | 74 | staff + permissions/role checks |
| directory.ts | 56 | 55 | mixed public/staff/platform, permission/moderation checks |
| documents.ts | 40 | 36 | staff/auth + permission/RLS patterns |
| ehmis.ts | 40 | 48 | permission checks |
| emergency.ts | 17 | 15 | clinical/emergency guards |
| facility-logo.ts | 6 | 10 | staff actor; permission/admin intent needs confirmation |
| finance.ts | 76 | 79 | finance role checks, SoD self-action blocks, transactional/idempotent patterns |
| inpatient.ts | 77 | 61 | staff/clinical/ward guards |
| integrations.ts | 27 | 32 | platform/admin permission checks |
| inventory.ts | 134 | 119 | extensive permission/scope checks |
| legal.ts | 6 | 3 | public read + authenticated acceptance (`requireAuth/withActor`) |
| maternity.ts | 54 | 48 | clinical/staff guards |
| me.ts | 18 | 12 | `requireAuth/requirePatient` + actor-scoped DB reads/writes |
| notifications.ts | 3 | 3 | `requireAuth` + `withActor`; relies on RLS `recipient_user_id = app.current_user()` (self-scope) |
| onboarding.ts | 37 | 46 | auth/staff/invitation flows |
| operations.ts | 58 | 51 | role/permission guards |
| ops.ts | 4 | 2 | `/health/ready` dependency probe (no auth by design); `/ops/status` uses `withPlatformActor` (requires platform operator) |
| organization.ts | 64 | 56 | membership/admin checks |
| organizations.ts | 30 | 7 | `requireOrganizationActor` + organization membership role checks (`requireRole`) |
| patient-merge.ts | 10 | 14 | privileged/admin/clinical checks |
| payment-callbacks.ts | 17 | 0 | public webhook endpoints, signature/provider verification, tenant resolved from reference/hash server-side, rate limited, `withAnonymous/withContext(system)` |
| pharmacy-pos.ts | 29 | 33 | cashier/clinical/role guards |
| pharmacy.ts | 30 | 37 | pharmacist/clinical guards |
| platform-observability.ts | 16 | 4 | every endpoint gated by `requireOperator` (`isPlatformOperator`→`requireAuth` + platform role) + `withPlatformActor` for DB-backed jobs; Cloudflare proxy read-only |
| procurement.ts | 13 | 21 | staff + permission checks + scope assertions |
| programmes.ts | 39 | 34 | staff/role guards |
| promotions.ts | 20 | 47 | permission/platform checks |
| public.ts | 13 | 0 | intentionally unauthenticated read-only/config/status endpoints; no tenant/patient data mutation |
| radiology.ts | 33 | 35 | diagnostics/radiology permissions and role checks |
| realtime.ts | 4 | 4 | authenticated ticket issuance with MFA/staff checks and rate limit; connect upgrade handled separately |
| reception.ts | 57 | 52 | staff/role checks, rate limits, registration billing hook |
| reports.ts | 4 | 7 | staff + report role/scope checks |
| subscription-checkout.ts | 11 | 15 | staff + billing manage scope + idempotency/rate limits/provider checks |
| telehealth.ts | 22 | 17 | staff/clinical guards |
| theatre.ts | 37 | 29 | staff/clinical guards |
| workflow.ts | 28 | 34 | visit/queue role helpers and department scoping |
| workforce-reference.ts | 18 | 20 | staff/permission/reference access checks |
| workspace.ts | 27 | 35 | staff + permission checks for profile/modules/registrations/links |

### 4.3 Background jobs / non-HTTP authorization
- `apps/jobs/src/*` and queue relay/consumers run as system/job contexts (`actorKind: "system"`, jobs DB role/relay), claim outbox rows by authoritative DB state, and must not trust message payloads beyond identifiers/matching (repo evidence: `outbox.ts`, `queue.ts`, `ai.ts`, `grants.ts`). Authorization is enforced by system-actor design, RLS/job-role grants, and outbox row ownership matching — not by end-user session middleware.

## 5. Duplicate/conflicting authorization logic

- Multiple authorization styles coexist: predicate helpers (`can*`, `hasRole`), `permissionsForRoles(...).has(...)`, route-local role arrays, `assert*` helpers, policy engine (`assertAuthorized`) used selectively, and platform/operator/organization-specific checks.
- `requestActor()` vs `actorFrom()` vs `loadAccessActor()` produce different richness of context (lightweight vs trusted policy actor with live engagement/care-team/privilege data).
- Permission naming/coverage is broad but not a complete per-endpoint resource-action registry; some endpoints rely on role predicates without corresponding policy actions.

## 6. Missing backend enforcement / UI-only restrictions / gaps to verify in implementation

- **Not proven uniform:** every protected route/service action enforces a canonical permission check; many rely on RLS + coarse staff/role checks. Need systematic endpoint/action matrix and targeted hardening.
- **Policy-engine adoption gap:** sensitive clinical note actions use `assertAuthorized`; many other high-risk domains (finance, admin, exports, merges, privileged access changes, integrations, directory moderation) use bespoke checks.
- **Client-supplied identifiers:** routes accept IDs in params/body; correctness depends on tenant-scoped queries, RLS, and explicit ownership checks — must be audited per protected operation.
- **Notifications:** self-scoped by auth + RLS; acceptable if only recipient can read/mark own notifications.
- **Ops/platform endpoints:** `/ops/status` and platform observability appear protected by platform actor/operator checks but require explicit, consistent documented enforcement.
- **Public/webhook endpoints:** intentionally unauthenticated; must remain signature/reference-verified and tenant-resolved server-side (no client tenant authority).

## 7. RLS dependencies (must preserve)

- Transaction-local GUCs set by `@medveris/db`/auth actor helpers are required by policies and functions (`app.current_tenant/user/patient/actor_kind/roles/platform_role/membership_id/unit_id/department_id`, `app.has_any_role`, `app.is_platform_operator`, etc.).
- `FORCE ROW LEVEL SECURITY`, grants to runtime/jobs/migrator roles, audit immutability and helper functions are integrity-critical (validated by migration runner).
- Any authz refactor must keep DB actor contexts accurate and must not bypass RLS.

## 8. Clinical signing and privileged operations (current evidence)

- Clinical note signing/amend/error/void/archive in `routes/clinical.ts` use `assertAuthorized` with policy checks requiring sign/amend privileges and credential validity where modeled.
- `packages/authz/src/index.ts` includes `canSignClinical`, `assertSign`, `canUseEmergencyOverride` (MFA-gated), emergency/diagnostic/radiology permission bundles.
- Privileged/platform operations: platform role request/approve/deny/cancel/revoke/expire flows with MFA step-up/SoD protections in `admin.ts` and `lib/platform-roles.ts`; finance SoD self-action guards in `finance.ts`.
- **Gap:** generalized dual authorization framework not active for all designated high-risk operations (Phase 1A requires design only).

## 9. Summary for WP-02/WP-03 implementation

- **Keep:** server-resolved identity/tenant/roles, RLS as independent layer, existing role/permission identifiers for compatibility, hash-chained audit/outbox patterns, CSRF and MFA requirements.
- **Centralize/add:** canonical authorization contract (action/resource/scope metadata, delegation boundaries, explicit deny), consistent backend enforcement helpers, endpoint/action protection inventory, compatibility mapping, and tests for allow/deny/tenant isolation/escalation/bypass cases.
- **Avoid:** inventing new business semantics, removing roles/permissions without mapping, weakening RLS, or enabling generalized dual-authorization execution in this phase.
