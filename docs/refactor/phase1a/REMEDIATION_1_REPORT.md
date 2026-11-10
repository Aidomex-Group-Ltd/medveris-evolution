# Phase 1A Remediation Increment 1 — Verification Report

**Branch:** `fix/phase1a-authz-remediation-1` (created from preserved working tree; no merge/push/deploy)  
**Baseline preserved:** prior Phase 1A artifacts remained in working tree; `packages/authz/src/index.ts` modification retained and no unrelated user changes discarded.  
**Scope:** canonical authz contract/helper semantics, backend authorization matrix, one bounded backend enforcement slice, focused tests/docs. No production/staging/DB migrations/secrets/Cloudflare changes.

## Stage 0 — Preserve work and establish baseline
- **Git state (before edits):** `phase1a/rbac-backend-authz`, `HEAD=origin/master=79d91a8`, dirty: modified `packages/authz/src/index.ts`; untracked `apps/api/src/lib/authorization.ts`, `docs/refactor/phase1a/*`, `packages/authz/src/contract.ts`, `tests/unit/authz-phase1a.test.ts`. No staged changes. No unrelated tracked/untracked user work observed beyond these Phase 1A artifacts.
- **Safety action:** created/switched to `fix/phase1a-authz-remediation-1` preserving working tree.
- **Baseline tests (recorded):**
  - `npm run -s typecheck`: initially hung beyond 120s in environment, later completed clean; final after remediation: **pass**.
  - `npm run -s lint`: initially hung beyond 120s in environment, later completed clean; final after remediation: **pass**.
  - `npx vitest run tests/unit/authz.test.ts tests/unit/authz-phase1a.test.ts`: **24 passed** before remediation; **28 passed** after remediation.

## Stage 1 — Canonical permission contract repairs
- **`isKnownPermission` fixed:** now validates against authoritative `Set(PERMISSIONS)` from `packages/authz/src/permissions.ts` (single registry). Unknown, empty, whitespace-only, and padded strings return `false`; all canonical permissions return `true`.
- **Legacy mappings reviewed:**
  - Preserved evidence-supported mappings (tenant admin, cashier/payment recording, diagnostics bundle, clinical sign, platform operator eligibility, content lifecycle checks) with clarified notes.
  - **`assertPriceListManager` corrected:** removed incorrect mapping to `finance.dashboard.read` (read-only). Marked `unresolved: true` with empty canonical permissions because no dedicated catalog/price-management permission exists and legacy guard is role-based mutation authority; owner decision required before introducing/changing permission semantics.
  - No mutation-to-read mapping retained; no existing route guards removed.
- **`normalizeRolesForCompatibility`:** retained for additive compatibility but made explicit and identity-preserving (`[...roles]` copy, no false normalization). No callers found outside authz contract/tests; not removed.
- **Contract boundary documented:** authentication, permission, contextual policy, domain invariant, and RLS distinguished in contract docs; permission check explicitly not a substitute for contextual/domain/RLS controls.
- **Action registry decision:** no runtime `ActionDefinition` registry introduced. Minimal typed `ActionDefinition` interface retained/documented only as future evidence-backed descriptor; current architecture composes canonical permissions with route/service contextual policy and resource assertions.
- **Tests:** `tests/unit/authz-phase1a.test.ts` expanded for registry validation, unresolved mapping semantics, and compatibility behavior.

## Stage 2 — Authorization helper semantics
- **`requestActor` (`apps/api/src/lib/actor.ts`):** missing authenticated context now throws `UnauthorizedError` (401) instead of `NotFoundError` (404). Documented as lightweight session-derived actor only (not full resource authorization).
- **`apps/api/src/lib/authorization.ts`:**
  - `requireSessionPermission`/`hasSessionPermission` documented as session-role permission checks only (401 when unauthenticated, 403 when missing permission), not tenant/resource ownership, live policy state, domain invariants, or RLS.
  - `requireAuthorized` documented as policy-engine evaluation against live access actor + supplied resource context, still requiring domain/RLS/operation-specific checks where applicable.
  - `requirePlatformOperator` now returns 401 when unauthenticated and 403 when lacking `platform_operator`; explicitly documented as role-eligibility gate only, not complete privileged execution context (no DB scoping, step-up, action-specific permission, or audit attribution guarantees).
- **Caller impact assessment:** `requestActor` has many callers; changing missing-auth semantics from 404 to 401 is safer/correct for unauthenticated contexts and aligns with `UnauthorizedError` conventions. No global error mapping changed. No mechanical route-guard replacement performed.
- **Focused tests:** helper behavior covered indirectly by updated contract semantics and existing authz unit suites; no new DB-backed API helper harness added in this increment.

