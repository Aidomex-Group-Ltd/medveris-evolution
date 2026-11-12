# Baseline Report — Phase 1.2 Authorization Matrix Modularization

**Date:** 2026-11-12  
**Branch:** `phase1a/shared-supply-security-closure`  
**Baseline snapshot:** Pre-modularization, pre-route-adoption state

---

## 1. Current Branch and HEAD State

- **Branch:** `phase1a/shared-supply-security-closure`
- **Remote tracking:** `origin/phase1a/shared-supply-security-closure`
- **Current HEAD:** `phase1a/shared-supply-security-closure` pointing at local commit
- **Staged changes:** none
- **Unstaged changes:** 
  - `REFACTOR.md` — updated with status rescan & REFACTOR tracker update
  - `packages/authz/src/index.ts` — matrix API exports added
  - `packages/authz/src/permissions.ts` — 5 new permissions added (`patient.merge.approve`, `patient.merge.request`, `finance.catalog.manage`, `document.template.publish`, `reports.run`)
  - `packages/authz/src/policy.ts` — extended `PolicyActor` (`organizationIds`, `unitId`), `ResourceContext` (`organizationId`, `unitId`), `PolicyReason` (5 new reasons)
- **Untracked files** (new foundation assets):
  - `packages/authz/src/matrix.ts` — canonical authorization matrix (125 entries)
  - `tests/unit/authz-matrix.test.ts` — 17 matrix decision contract tests
  - `docs/refactor/final-remediation-20261111/09_PRODUCTION_DEPLOYMENT_AND_BOOTSTRAP_REPORT.md`

---

## 2. Existing Implementation Snapshot

### 2.1 `packages/authz/src/matrix.ts` (new — foundation)

- **Version:** `2026-11-12.phase0-1.foundation`
- **Total entries:** 125 `MatrixEntry` records
- **Status distribution:**
  - `canonical`: 98 entries (permission present, owner-approved)
  - `legacy`: 26 entries (role/predicate checks remain authoritative; no dedicated canonical permission yet)
  - `unresolved`: 1 entry (`patient.merge.request`, `permission: null`, always denies)
- **Entry domains covered:** patient, clinical, reception, inpatient, pharmacy, radiology, diagnostics, finance, billing, inventory, organization, workforce, onboarding, content, directory, integration, audit, platform, billing, radiology, clinical, emergency, telemetry
- **Key types exported:**
  - `AuthorizationScope`: `global | platform | organization | tenant | department | unit | self | care-team | contextual`
  - `MatrixEnforcement`: `session-permission | policy | role-predicate | platform-operator | organization-role | webhook | public | authenticated-self | system`
  - `MatrixRequirement`: tenant, membership, mfa, engagement, care-relationship, consent, credential, privilege, department-scope, unit-scope, resource-ownership, separation-of-duties, signature-verification, platform-role, organization-membership
  - `MatrixStatus`: `canonical | legacy | unresolved`
  - `MatrixEntry`: key, domain, resource, verb, description, scope, permission, routeFile, routePatterns, enforcement, tenantBound, rls, requirements, dualAuthorizationCandidate, status, notes
- **Lookup helpers:** `isKnownMatrixAction`, `getMatrixEntry`, `matrixEntriesForDomain`, `matrixEntriesForRouteFile`, `matrixEntriesForPermission`, `matrixDualAuthorizationCandidates`, `matrixUnresolvedActions`
- **Decision contract:** `decideAction()`, `assertMatrixAuthorized()`, `MatrixDeniedError`
- **Non-permission endpoints:** `NON_PERMISSION_ENDPOINTS` (public, webhook, health, authenticated-self, flow-token routes with controls)

**5 owner-approved canonical entries added during foundation:**
- `finance.catalog.manage` — maps to `finance.catalog.manage` permission
- `document.template.publish` — maps to `document.template.publish` permission
- `patient.merge.approve` — maps to `patient.merge.approve` permission
- `reports.run` — maps to `reports.run` permission
- `patient.merge.request` — kept as `unresolved` (`permission: null`)

### 2.2 `packages/authz/src/permissions.ts`

