# Phase 1A — Canonical Permission Architecture

## 1. Design principles
- **Backend-enforced:** every protected API/service/background operation must be authorized server-side; UI restrictions are not controls.
- **Server-resolved identity:** user, session, MFA state, memberships, active tenant/organization context, roles, scope, platform roles, and policy actor attributes are resolved from trusted server/session/DB state (`authMiddleware`, `loadAuthContext`, `requestActor`, `loadAccessActor`), never accepted from client input as authority.
- **RLS is independent:** PostgreSQL RLS/FORCE RLS and transaction-local `app.*` context remain mandatory data-isolation controls; application authorization does not replace RLS.
- **Explicit deny:** missing permission/context/scope/MFA/engagement/credential/approval requirements result in deny (`ForbiddenError`, `PolicyDeniedError`/`AuthzError`).
- **Separation of concerns:** professional cadres, organizational job titles, and security permissions/roles are distinct. A title/cadre does not grant clinical/financial/platform privileges unless an explicit, verified role/permission mapping and contextual checks allow it.
- **Additive compatibility:** existing role and permission identifiers are preserved; changes are mapped before replacement.

## 2. Canonical contract elements (additive)
Defined in `packages/authz/src/contract.ts`:
- `AUTHZ_CONTRACT_VERSION`: `2026-11-10.phase1a`
- **Action definition:** `{ permission, domain, resource, verb, description, scope, dualAuthorizationCandidate? }`
- **Domains:** identity, organization, tenant, membership, patient, clinical, pharmacy, diagnostics, radiology, finance, billing, inventory, workforce, content, directory, integration, platform, audit, operations
- **Scopes:** global, platform, organization, tenant, department, unit, self, care-team, contextual
- **Delegation boundaries:** administrative, clinical, finance boundaries documenting what may/must-not be delegated and noting that titles do not imply privileges
- **Legacy check mapping:** compatibility links from legacy predicates/role checks to canonical permissions (evidence-based, extend only with verified behavior)

## 3. Identity and context model
- **Authentication:** session cookie + server-side session lookup/revocation/expiry checks; CSRF token required for state-changing API/FHIR/terminology requests (with defined auth/bootstrap exemptions).
- **Staff facility access:** active membership in selected tenant, staff MFA enrollment/verification as required, optional department/unit scope.
- **Patient access:** verified patient account/linkage and released/self/proxy/consent constraints.
- **Platform access:** explicit platform roles (`platform_operator`, `credential_reviewer`, etc.) resolved server-side; operator actions use `withPlatformActor`/operator guards.
- **Organization access:** organization membership role checks (`requireOrganizationActor`/`requireRole`) independent of facility active tenant where applicable.
- **Policy actor:** `loadAccessActor`/`loadStaffAccessActor` assembles live engagement, assignments, cadres/specialties, privileges, credentials, care-team, proxy scopes/expiry for contextual decisions.

## 4. Authorization decision layers
1. **Route/transport guard:** authenticate and establish required actor type (public, auth, patient, staff, reviewer, operator, org member).
2. **Session/permission gate (fast path):** `permissionsForRoles(requestActor(c).roles).has(permission)` / canonical helper for actions fully represented by role bundles.
3. **Contextual policy decision:** `assertAuthorized(loadAccessActor(...), permission, resource)` for actions requiring care relationship, consent, sensitivity, credential, privilege, SoD, content audience, expiry, proxy scope, etc.
4. **Domain/service invariants:** ownership/state/scope checks (e.g. department/unit/location, billing scope, order ownership), idempotency, and business constraints.
5. **Database RLS:** final enforcement using transaction context; queries/mutations must run in appropriate actor context.

## 5. Permission and role boundaries
- **Clinical:** read/write/order/result/referral/care-team/note lifecycle permissions; signing/amendment/emergency access require specific permissions plus contextual controls (privilege, credential, MFA, care relationship/legal basis as applicable).
- **Financial:** payment recording, billing, catalog/pricing, reporting, and procurement permissions separated by role; high-risk money mutations require SoD and are candidates for future dual authorization.
- **Administrative:** membership, workspace/profile, onboarding, organization structure/linking scoped to authorized tenant/organization and delegation boundaries; cannot imply clinical signing or financial privilege.
- **Platform:** platform operations/credential review isolated from routine tenant roles.
- **Ownership:** `owner` implies facility administration compatibility but ownership-specific protections (e.g. removal/grant constraints) must remain explicit.

## 6. Tenant/organization isolation requirements
- Active tenant derived from validated membership/session context; tenant-switch only to memberships owned by authenticated user.
- Cross-tenant access denied unless an explicit, authorized platform/organization/reporting mechanism applies and is audited.
- Cross-organization access governed by organization memberships and approved site/link visibility rules.
- Resource identifiers from path/query/body are untrusted selectors and must be validated against actor scope and/or tenant-scoped queries under RLS.

## 7. Dual authorization boundary (design only in Phase 1A)
- High-risk operations are identified for generalized four-eyes workflow (see `DUAL_AUTH_DESIGN.md`).
- Current implementation includes targeted controls (platform operator request/approve flows, finance self-action SoD guards, content separation-of-duties cases) but **generalized dual authorization is not activated** for all designated operations.
- Approval thresholds, approver roles, expiry, and emergency exceptions require owner approval.

## 8. Compatibility posture
- Preserve existing `ROLES`, `PERMISSIONS`, `ROLE_PERMISSIONS`, implied/scoped role behavior, and policy reason codes unless a verified, mapped change is approved.
- New enforcement should prefer canonical helpers and explicit permission checks; ad-hoc checks may remain temporarily where behavior-equivalent and evidenced.
