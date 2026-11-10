# Architecture & Refactoring Conventions (Phase 1.1)

Purpose: enable safe, incremental modularization of Medveris while preserving behavior, data integrity, and security.

## Target layering (per domain slice)

1. **Route/controller** (`apps/api/src/routes/*`): HTTP binding only - parse/validate request (contracts/zod), extract actor/context, call application service, map result/errors to HTTP. No business rules or direct multi-step domain decisions.
2. **Application/service** (`apps/api/src/services/*` or domain-specific service modules): orchestrates use cases - authorization checks (central), transactions, idempotency, audit/outbox emission, calls domain + repositories/adapters.
3. **Domain** (`packages/domain/*`): pure business rules, invariants, state transitions, calculations/value objects; no IO/framework dependencies where practical.
4. **Data access/adapters** (`packages/db` helpers, repository modules, `apps/api/src/integrations/*`): SQL/RLS-aware queries, external system adapters; enforce scoped context and safe parameterization.
5. **Cross-cutting libs** (`apps/api/src/lib/*`, `packages/auth`, `packages/authz`, `packages/platform`): auth/session, policy, audit, errors, rate/usage, storage, telemetry - single-responsibility, reusable.

> Existing code mixes layers (especially large routes). Refactor by extracting seams slice-by-slice without changing contracts/behavior unless fixing confirmed defects.

## Conventions

- **Validation & contracts:** validate inputs at boundaries using shared contracts (`packages/contracts`, zod) consistent with API behavior; reject invalid/unauthorized early.
- **Authorization:** deny by default; backend-enforced via centralized policy/RBAC checks + RLS/tenant scoping. UI checks are advisory only. Preserve separation of ownership/admin/clinical responsibility and separation of duties for sensitive ops.
- **Audit/outbox:** every sensitive/state-changing action (and protected reads as required) must emit complete audit records (actor(s), tenant, timestamp, action, affected record, previous/new state, approval state where applicable) and outbox events transactionally when needed; preserve hash-chain/immutability guarantees.
- **Transactions:** multi-record writes in a single DB transaction with per-tx RLS context (`withActor/withStaffActor/...` patterns); avoid partial side effects.
- **Idempotency:** retryable commands (registrations, billing/checkout callbacks, order creation/routing, payments, jobs) must use idempotency keys/unique constraints and return consistent outcomes on replay.
- **Errors/logging:** use typed/domain errors mapped centrally; never leak secrets, PHI, tokens, or internal details in responses/logs.
- **Subscriptions:** protected operations must check facility subscription state server-side; historical/read-only continuity per policy must not be broken.
- **Interoperability:** use centralized, versioned terminology/mapping layer; preserve original clinical text alongside codes; gate unsupported/unlicensed capabilities explicitly.

## File/module size and structure

- Target ~200 LOC average per source file where practical; justify and track exceptions >300 LOC.
- One responsibility per module; prefer explicit names and domain folders (e.g. `services/finance/*`, `routes/clinical/*` helpers) over god files.
- Extract shared DTOs/helpers only when reused or clearly cohesive; avoid speculative abstraction.

## Priority extraction seams (monoliths)

| Area | Current hotspots | First safe slices |
|---|---|---|
| Auth/RBAC/admin access | `routes/auth.ts`, `routes/admin.ts`, `lib/platform-roles.ts`, `services/access.ts` | session/authorization helpers, permission checks, invitation/privilege subflows |
| Subscription/billing/finance | `routes/finance.ts`, `routes/billing.ts`, `services/{billing,subscriptions,subscription-checkout}.ts`, `lib/billing-middleware.ts`, jobs billing | subscription policy/enforcement service, invoice/payment command handlers, report calculators |
| Clinical/orders workflow | `routes/{clinical,workflow,reception,diagnostics,radiology,inpatient,pharmacy-pos}.ts`, `services/clinical.ts` | order creation+routing+status service, result linkage, triage/encounter note commands |
| Inventory/operations/content | `routes/{inventory,operations,content,organization,onboarding}.ts` | stock/movement commands, org/workspace setup slices |
| Contracts/UI | `packages/contracts/src/index.ts`, `apps/web/src/components/AppShell.tsx`, large pages/CSS | domain-split contract modules, layout primitives, page container/presentational splits |

## Refactor workflow per slice (Prompt 1.2+ template)

1. Identify behavior, callers, DB tables, audit/outbox, and tests for the slice.
2. Add/confirm characterization tests (or existing coverage) before moving logic.
3. Extract behind same public interface/contract; keep schema/API backward-compatible.
4. Run targeted typecheck/lint/tests; fix regressions; document defect fixes if any.
5. Record execution in `REFACTOR.md` and commit with working tree clean.

## Definition of done (architecture)

- Clear ownership of validation, authz, transaction, audit, and domain logic per slice.
- Reduced coupling and file size where touched, with no unintended behavior/data changes.
- Security controls enforced server-side; test evidence recorded.