- **Total listed permissions:** ~136 action-based permissions
- **Permission format:** explicit, action-based strings; never bypasses contextual checks
- **Role-permission mapping:** `ROLE_PERMISSIONS` matrix mapping 43 roles to their permitted actions
- **Core categories:** patientSelf, inventoryRead, clinicalCore, nursingCore, diagnosticCore, contentEditorCore, adminCore, inventoryOperate
- **5 new permissions added:**
  - `patient.merge.approve`
  - `patient.merge.request`
  - `finance.catalog.manage`
  - `document.template.publish`
  - `reports.run`

### 2.3 `packages/authz/src/policy.ts`

- **Policy version:** `medveris-policy-1.0`
- **PolicyActor extended with:** `organizationIds?`, `unitId?`
- **ResourceContext extended with:** `organizationId?`, `unitId?`
- **PolicyReason extended with:** `platform-role-required`, `organization-mismatch`, `unit-mismatch`, `unknown-action`, `unresolved-action`
- **PolicyDecision:** `allowed`, `reason`, `permission`, `policyVersion`
- **`authorize()` engine:** role-permission check first, then contextual guards (tenant, care relationship, consent, sensitivity, expiry, credential, privilege, separation-of-duties, platform role, organization scope)

### 2.4 `packages/authz/src/index.ts`

- **Roles:** 43 role constants (patient, proxy, receptionist, nurse, midwife, clinician, specialist_clinician, diagnostic_practitioner, department_lead, facility_admin, finance, auditor, credential_reviewer, pharmacist, laboratory, radiology, radiographer, radiologist, lab_validator, ward_manager, privacy_officer, public_health, hr, records, theatre, housekeeping, porter, mortuary, cssd, biomedical, it_admin, research, content_editor, content_reviewer, opportunity_moderator, owner, department_admin, unit_lead, staff, report_viewer)
- **Exported matrix API (previously):** `AUTHZ_CONTRACT_VERSION`, `ADMINISTRATIVE_DELEGATION_BOUNDARIES`, `LEGACY_CHECK_MAPPINGS`, `isKnownPermission`, `normalizeRolesForCompatibility`
- **Newly added exports from `matrix.js`:**
  - `AUTHORIZATION_MATRIX`, `AUTHORIZATION_MATRIX_VERSION`, `NON_PERMISSION_ENDPOINTS`, `MatrixDeniedError`, `assertMatrixAuthorized`, `decideAction`, `getMatrixEntry`, `isKnownMatrixAction`, `isKnownMatrixPermission`, `matrixDualAuthorizationCandidates`, `matrixEntriesForDomain`, `matrixEntriesForPermission`, `matrixEntriesForRouteFile`, `matrixUnresolvedActions`
- **Type exports:** `AuthorizationScope`, `MatrixDecision`, `MatrixEnforcement`, `MatrixEntry`, `MatrixRequirement`, `MatrixStatus`, `NonPermissionEndpoint`, `PolicyActor`, `ResourceContext`, `PolicyReason`, `PolicyDecision`

### 2.5 `tests/unit/authz-matrix.test.ts` (new — 17 tests)

- **Test suite:** authorization matrix integrity + decision contract
- **Coverage:**
  - Unique/stable action keys
  - Canonical permission invariant (unresolved → null)
  - HTTP route binding for every action
  - Non-permission endpoint coverage with controls
  - Dual-authorization candidates design-only entries
  - Lookup helpers (by key, domain, route file, permission)
  - Matrix versioning independent of policy engine
  - Decision allows canonical care-team action under matching context
  - Policy engine composed before matrix checks
  - Unresolved actions denied even when actor privileged
  - Unknown action keys denied
  - Platform role requirement for platform-scoped actions
  - Organization scope enforcement
  - Self-scope and separation of duties enforcement
  - Structured `MatrixDeniedError` throw for `assertMatrixAuthorized`
  - Accepts resolved MatrixEntry directly
  - **Plus new tests for:** canonical action permission denial, unresolved action with null permission

- **All 17 tests pass** against the foundation matrix

### 2.6 `REFACTOR.md`

- **Phase 1A tracker** updated with status, completed work, and remaining blockers
- **Execution records** for prompts 0.1–0.3, 1.1, 2.1/2.2, 2.3, 4.1–4.3, 5.1–5.2, 6.x, 7.x, 8.x, 9.x, 10.x
- **Current overall status:** partial (foundation + contract + tests complete; route rewiring and unresolved-permission decisions pending)

---

## 3. Exported Public API (Pre-Modularization)

