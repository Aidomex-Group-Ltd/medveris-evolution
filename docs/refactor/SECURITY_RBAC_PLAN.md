# Security, RBAC, Dual Authorization & Audit Plan (Phase 2.1 baseline)

Date: 2026-11-10. Discovery/planning artifact to guide incremental implementation. No runtime behavior changed by this document.

## Current controls (observed)

- **Identity/session:** `apps/api/src/auth/{middleware,session,integration}.ts` - session/CSRF enforcement for state-changing API/FHIR/terminology paths, MFA expectations for staff, actor context with tenant/unit/department/roles/platform roles, DB helpers `withActor/withStaffActor/withPlatformActor/withReviewerActor`.
- **RBAC primitives:** `packages/authz/src/index.ts` (roles, implied/scoped roles, capability helpers), `permissions.ts` (action permissions + role bundles), `policy.ts` (`authorize`/`assertAuthorized`, contextual checks incl. MFA/membership/tenant/care relationship/consent/credential/sensitivity/self-approval/separation-of-duties/content rules). `apps/api/src/lib/scope.ts` and route-level checks exist in parallel.
- **Data isolation:** Postgres RLS with per-transaction context GUCs (`packages/db/src/index.ts`), FORCE RLS patterns in migrations, runtime role separation.
- **Audit/outbox:** `apps/api/src/lib/audit.ts` - hash-chained, HMAC-signed append-only `audit_events` + `outbox_events`, request/audit helpers and broad usage in routes/services.
- **Privileged/sensitive flows:** platform operator request/approve/deny/revoke/expire and break-glass grant handling in `apps/api/src/lib/platform-roles.ts`; emergency override create/review in `routes/consent.ts` with reauth/audit; some separation-of-duties checks in policy (content publish/review, certain approvals).
- **Subscription enforcement:** recently hardened in `apps/api/src/lib/billing-middleware.ts` to block protected mutations when facility subscription restricted (enforce mode), with allowlist for recovery/care continuity (incremental, needs policy refinement/tests).

## Gaps vs master requirements

1. **Canonical granular RBAC:** no single owner-configurable permission assignment model fully separated into ownership/administrative/clinical responsibility; permissions partly role-bundle and ad-hoc route checks.
2. **Consistent enforcement:** authorization split across policy engine, helper predicates, route logic, and RLS - risk of drift and missed endpoints/resources/actions.
3. **Dual authorization (four-eyes):** not generalized for all designated high-risk operations; exists in specific platform/content/credential flows but financial adjustments/reversals/refunds, sensitive patient-record modifications, and privileged access changes need explicit, auditable request/approve/execute workflow where initiator cannot self-approve.
4. **Audit completeness:** must verify every sensitive operation and protected PHI read records initiator, approver (if any), timestamp, action, affected record, previous/new state, approval status, correlation/tenant context; ensure immutable reviewability.
5. **Owner/admin/clinical separation:** owner capabilities and delegation model need explicit boundaries and configurable grants/revocation.

## Designated high-risk operations (candidate inventory for dual authorization)

Must be confirmed against actual route/service behavior and refined per facility policy:

| Domain | Operations (examples) | Current state (to verify) | Target control |
|---|---|---|---|
| Finance/billing | invoice/payment reversal or void, refund, manual adjustment/write-off, discount/price override above policy, receivable reconciliation corrections, payout/payroll approval-release | route/service-specific checks; dual-approval likely incomplete | request→independent approve→execute, immutable audit with before/after, no self-approval |
| Clinical records | sensitive record amendment/redaction/entered-in-error corrections beyond normal versioning, merge/unmerge identities, restricted/sensitive data access grants, break-glass closure/review actions where policy requires | versioning/signing/consent/emergency override exist; dual control not universal | policy-defined dual approval + audit trail |
| Access/privilege | role/permission grant or escalation, platform/operator privilege changes, membership activation in sensitive roles, security policy/config changes, API/integration credential issuance | platform-role workflows exist; general privileged access changes need coverage | separation of duties, independent approval, session/token impact audited |
| Subscription/admin | plan/entitlement overrides, forced reinstatement/suspension actions with financial impact (platform/support) | platform billing routes exist | controlled platform authorization + audit |

## Implementation approach (incremental)

- **2.1:** finalize permission taxonomy & data model (additive) for configurable grants; map every protected action to resource+operation+scope.
- **2.2:** introduce/expand centralized authorization middleware/service per route group; migrate high-risk modules first (auth/admin/billing/finance/clinical records/exports/integrations).
- **2.3:** implement reusable dual-approval entity/workflow (request, required approver policy, approve/reject, execute with state transition, idempotency, expiry) and integrate into designated operations.
- **2.4:** audit middleware/hooks to guarantee before/after snapshots and approver linkage for sensitive mutations and required protected reads; add review/export queries for authorized auditors.
- **2.5:** harden PHI/secret handling in logs/errors/uploads/exports and validate session/token revocation on privilege changes.

## Verification requirements

- Unit/integration tests per permission matrix and denied/allowed edge cases.
- Negative tests for bypass (direct API, role spoofing impossible server-side, UI-only disabled controls irrelevant, self-approval, cross-tenant, restricted subscription where applicable).
- Dual-auth tests: cannot execute without approval, approver != initiator, stale/replayed requests rejected, full audit chain.
- RLS and tenant isolation regression tests remain green.

## Risks

- Behavior changes for previously over-permissive flows; must migrate with compatibility mapping and clear errors.
- Performance/audit volume; design efficient append-only storage and indexing.
- Complex workflows need careful UX and operational procedures (documented separately).