## Stage 3 — Backend authorization matrix and selected slice
- **Matrix produced:** `docs/refactor/phase1a/BACKEND_AUTHZ_MATRIX.md` (evidence-based, route-group inventory with authn/permission/context/domain/RLS/audit/tests/findings, public/webhook compensating controls noted, gaps marked).
- **Selected bounded slice:** `workspace.ts` shared-supply endpoints (`GET /workspace/shared-supply`, `POST /workspace/shared-supply/transfers`, `POST /workspace/shared-supply/transfers/:id/receive`, `POST /workspace/shared-supply/transfers/:id/cancel`).
- **Selection justification:** coherent high-risk inter-tenant/organization inventory movement surface; clear permissions and existing session/tenant/DB arrangement primitives; existing happy-path integration coverage; no unresolved owner policy decision required.

## Stage 4 — Bounded backend enforcement implemented
**File:** `apps/api/src/routes/workspace.ts`
- `GET /workspace/shared-supply`: now requires active workspace link in accepted `shared-supply` mode (403 otherwise), filters transfers to those involving current tenant only, and keeps permission + staff/tenant context checks.
- `POST /workspace/shared-supply/transfers`: unchanged core dispatch logic except existing server-side arrangement validation retained (`app.shared_supply_organization`), tenant from session, permission `inventory.transfer.manage`, scoped location/item checks, audit/outbox preserved.
- `POST /workspace/shared-supply/transfers/:id/receive`: destination-tenant locked lookup retained; added server-side arrangement revalidation (`shared_supply_organization` for receiving/source pair must match transfer organization) before mutation; preserves status/lot/quantity/domain checks and audit.
- `POST /workspace/shared-supply/transfers/:id/cancel`: source-tenant locked lookup retained; added server-side arrangement revalidation for source/destination pair and transfer organization before compensating movement; preserves status/domain checks and audit.
- No client-supplied tenant authority trusted; tenant context remains server-resolved active tenant. RLS/staff actor contexts and domain invariants preserved. No broad guard replacements.

## Stage 5 — Tests and verification
- **Unit tests:** `tests/unit/authz.test.ts` + `tests/unit/authz-phase1a.test.ts` — **28/28 passed**.
- **Typecheck:** `npm run -s typecheck` — **pass**.
- **Lint:** `npm run -s lint` — **pass** (after removing unused helper/import introduced during iteration).
- **Selected-slice DB-backed/API-negative tests:** **not added/executed** in this increment. Existing `tests/integration/workspaces.test.ts` contains shared-supply happy-path coverage but was not run here (integration suite requires DB/test environment and is time-consuming); behavior changes were aligned to existing flow (accepted shared-supply mode required before dispatch/receive in that flow).
- **Background jobs/consumers:** not revalidated for selected slice; dispatch emits outbox event but consumer privilege binding not tested here (gap).

## Files changed in remediation increment
- `packages/authz/src/contract.ts` — canonical validation, mapping corrections/docs, contract boundary/version, compatibility semantics.
- `packages/authz/src/index.ts` — preserved prior Phase 1A export additions (no semantic regression introduced).
- `apps/api/src/lib/actor.ts` — unauthenticated `requestActor` now 401.
- `apps/api/src/lib/authorization.ts` — clarified helper boundaries and platform gate auth/error semantics.
- `apps/api/src/routes/workspace.ts` — bounded shared-supply contextual hardening.
- `tests/unit/authz-phase1a.test.ts` — updated/expanded contract tests.
- `docs/refactor/phase1a/BACKEND_AUTHZ_MATRIX.md` — evidence matrix and slice selection.
- `docs/refactor/phase1a/REMEDIATION_1_REPORT.md` — this report.

## Acceptance against mission
- Canonical permission validation is real: **yes**.
- Legacy mappings semantically defensible / unresolved explicitly marked: **yes** (`assertPriceListManager` unresolved, owner decision required).
- Helper behavior explicit and tested for contract semantics: **partially** (unit-tested contract/policy; no new integration tests for 401/403 helper call paths).
- Evidence-based matrix produced: **yes**.
- One bounded endpoint group consistently hardened: **yes (workspace shared-supply)**.
- Meaningful DB-backed/API-level security tests proving selected endpoints resist direct API and cross-tenant bypass: **not completed** (gap).
- Phase 1A not declared complete: **correct**.

## Remaining blockers / owner decisions
1. Define canonical permission (or explicit policy model) for price-list/catalog management; current `assertPriceListManager` cannot be safely mapped to existing permissions.
2. Confirm intended authorization for `facility-logo.ts` mutations (any staff vs admin/profile-manage permission).
3. Prioritize next bounded enforcement slices from matrix (finance high-risk mutations, patient-merge, admin/platform privileged actions, webhook/callback hardening, content/directory moderation, notifications self-scope evidence).
4. Run/add DB-backed negative tests for workspace shared-supply (unauthenticated 401, missing permission 403, cross-tenant transfer/resource access denied, client-supplied tenant ID cannot escalate, inactive membership/session/MFA cases as applicable, RLS independence) in a test DB environment.