| Export Path | Exported Items |
|---|---|
| `packages/authz/src/matrix.ts` | `AUTHORIZATION_MATRIX`, `AUTHORIZATION_MATRIX_VERSION`, `NON_PERMISSION_ENDPOINTS`, `MatrixDeniedError`, `assertMatrixAuthorized`, `decideAction`, `getMatrixEntry`, `isKnownMatrixAction`, `isKnownMatrixPermission`, `matrixDualAuthorizationCandidates`, `matrixEntriesForDomain`, `matrixEntriesForPermission`, `matrixEntriesForRouteFile`, `matrixUnresolvedActions`, `AuthorizationScope`, `MatrixDecision`, `MatrixEnforcement`, `MatrixEntry`, `MatrixRequirement`, `MatrixStatus`, `NonPermissionEndpoint` |
| `packages/authz/src/index.ts` | All of the above + `ROLES`, `Role`, `IMPLIED_ROLES`, `SCOPED_ROLES`, `hasWorkspaceWideScope`, `withImpliedRoles`, `ActorContext`, `hasUnitAccess`, `hasDepartmentAccess`, `canReadClinical`, `canWriteClinical`, `canSignClinical`, `canManageTenant`, and 30+ assertion/authorization helpers + `ROLE_PERMISSIONS`, `permissionsForRoles` |

---

## 4. Existing Test Baseline

| Test File | Tests | Status |
|---|---|---|
| `tests/unit/authz-matrix.test.ts` | 17 | ✅ All pass |
| `tests/unit/authz.test.ts` | 12 | ✅ All pass |
| `tests/unit/authz-phase1a.test.ts` | 16 | ✅ All pass |
| **Total** | **45** | ✅ **All pass** |

**Typecheck:** `tsc -p tsconfig.json --noEmit` → exit 0  
**Lint:** `eslint . --max-warnings=0` → exit 0

---

## 5. Changes Already Made (Unstaged, Preserved)

The following changes are present in the working tree but **must not be overwritten** during modularization:

- `packages/authz/src/matrix.ts` — full canonical matrix with 125 entries, version `2026-11-12.phase0-1.foundation`
- `packages/authz/src/permissions.ts` — 5 new permissions added (`patient.merge.approve`, `patient.merge.request`, `finance.catalog.manage`, `document.template.publish`, `reports.run`)
- `packages/authz/src/policy.ts` — `organizationIds`, `unitId` on `PolicyActor`/`ResourceContext`; 5 new `PolicyReason` entries
- `packages/authz/src/index.ts` — matrix API re-exports added
- `tests/unit/authz-matrix.test.ts` — 17 matrix decision contract tests
- `REFACTOR.md` — execution record for foundation phase

**These must be preserved** through the modularization process. The goal is to restructure the code without changing the behavioral contract.

---

## 6. Baseline Verification

- ✅ Typecheck passes
- ✅ Lint passes
- ✅ 45/45 authorization unit tests pass
- ✅ Matrix version: `2026-11-12.phase0-1.foundation`
- ✅ 125 matrix entries: 98 canonical, 26 legacy, 1 unresolved
- ✅ All lookup helpers functional
- ✅ `decideAction()`/`assertMatrixAuthorized()` decision contract verified
- ✅ Non-permission endpoints explicitly catalogued with controls

---

## 7. What Must Not Change (Preservation Requirements)

- No resetting, cleaning, stashing, or branch switching
- No discarding working-tree changes
- No overwriting unrelated user changes
- No weakening of permissions, RLS, or tenant isolation
- No creating a second authorization system
- No marking frontend-only protection as API enforcement
- No marking endpoints exempt to avoid implementing authorization
- No granting ordinary facility users platform authority
- No allowing self-approval of protected operations
- No forcing `any` types to bypass type checking
- No silent fallbacks that grant access when an action is missing
- No domain module importing from the matrix compatibility facade
- All existing import paths must remain compatible
- `decideAction()` and `assertMatrixAuthorized()` must retain previous behavior
- `AUTHORIZATION_MATRIX_VERSION` must remain `2026-11-12.phase0-1.foundation`
- `Permission` type must remain a `Set` of explicit action strings
- `PolicyReason` must retain all existing values plus the 5 new ones

---

## 8. Next Stage Dependency

**Stage 1 (Modularization)** depends on this baseline being recorded and preserved. All subsequent stages reference this snapshot.

--- 

*End of baseline report.*