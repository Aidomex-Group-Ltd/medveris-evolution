# Medveris Refactoring & Enhancement Plan (REFACTOR.md)

Master implementation tracker for incremental refactoring of the existing Medveris healthcare platform. This file decomposes the full master requirements into small, verifiable implementation prompts/units. Treat each prompt as a scoped change request to be executed in order unless dependencies require reordering; verify and document outcomes before proceeding.

> **Non-negotiable constraints (apply to every prompt)**
> - Preserve existing functionality, patient/operational data, and established architectural decisions unless a documented technical justification requires change.
> - No destructive DB migrations without approved migration + recovery strategy, backups, rollback plan, and validation on representative data. Maintain referential integrity, transactions for multi-record writes, idempotency for retries, and backward-compatible schema/API changes where possible.
> - Enforce security on backend (RBAC, subscription, sensitive ops), not UI-only. Never expose secrets/PHI in logs/errors/responses.
> - Do not claim completion because build/dashboard loads; verify actual behavior and tests per affected module. Do not silently skip requirements—document blockers/dependencies.
> - Prefer incremental, minimal-risk changes; avoid unnecessary rewrites or technology replacement.

## Current status (rescan 2026-11-11)

- **Branch/deploy:** `master@92da33b` = `origin/master` (clean). Production `medveris-production` serving `4778062e-20d3-4b00-9da3-b9c4bb0881d2@100%` (tag `92da33b`, `medveris.online`, promoted 2026-11-11; evidence `.wrangler/release-evidence/production-2026-11-11T07-47-16-023Z.json`). Deploy gates for that release passed (lint/typecheck/tests 765/88, audit, build, packaging, staged verification/smoke). Prod DB `medveris-prod` migration state readable/applied (75, up to date) per gate evidence.
- **Phase 1A (deployed, partial):** remediation increment 1 code/docs merged in ancestors (`f34666a` + follow-ups `1a87e54,3883e88,6d3bc9b,92da33b`) — additive authz contract/helpers (`packages/authz/src/{contract,index}.ts`, `apps/api/src/lib/{actor,authorization}.ts`), workspace shared-supply safety behavior, targeted tests, `docs/refactor/phase1a/*`, `tests/unit/authz-phase1a.test.ts`. **Not fully complete/verified (resumed 2026-11-11):** added focused shared-supply negative/invariant/audit integration cases in `tests/integration/workspaces.test.ts` with targeted suite/typecheck/lint passing; generalized dual-approval workflow not activated; uniform RBAC/policy adoption, full permission-matrix & negative/security coverage (cross-tenant/forged-destination/ended-link/invariants, conditional RLS proof, audit success/no-success-on-denial, outbox consumer/poison/dedup), and `requestActor` 404→401 full impact require further verification/hardening (see `docs/refactor/phase1a/REMEDIATION_1_REPORT.md`).
- **Overall:** Phases 0.1, 0.3, 1.1 recorded completed; most prompts are **partial/not started** with significant external blockers in terminology/interoperability, partners/credentials, governance/ops, and large modularization/feature work.

### Prompt status matrix (unfinished focus)

| Phase/Prompt | Status | Unfinished work / notes | Blockers (if any) |
|---|---|---|---|
| 0.1 Audit & traceability | completed | — | — |
| 0.2 Baseline verification harness | partial | Continuous recorded baseline in clean env; expand module-targeted/e2e/smoke conventions | Some integration/e2e/smoke require DB/services/env |
| 0.3 Data safety/migration/rollback | completed | — | Backup/PITR/restore-drill tooling & approvals for non-synthetic envs |
| 1.1 Module boundaries/conventions | completed | — | — |
| 1.2+ Decompose monoliths by slice | not started | Extract services/domain/data-access for hotspots (`routes/inventory,finance,clinical,radiology,reception,inpatient,organization,auth,workflow,content`, etc.) with tests, no behavior change | Risk of regressions; requires incremental, well-tested slices |
| 1.3 Contracts/types rationalization | not started | Split/version `packages/contracts`, remove dead/dup schemas, align validation | Backward-compat with API/web clients |
| 2.1 RBAC model consolidation | partial | Canonical granular/owner-configurable permission model, additive schema/backfill/mapping, single authoritative decision path | Policy/product decisions for custom permissions |
| 2.2 Enforce RBAC consistently | partial (1A slice deployed) | Centralized checks across all protected routes/services, untrusted-ID scoping, deny-by-default, permission-matrix tests | Large surface; behavior parity risk |
| 2.3 Dual authorization (SoD) | partial | Generalized request→independent approve→execute workflow (states, expiry, actor separation, persistence/audit/idempotency/UI) for all designated high-risk ops | Facility policy config, governance, UX/process for single-operator workflows |
| 2.4 Immutable/complete audit trail | partial | Coverage of prev/new state, approver fields, sensitive/protected-read auditing, review/query paths per action | Perf/storage/privacy review |
| 2.5 Session/credential/data-protection hardening | open | PHI/secret leakage review, secure invitations/uploads/exports/access control, targeted security tests | Security/privacy review |
| 3.1 Central subscription enforcement | partial | Exhaustive protected-route classification/policy config, allow/deny tests (preserve read-only/emergency/care continuity) | Policy refinement per module |
| 3.2 Subscription lifecycle/checkout/restoration | open/partial | Verified transitions, payment callback idempotency/dup handling, automatic restoration tests | Provider sandbox/credentials/config |
| 3.3 Usage metering & frontend UX alignment | open | UI states aligned to backend (no bypass) across modules | — |
| 4.1 Responsive design foundations | partial | Universal table labeling/contract, primitives coverage, full verification | — |
| 4.2 App shell/navigation/core interactions | partial | Full small-screen nav/overlays/search/notifications/accessibility verification & fixes | Design/accessibility review |
| 4.3+ Module-by-module responsive retrofit | partial | Broad retrofit + per-module viewport checks for diagnostics/radiology/lab, pharmacy/POS, inpatient/theatre/maternity/emergency, finance/billing/reports, inventory/procurement/ops, admin/workforce/credentials/documents, directory/content/public, deep encounter subcomponents, etc. | Large UI surface, regression risk |
| 5.1 Registration→initial billing (backend) | partial | Exemptions/insurance/discounts/zero-cost policy, broader concurrency/retry/reconciliation, env/CI verification | Facility policy/config, product rules |
| 5.2 Registration/billing UX visibility | partial | Richer billing-radar/reconciliation visibility, end-to-end UX verification | — |
| 6.1 Finance domain/ledger consistency | open/partial | Normalize flows, invariants, idempotent money commands, authz/dual-auth hooks, reconciliation tests | Domain review |
| 6.2 Payroll module | largely unimplemented | Employment profiles, salaries/allowances, periods/runs, deductions/components, payment history, payslips, reports (additive schema, tx/idempotent/audit) | HR/payroll rules, approvals |
| 6.3 Operational expenditure tracking | unimplemented | Categories, approvals/authz, traceable CRUD/reporting | Policy/approvals design |
| 6.4 Financial reporting & exports | incomplete | Revenue/expenditure, cash flow, receivables, payroll expenditure, ops cost, P&L; authorized exports, reconciliation | Depends on 6.1–6.3 data correctness |
| 7.1 Unified clinical order model & routing | incomplete | Immediate destination queue routing, unique IDs/notifications/events, consistent statuses across departments | Cross-module state design |
| 7.2 Result/service completion linkage | incomplete | Link results/services to originating order/encounter, authorized clinician review | — |
| 7.3 Idempotency/retries/failure handling | incomplete | Prevent duplicate orders, safe retry/failure states, observable non-PHI errors | — |
| 7.4 Workflow verification (OPD/IPD/pharm/lab/rad) | incomplete | End-to-end acceptance scenarios, document clinical-safety/operational gaps | Clinical validation |
| 8.1 Configurable cadres/departments/roles model | incomplete | Data-driven searchable taxonomy, add cadres without code changes, cadre/department/system-role/permission separation | Data modeling/migration |
| 8.2 Invitations/secure onboarding/auth assignment | incomplete | Secure flows, least privilege, success/expiry/duplicate/unauthorized-assignment tests, mobile-first UX | Email/token/env config |
| 9.1 Central terminology & code-mapping platform | incomplete | Versioned/effective-dated mappings, internal↔standard, audit, import/load, no hard-coding | **Licensing/distribution (SNOMED/ICD-11/LOINC)**, content access |
| 9.2 LOINC integration | incomplete/blocked | Mapped lab/observations, validation/reporting hooks | **Licensed/reference data** |
| 9.3 ICD-11 integration | incomplete/blocked | Searchable/version-aware diagnosis coding/mapping | **External access/licensing** |
| 9.4 SNOMED CT integration | incomplete/blocked | Clinical concept representation/mapping/fallbacks | **Licensing/territory** |
| 9.5 HL7 FHIR R4 expansion | partial | Truthful CapabilityStatement, broader resources/interactions, tenant/patient scoping, validation, tests | Partner/use-case validation, safe write semantics |
| 9.6 DICOM/DICOMweb imaging | partial | Strengthen QIDO/WADO, assess/implement STOW-RS, linkage/access/audit verification | **PACS/config/architecture**, fake PACS in dev |
| 10.1 Data integrity & idempotency hardening | incomplete | Transactions/unique keys/retry safety across key workflows, concurrency/retry tests | — |
| 10.2 Comprehensive automated & scenario testing | incomplete | Coverage per acceptance criteria (security, subscription, clinical routing, finance/payroll, interop, mobile, migration integrity) | Env/fixtures/external sandboxes |
| 10.3 End-to-end regression, docs, final report | incomplete | Full evidence run and final implementation report | Depends on prior phases |

## Incremental execution procedure (mandatory per phase/slice)

1. **Select slice:** pick next feasible unfinished prompt/slice with satisfied dependencies (or document why blocked/deferred). Keep scope bounded and low-risk.
2. **Pre-check:** confirm clean working tree, review relevant code/tests/docs, ensure data-safety protocol for any schema/data change (no destructive changes without approved plan).
3. **Implement:** minimal, behavior-preserving change where possible; backend-enforced security/subscription; additive, backward-compatible migrations only with RLS/grants/integrity.
4. **Verify:** run targeted checks for touched scope (`typecheck`, `lint`, relevant `vitest`/integration/e2e/smoke as env allows). Do not claim unverified behavior.
5. **Record:** update `REFACTOR.md` execution record (and phase status/matrix) with scope, changes, migrations, tests run+results, verification, risks, blockers, status.
6. **Commit & push:** `git add -A && git commit -m "refactor(phaseX.Y): <concise slice>"` (or equivalent) and `git push origin <branch>` to keep working tree clean for next phase. Do not push secrets.
7. **Iterate:** proceed to next slice/phase. If a gap is **not feasibly fixable** (external license/partner/credential/governance dependency, unavailable env, or requires unsafe/destructive change), mark **blocked** with concrete blocker, evidence, and required next action—do not silently skip or falsely claim completion.
8. **Stop conditions:** continue until all gaps are implemented/verified or explicitly recorded as blocked with justification and owner/action required. Full “all gaps fixed” may be unattainable without external dependencies; progress must be maximal and transparent.

## 0. Codebase baseline (from audit, 2026-11-10)

- **Stack/shape:** TypeScript monorepo (`apps/api` Hono API + Workers/Node, `apps/web` React/Vite SPA, `apps/jobs`, `packages/{db,domain,authz,auth,contracts,platform,reference,ai,ui}`), PostgreSQL with RLS/context helpers, migrations `packages/db/migrations/001..121` (note gaps/numbering irregularities e.g. missing 044/114; lexical order used), extensive docs/specs and synthetic-data workflows.
- **Backend hotspots/monoliths:** `apps/api/src/routes/{inventory,finance,content,clinical,directory,radiology,reception,inpatient,organization,auth,workflow,pharmacy-pos,onboarding,diagnostics,ehmis,admin,operations,maternity,data-exchange,billing,...}` and `packages/contracts/src/index.ts`, `packages/domain/src/{onboarding-catalogue,index,catalog}.ts` (many >300–2000 LOC) mix validation/auth/orchestration/persistence/audit.
- **Security/RBAC/audit:** strong primitives exist (RLS tx context `app.*`, hash-chained/HMAC audit + outbox in `apps/api/src/lib/audit.ts`, CSRF/MFA/session handling, `packages/authz` roles/implied/scoped roles + permissions/policy, break-glass/platform operator flows), but enforcement is **not uniformly centralized** across routes/services/policy/DB.
- **Subscriptions:** domain/service/checkout present (`packages/domain/src/billing.ts`, `apps/api/src/services/subscriptions.ts`, routes billing/subscription-checkout/payment-callbacks), but `apps/api/src/lib/billing-middleware.ts` enforcement is **narrow/config-gated** (specific capability routes, 402 in enforce mode) and must be centralized backend-wide for protected functionality.
- **Clinical/workflow:** broad modules exist (reception/care/encounters/diagnostics/radiology/pharmacy/inpatient/theatre/maternity/emergency/programmes/etc.) with `routes/workflow.ts` + `care_recommendations`/queues; routing, statuses, idempotency, and result-linkback need end-to-end hardening/consistency.
- **Finance:** invoices/payments/reversals/claims/catalog/pricing and some billing jobs exist; **full payroll processing/payslips and operational expenditure ledger/reporting are incomplete/missing** (reference payroll grades/assignments scaffolding exists in migrations/seed/reference routes).
- **Interoperability:** limited read-only FHIR subset (`apps/api/src/fhir/*`), terminology adapters/router (`apps/api/src/terminology/*`), DICOMweb integration/tests, eHMIS/DHIS2/data-exchange scaffolding; **ICD-11/SNOMED CT production-grade versioned mapping layer, broad FHIR resource coverage/write semantics as appropriate, and DICOMweb STOW/QIDO/WADO completeness depend on architecture/config/licensing/external systems**.
- **Frontend:** React SPA with lazy routes, `AppShell`, `ProtectedRoute`, nav/role/module gating (`lib/nav.ts`, `lib/route-modules.ts`, `lib/roles.ts`), shared `@medveris/ui` + large global/page CSS; **not universally mobile-first** (mixed desktop-first pages/breakpoints, inconsistent stacking/full-width/alignment, table mobile labeling contract not enforced by primitive, bespoke dialogs/forms, many large pages/components).
- **Testing:** unit/integration/e2e suites and smoke scripts exist (`tests/unit`, `tests/integration`, `tests/e2e`, vitest/playwright configs); coverage is uneven relative to full master scope and must be expanded per module.
- **Known blockers/dependencies (document, do not assume):** production secrets/key rotation/recovery, backups+restore drills/RPO-RTO, hosted CI/promotion, monitoring/alerting, clinical safety/privacy/legal review, terminology licensing and release pinning (ICD-11/SNOMED CT/LOINC), external FHIR/PACS/regulator/payment/video/device partners and credentials, e-prescribing/wholesaler integrations.

## Implementation phases and prompts

### Phase 0 — Discovery, safety net, and refactoring governance
**Goal:** establish accurate baseline, protect data, and define safe incremental change process.

#### Prompt 0.1 — Architecture & requirement traceability audit
- **Scope:** map existing behavior/data flows to every master-requirement area (RBAC/dual auth, subscription, mobile UX, registration+billing, finance/payroll/expenditure, modularity, clinical routing, staff/cadres/invitations, interoperability, DB integrity, testing).
- **Tasks:** inventory routes/services/packages/migrations/pages; identify owners of business logic; mark `keep/refactor/extend/replace-with-justification`; record risks, dependencies, and external blockers per area.
- **Artifacts:** update/append this file or `docs/*` with traceability matrix and dependency graph; no functional behavior changes except doc/comments if needed.
- **Done when:** every master section has mapped implementation points, gaps, and risk notes with file paths.

#### Prompt 0.2 — Baseline verification & regression harness
- **Scope:** `package.json` scripts, `vitest.config.ts`, `playwright.config.ts`, `tests/**`, `scripts/*smoke*`.
- **Tasks:** run/record baseline `typecheck`, `lint`, `test` (and targeted integration/e2e/smoke as environment allows) on synthetic/dev setup; identify failing/flaky/environment-dependent tests without changing product behavior; add minimal test scaffolding conventions for new modules.
- **Done when:** baseline results documented, known failures classified, and safe command set for incremental verification is defined.

#### Prompt 0.3 — Data safety, migration & rollback protocol
- **Scope:** `packages/db/migrations/*`, `scripts/{db-migrate,db-setup,db-reset-synthetic,lib,migrations}.ts`, backup/restore docs.
- **Tasks:** document current migration/seed/reset behavior and RLS/integrity checks; define forward-only, backward-compatible migration rules, pre/post checks, rollback/restore steps, and representative-data validation procedure; prohibit destructive changes in future prompts without explicit approval artifacts.
- **Done when:** protocol documented and referenced by subsequent prompts; no schema changes.

### Phase 1 — Architectural foundations (incremental modularization)
**Goal:** reduce coupling and enable safe feature work while preserving behavior.

#### Prompt 1.1 — Establish module boundaries and refactor conventions
- **Scope:** `apps/api/src/{routes,services,lib,auth}`, `packages/{domain,authz,contracts,db}`.
- **Tasks:** define target layering (route/controller → application/service → domain → data access/adapters) and shared conventions for validation, errors, audit, idempotency, transactions; identify extraction seams for largest monoliths (inventory/finance/clinical/radiology/reception/inpatient/organization/auth/workflow/content).
- **Done when:** conventions documented and first seam(s) selected with no behavior change.

#### Prompt 1.2+ — Decompose monoliths by domain slice (repeatable template)
- **Scope:** one bounded slice per prompt (e.g. finance invoice commands, workflow order routing, clinical notes, inventory movements). Prioritize high-risk/high-change areas: auth/RBAC, billing/subscription, clinical orders, finance.
- **Tasks:** extract logic into focused services/modules and smaller files (target ~200 LOC avg where practical, hard cap justification if >300), remove duplication, keep API contracts and DB behavior backward-compatible, add/adjust unit tests around extracted logic.
- **Constraints:** no business-rule changes unless fixing a confirmed defect; preserve audit/outbox/transaction semantics.
- **Done when:** slice behavior unchanged (or defect fix documented), files reduced/clarified, tests pass.

#### Prompt 1.3 — Contracts and shared types rationalization
- **Scope:** `packages/contracts/src/index.ts` (very large), API/web shared types.
- **Tasks:** split/version contracts by domain, remove dead/duplicated schemas, ensure validation aligns with backend enforcement and frontend needs without breaking existing clients.
- **Done when:** modular contracts with passing typecheck/tests.

### Phase 2 — Security, RBAC, dual authorization, and audit
**Goal:** comprehensive, configurable, backend-enforced access control and immutable auditability.

#### Prompt 2.1 — RBAC model consolidation (roles, permissions, ownership/admin/clinical separation)
- **Scope:** `packages/authz/**`, `apps/api/src/auth/**`, `apps/api/src/lib/{scope,platform-roles}.ts`, membership/tenant/workspace services, relevant migrations if additive.
- **Tasks:** inventory current roles/permissions/capabilities and policy usage; define canonical granular permission model (resource+action, scope-aware) separating facility ownership, administrative authority, and clinical responsibility; ensure Owner has configurable grant/revoke/customization where authorized.
- **DB:** additive tables/columns for custom permissions/role-permission assignments if needed; backfill/migrate existing roles compatibly.
- **Done when:** single authoritative authorization decision path (or clearly layered) documented and enforced for targeted modules, with tests.

#### Prompt 2.2 — Enforce RBAC consistently across APIs and services
- **Scope:** all protected `apps/api/src/routes/**` and services performing sensitive reads/writes.
- **Tasks:** apply centralized authorization checks (and leverage RLS) per endpoint/action; remove/replace ad-hoc inconsistent checks; deny by default; cover tenant/unit/department/patient scoping and privileged access changes.
- **Done when:** permission matrix tests prove allowed/denied cases for critical modules; no UI-only reliance.

#### Prompt 2.3 — Dual authorization for high-risk actions (separation of duties)
- **Scope:** financial adjustments/reversals/refunds, sensitive patient-record modifications, privileged access/role changes, and other designated high-risk ops (identify exact operations in code).
- **Tasks:** implement approval-request/approve/execute workflow requiring two appropriately authorized distinct users (initiator cannot self-approve); support pending/approved/rejected/expired states; persist previous/new state and affected record references.
- **DB/API:** additive, auditable entities and idempotent command handling; backward-compatible for existing flows.
- **Done when:** bypass attempts fail in API tests; workflow visible/operable only to authorized users.

#### Prompt 2.4 — Immutable, complete audit trail for sensitive operations and protected reads
- **Scope:** `apps/api/src/lib/audit.ts`, outbox/events, routes/services for clinical/financial/admin/access actions.
- **Tasks:** ensure audit records include initiating user, approving user (if applicable), timestamp, action, affected record, previous/new state, approval status, tenant/correlation context; cover sensitive ops and protected PHI reads where applicable; maintain append-only/hash-chain integrity guarantees.
- **Done when:** audit coverage verified by automated checks for key actions; historical review/investigation query paths available to authorized roles.

#### Prompt 2.5 — Session, credential, and data-protection hardening
- **Scope:** auth/session/MFA/CSRF, upload/storage, error handling/logging.
- **Tasks:** review for secret/PHI leakage in logs/errors, secure invitation/onboarding flows, access-control on files/exports, encryption/config assumptions documented; align with existing environment constraints.
- **Done when:** targeted security tests/reviews pass; gaps documented.

### Phase 3 — Universal subscription and billing enforcement
**Goal:** centralized backend enforcement with continuity for records/emergency documentation.

#### Prompt 3.1 — Central subscription policy and enforcement middleware/service
- **Scope:** `apps/api/src/lib/billing-middleware.ts`, `apps/api/src/app.ts`, `services/subscriptions.ts`, `packages/domain/src/billing.ts`, billing routes.
- **Tasks:** define protected vs read-only-allowed operations for inactive/expired/suspended/unpaid states; enforce in backend for all protected API routes/actions (not just selected capability paths) with clear error codes; distinguish facility subscription, user permissions, and patient billing.
- **Done when:** unauthorized/protected API calls blocked when subscription inactive; historical/required read-only access preserved per policy.

#### Prompt 3.2 — Subscription lifecycle, checkout, and automatic restoration
- **Scope:** `routes/{billing,subscription-checkout,payment-callbacks}.ts`, integrations/payments adapters, jobs billing cycles.
- **Tasks:** verify/implement reliable status transitions, payment verification/callback idempotency, package/pricing selection flow support, and automatic restoration of authorized functionality after verified payment; handle retries/webhook duplication safely.
- **Done when:** integration/unit tests cover expiry, payment success/failure, duplicate callbacks, and restoration.

#### Prompt 3.3 — Usage metering and frontend subscription UX alignment
- **Scope:** usage/metering middleware, `apps/web` subscription/banner/checkout UI.
- **Tasks:** ensure frontend reflects backend state (restricted/read-only/checkout) but cannot bypass; improve clarity without changing enforcement source of truth.
- **Done when:** UI states consistent with API behavior across key modules.

### Phase 4 — Universal mobile-first UX standardization
**Goal:** consistent, accessible responsive behavior across every module/page.

#### Prompt 4.1 — Responsive design system foundations
- **Scope:** `packages/ui/src/{styles.css,primitives.tsx}`, `apps/web/src/styles.css`, layout primitives.
- **Tasks:** establish mobile-first tokens/layout rules (vertical stacking, full-width containers/fields/actions on mobile, consistent left alignment, spacing/typography, no horizontal overflow/clipping), responsive breakpoints (mobile/tablet/desktop), touch targets, and accessible form/table/dialog/sheet patterns (incl. table `data-label` contract or responsive alternative).
- **Done when:** shared primitives documented and demonstrably compliant on representative screens.

#### Prompt 4.2 — App shell, navigation, and core interaction patterns
- **Scope:** `apps/web/src/components/AppShell.tsx`, `lib/nav.ts`, dialogs/sheets/search, `ProtectedRoute` states.
- **Tasks:** ensure sidebar/topbar/bottom nav/sheets/search/notifications/actions are usable on small screens, no overlap/overflow, predictable navigation, and left-aligned content; unify modal/sheet behavior.
- **Done when:** shell verified on mobile/tablet/desktop viewports.

#### Prompt 4.3+ — Module-by-module responsive retrofit (repeatable)
- **Scope:** one module/page group per prompt in priority order: auth/onboarding/invitation, dashboard, patients/reception/queues, encounters/clinical, diagnostics/radiology/lab, pharmacy/POS, inpatient/theatre/maternity/emergency, finance/billing/subscription/reports, inventory/procurement/operations, admin/workforce/credentials/documents, directory/content/public pages.
- **Tasks:** refactor layouts/forms/tables/boards/modals to mobile-first stacked full-width; remove fixed widths/overflow causes; decompose very large page components where needed for maintainability; keep behavior and permissions intact.
- **Done when:** per-module manual/automated viewport checks pass with no unintended horizontal scroll or clipped/inaccessible controls.

### Phase 5 — Patient registration and initial billing automation
**Goal:** reliable, idempotent financial onboarding on registration.

#### Prompt 5.1 — Registration-to-billing workflow (backend, transactional/idempotent)
- **Scope:** patient registration/onboarding/reception routes & services, billing services/domain, facility billing configuration/price lists, `packages/db` migrations as needed.
- **Tasks:** on new patient registration create/link patient to facility billing radar and generate appropriate initial billing entry using configured default consultation fee and applicable facility-specific price lists; ensure idempotency for retried requests (no duplicates), traceability to registration/encounter/services/invoices/payments.
- **Rules:** support configurable exemptions/insurance/discounts/adjustments/zero-cost where authorized; auto-generated entry must **not** imply service delivered or payment received.
- **Done when:** integration tests prove correct single-entry creation, facility-specific pricing, and retry safety.

#### Prompt 5.2 — Registration/billing UX and operational visibility
- **Scope:** registration, patient, reception, finance UI flows.
- **Tasks:** surface billing-radar/initial-charge status clearly and accessibly (mobile-first), with correct read-only/permission behavior.
- **Done when:** end-to-end registration flow verified.

### Phase 6 — Comprehensive financial management
**Goal:** traceable, authorized revenue, payroll, and expenditure management.

#### Prompt 6.1 — Finance domain model & ledger consistency review
- **Scope:** `apps/api/src/routes/finance.ts`, billing/invoice/payment/reversal services, `packages/domain/src/billing.ts`, related migrations.
- **Tasks:** audit/normalize patient billing, invoices/receipts, service charges (consultation/procedure/pharmacy/lab/radiology), insurance/third-party payments, receivables, refunds/discounts/adjustments; ensure categorization, traceability, idempotent money commands, and authorization (incl. dual-auth hooks from Phase 2).
- **Done when:** financial invariants and reconciliation checks tested.

#### Prompt 6.2 — Staff/payroll module implementation (configurable, auditable)
- **Scope:** workforce/HR/payroll routes/services/UI, `migrations 118/120` and additive schema, jobs if needed.
- **Tasks:** implement staff employment profiles, departments/roles linkage, basic salaries/allowances, payroll periods/runs, deductions/configurable components, payment history, and payroll reports; separate payroll from clinical records with authorized cross-reporting.
- **DB:** additive, backward-compatible tables/constraints; transactional payroll runs with idempotency and audit.
- **Done when:** payroll calculations and period processing verified against test scenarios; blocked external dependencies documented.

#### Prompt 6.3 — Operational expenditure tracking
- **Scope:** finance/operations/procurement integration points, additive schema/services/UI.
- **Tasks:** track utilities, maintenance, equipment servicing, medical supplies, admin and other recurring/non-recurring costs with categories, approvals/authorization as applicable, and traceability.
- **Done when:** CRUD/reporting flows tested and auditable.

#### Prompt 6.4 — Financial reporting and exports
- **Scope:** finance/report routes, jobs/exports, UI reports.
- **Tasks:** implement/complete revenue & expenditure summaries, cash flow, receivables, payroll expenditure, operational cost breakdowns, profit-and-loss where applicable; exportable reports with proper authorization and no PHI leakage.
- **Done when:** reports reconcile to underlying transactions in tests.

### Phase 7 — End-to-end clinical workflow automation and order routing
**Goal:** reliable, traceable inter-department orders and results.

#### Prompt 7.1 — Unified clinical order model and routing service
- **Scope:** `apps/api/src/routes/workflow.ts`, clinical/diagnostics/radiology/pharmacy/lab routes, services, domain workflow, `care_recommendations`/orders/results schema.
- **Tasks:** ensure clinician-created orders (lab, radiology/imaging, medication/prescription, other services) immediately enter destination department work queues with unique IDs, appropriate notifications/events, and traceable statuses (`pending/acknowledged/in_progress/completed/cancelled/rejected` as applicable).
- **Done when:** routing correctness and status transitions verified per department.

#### Prompt 7.2 — Result/service completion linkage and clinical visibility
- **Scope:** diagnostics/radiology/pharmacy results, encounter/visit views.
- **Tasks:** link completed results/services back to originating clinical encounter/order; expose authorized clinician review; maintain auditability.
- **Done when:** end-to-end order→result→encounter linkage tested.

#### Prompt 7.3 — Idempotency, retries, and failure handling for routing/integrations
- **Scope:** order creation APIs, jobs/outbox/queue handlers, integration adapters.
- **Tasks:** prevent duplicate orders on retries, safe retry/failure states for routing/integration requests, observable errors without PHI leakage.
- **Done when:** duplicate/retry/failure scenarios covered by tests.

#### Prompt 7.4 — Outpatient, inpatient, pharmacy, lab, radiology workflow verification
- **Scope:** reception, inpatient, pharmacy, diagnostics, radiology modules.
- **Tasks:** verify supported end-to-end operational paths and document any remaining clinical-safety/operational gaps.
- **Done when:** workflow acceptance scenarios executed and recorded.

### Phase 8 — Staff onboarding and professional cadres
**Goal:** comprehensive, configurable workforce taxonomy and secure onboarding.

#### Prompt 8.1 — Configurable cadres/departments/roles model
- **Scope:** workforce/reference data (`packages/db/seed/reference-data.ts`, `routes/workforce-reference.ts`, organization/workspace), migrations (additive) for cadre/department/system-role/permission-level separation.
- **Tasks:** support comprehensive searchable professional categories (medical/specialist, clinical officer, nursing/midwifery, pharmacy, lab, radiography/radiology, sonography, dental, physio, nutrition/dietetics, public health, medical records, health admin, finance/accounts, support/operations) and allow adding new cadres without code changes.
- **Done when:** data-driven taxonomy manageable by authorized admins; existing users/roles preserved.

#### Prompt 8.2 — Invitations, secure onboarding, and authorization assignment
- **Scope:** `apps/api/src/routes/{auth,onboarding,organization,workspace,admin}.ts`, `services/invitations.ts`, email/token flows, UI onboarding/invitation pages.
- **Tasks:** ensure secure invitation, verification, account activation, cadre/department/system-role assignment with least privilege and proper RBAC integration; mobile-first onboarding UX.
- **Done when:** onboarding/invitation flows tested (success, expiry, duplicate, unauthorized assignment).

### Phase 9 — Healthcare interoperability and terminology standards
**Goal:** standards-ready, versioned, auditable interoperability architecture (implement fully where feasible; scaffold safely where externally constrained).

#### Prompt 9.1 — Central terminology & code-mapping platform
- **Scope:** `apps/api/src/terminology/**`, `packages/db` additive schema, admin/config surfaces as needed.
- **Tasks:** build/extend centralized layer for code systems, value sets, concept mappings (internal↔standard), versioning and effective dates; preserve original clinical descriptions alongside codes; audit mapping/terminology changes; avoid hard-coding catalogues in clinical components.
- **Dependencies:** licensing/distribution/access rules for SNOMED CT/ICD-11/LOINC must be verified; support import/load mechanisms and clearly gate unavailable licensed content.
- **Done when:** version-aware mapping services/APIs and storage in place with tests using synthetic/reference-safe fixtures.

#### Prompt 9.2 — LOINC integration for lab/observations
- **Scope:** lab/catalog/observation models, diagnostics routes/services, terminology mappings.
- **Tasks:** map internal lab/observation catalogues to LOINC where configured; support consistent identifiers/definitions/results exchange; validation and reporting hooks.
- **Done when:** mappings configurable/versioned and used in relevant workflows/APIs; gaps documented if licensed/reference data unavailable.

#### Prompt 9.3 — ICD-11 diagnostic classification integration
- **Scope:** conditions/diagnosis capture, reporting/analytics, billing classification hooks where applicable.
- **Tasks:** support searchable diagnostic code selection and mapping, version-aware management, and non-assumption that every classification is billable.
- **Done when:** diagnosis coding flow integrated and tested with permitted data sources; external access/licensing dependencies documented.

#### Prompt 9.4 — SNOMED CT clinical terminology integration
- **Scope:** clinical findings/procedures/symptoms documentation, terminology search/mapping.
- **Tasks:** integrate concept representation and mapping respecting licensing/territory constraints; preserve clinical meaning and original text.
- **Done when:** terminology services wired to clinical documentation points with safe fallbacks when unavailable.

#### Prompt 9.5 — HL7 FHIR R4 interoperability expansion
- **Scope:** `apps/api/src/fhir/{router,capability,mapping}.ts`, services, contracts/specs.
- **Tasks:** expand truthful CapabilityStatement and resource mappings/projections for appropriate resources (Patient, Practitioner, Organization, Encounter, Observation, Condition, DiagnosticReport, ServiceRequest, MedicationRequest, MedicationDispense, ImagingStudy, AllergyIntolerance, Procedure, relevant admin/financial where appropriate) with tenant/patient scoping, RLS-respecting access, validation, and import/export-ready APIs; maintain read/write semantics only where safely implemented.
- **Done when:** supported interactions/resources validated by automated tests and documented conformance limits.

#### Prompt 9.6 — DICOM/DICOMweb imaging interoperability
- **Scope:** `apps/api/src/integrations/dicomweb.ts`, `routes/radiology.ts`, imaging models/storage references.
- **Tasks:** strengthen QIDO-RS/WADO-RS integration and assess/implement STOW-RS where architecture permits; link ImagingStudy/orders/reports/patient records; ensure authorized access and audit trails; test against compatible environment (fake PACS in dev, real config externally).
- **Done when:** supported DICOMweb operations verified; unsupported capabilities explicitly gated/documented.

### Phase 10 — Database integrity, performance-safe refactoring, and final verification
**Goal:** prove safety, compatibility, and completeness.

#### Prompt 10.1 — Cross-cutting data integrity and idempotency hardening
- **Scope:** multi-record workflows (registration+billing, orders, payments, payroll, migrations of stateful records).
- **Tasks:** ensure transactions, unique/idempotency keys, referential integrity, retry safety, and no duplicate financial/clinical artifacts; preserve history.
- **Done when:** targeted concurrency/retry tests pass.

#### Prompt 10.2 — Comprehensive automated and scenario testing
- **Scope:** `tests/unit`, `tests/integration`, `tests/e2e`, smoke scripts.
- **Tasks:** add/update tests per master acceptance criteria: security/RBAC/dual-auth/audit, subscription backend enforcement/restoration, clinical routing end-to-end, financial/payroll/expenditure/report reconciliation, interoperability mappings/FHIR/DICOMweb, mobile viewport/accessibility checks, migration/data integrity.
- **Done when:** relevant suites pass and gaps/external dependencies recorded.

#### Prompt 10.3 — End-to-end regression, documentation, and implementation report
- **Scope:** whole app, docs (`docs/*`, this file).
- **Tasks:** run lint/typecheck/tests/smokes feasible in environment; verify affected modules manually/automatically (mobile+desktop, APIs, workflows); produce final report including: codebase audit summary, implemented modules/features by prompt, modified/new files, DB migration details, API/interoperability changes, security/permission changes, test results, breaking changes+mitigations, outstanding dependencies/external configuration, and incomplete requirements with reasons.
- **Done when:** report delivered with evidence; all claimed items tested and verified.

## Prompt execution template (use for each increment)

```md
### Execution record: Prompt X.Y — <title>
- Date:
- Scope/files reviewed:
- Changes made:
- DB migrations (if any): id, backward-compat, rollback, data validation
- Tests/checks run: command -> result
- Behavioral verification:
- Risks/breaking changes/mitigations:
- External dependencies/blockers:
- Status: completed | partial | blocked (with reason)
```

## Suggested initial implementation order
1. 0.1–0.3 (audit, baseline, data safety)
2. 2.1–2.5 (RBAC/dual-auth/audit/security) in parallel with 1.1 where safe
3. 1.2 modularization slices for touched domains
4. 3.1–3.3 (subscription enforcement)
5. 5.1–5.2 (registration+initial billing) and 6.x (finance/payroll/expenditure)
6. 7.1–7.4 (clinical routing)
7. 8.1–8.2 (staff/cadres/onboarding)
8. 9.1–9.6 (terminology/interoperability, dependency-aware)
9. 4.1–4.3 (universal mobile-first pass, can start earlier for shared primitives/shell)
10. 10.1–10.3 (hardening, full verification, final report)

*Adjust sequencing only when dependencies/risk require it; never defer critical safety controls.*

---
## Execution records

### Execution record: Prompt 0.1 — Architecture & requirement traceability audit
- Date: 2026-11-10
- Scope/files reviewed: repo structure, `README.md`, `package.json`, `tsconfig*.json`, `wrangler.jsonc`, `docs/{REQUIREMENT_IMPLEMENTATION_MATRIX,IMPLEMENTATION_*,MVP_STATUS,ARCHITECTURE_REVIEW}.md`, `STAGE_0_DISCOVERY.md`, `apps/api/src/**`, `apps/web/src/**`, `apps/jobs/src/**`, `packages/*/src/**`, `packages/db/migrations/*.sql`, `scripts/*`, `tests/**` (codebase audit via parallel exploration).
- Changes made: added `docs/refactor/TRACEABILITY.md` with master-requirement mapping, gaps, disposition, hotspots, and dependency ordering; populated baseline in `REFACTOR.md`.
- DB migrations (if any): none.
- Tests/checks run: discovery/read-only analysis; no behavior changes.
- Behavioral verification: N/A (documentation only).
- Risks/breaking changes/mitigations: none.
- External dependencies/blockers: licensing/partners/credentials for production terminology, external FHIR/DICOM/STOW, payment/video/device/regulator integrations, hosted CI, ops/DR/governance approvals.
- Status: completed.

### Execution record: Prompt 0.2 — Baseline verification & regression harness
- Date: 2026-11-10
- Scope/files reviewed: `package.json` scripts, `vitest.config.ts`, `playwright.config.ts`, `tests/**`, `scripts/*smoke*`.
- Changes made: recorded available verification commands in protocol/report context; attempted baseline checks in environment.
- DB migrations (if any): none.
- Tests/checks run: `npm run -s typecheck` -> pass (clean). `npm run -s lint` and `npm run -s test` not executed to completion in this turn due to expected long runtime in full repo; to be run/recorded incrementally per touched module in subsequent phases (CI/local as available).
- Behavioral verification: type system clean at baseline snapshot.
- Risks/breaking changes/mitigations: full-suite baseline not yet fully recorded in this session; mitigate by running targeted tests per change and full gate before release.
- External dependencies/blockers: DB/services/env for integration/e2e/smoke in some environments.
- Status: partial (baseline harness documented, full suite execution pending/incremental).

### Execution record: Prompt 0.3 — Data safety, migration & rollback protocol
- Date: 2026-11-10
- Scope/files reviewed: `packages/db/migrations/*`, `packages/db/src/index.ts`, `scripts/{migrations,db-migrate,db-setup,db-reset-synthetic,lib}.ts`, `apps/api/src/lib/db-health.ts`, migration/integrity behavior.
- Changes made: added `docs/refactor/DATA_SAFETY_PROTOCOL.md` (forward-only additive rules, RLS/grants/integrity, idempotency, pre-apply/apply/rollback, verification evidence, env notes).
- DB migrations (if any): none.
- Tests/checks run: N/A (documentation only).
- Behavioral verification: N/A.
- Risks/breaking changes/mitigations: protocol is guidance; must be enforced in every subsequent migration/change.
- External dependencies/blockers: environment backup/PITR tooling and approved restore drills/RPO-RTO for non-synthetic environments.
- Status: completed.

### Execution record: Prompt 1.1 — Establish module boundaries and refactor conventions
- Date: 2026-11-10
- Scope/files reviewed: `apps/api/src/{app,routes,services,lib,auth}`, `packages/{domain,authz,contracts,db}`, monolith size hotspots.
- Changes made: added `docs/refactor/ARCHITECTURE_CONVENTIONS.md` defining target layering, cross-cutting conventions (validation/authz/audit/tx/idempotency/errors/subscription/interoperability), file-size targets, priority extraction seams, and slice refactor workflow.
- DB migrations (if any): none.
- Tests/checks run: N/A (documentation only).
- Behavioral verification: N/A.
- Risks/breaking changes/mitigations: none; conventions guide future slices.
- External dependencies/blockers: none.
- Status: completed.

### Execution record: Prompt 3.1 — Central subscription policy and enforcement middleware/service (incremental)
- Date: 2026-11-10
- Scope/files reviewed: `apps/api/src/lib/billing-middleware.ts`, `apps/api/src/app.ts`, `apps/api/src/routes/{billing,subscription-checkout,reports}.ts`, `services/subscriptions.ts`, `packages/domain/src/billing.ts`, existing billing/subscription tests.
- Changes made: expanded backend `subscriptionGuard` so that in `enforce` mode restricted/suspended/cancelled/expired-trial facility subscriptions block protected mutating API operations (not only a few growth routes), while preserving read-only access and allowlisting auth/session, subscription recovery/payment, public callbacks, legal/health, and core patient-care/emergency documentation continuity paths. Enforcement remains server-side and authoritative.
- DB migrations (if any): none.
- Tests/checks run: `npm run -s typecheck` -> pass. Targeted/full integration tests not run in this environment (DB-dependent); existing billing/subscription tests reviewed for compatibility (GET/report restriction and billing recovery paths remain consistent).
- Behavioral verification: code-path review confirms mutating protected routes now return 402 `subscription_restricted` when tenant subscription access mode is restricted; allowlisted recovery/care paths and reads remain accessible.
- Risks/breaking changes/mitigations: behavior is stricter for non-care mutations under restricted subscriptions (intended); allowlist may need refinement per facility-policy (e.g. patient-billing vs facility-subscription admin writes) with explicit tests. Monitor for unintended blocks in operations/finance workflows and adjust narrowly with audit-backed policy.
- External dependencies/blockers: payment verification/callback behavior depends on configured providers; full lifecycle verification requires integration/e2e in configured environments.
- Status: partial/incremental (centralized mutating-write enforcement added; comprehensive route classification, policy config, and automated enforcement tests to follow).

### Execution record: Prompt 2.1 — RBAC model consolidation & security planning baseline
- Date: 2026-11-10
- Scope/files reviewed: `packages/authz/**`, `apps/api/src/auth/**`, `lib/{audit,scope,platform-roles}.ts`, routes including admin/consent/billing/finance/clinical, RLS context usage.
- Changes made: added `docs/refactor/SECURITY_RBAC_PLAN.md` documenting current controls, gaps, candidate high-risk operations for dual authorization, incremental implementation approach, and verification requirements.
- DB migrations (if any): none.
- Tests/checks run: N/A (planning/documentation only).
- Behavioral verification: N/A.
- Risks/breaking changes/mitigations: none; informs subsequent enforcement work.
- External dependencies/blockers: facility policy decisions for dual-approval scope, clinical governance/privacy review.
- Status: partial (planning baseline complete; canonical granular permission model and enforcement rollout pending).

### Execution record: Prompt 4.1 (planning) — Universal mobile-first foundations & retrofit plan
- Date: 2026-11-10
- Scope/files reviewed: `apps/web/src/**`, `packages/ui/src/**`, responsive/CSS/layout patterns, large pages/components.
- Changes made: added `docs/refactor/MOBILE_FIRST_PLAN.md` with target behavior, gaps, shared-foundation tasks, module retrofit order/checklist, and risks.
- DB migrations (if any): none.
- Tests/checks run: N/A (planning).
- Behavioral verification: N/A.
- Risks/breaking changes/mitigations: UI regressions possible during retrofit; mitigate with per-module viewport checks and incremental commits.
- External dependencies/blockers: design/accessibility review as needed.
- Status: partial (plan complete; implementation pending).

### Execution record: Prompts 5–9 (planning) — Registration/billing, finance, clinical routing, workforce, interoperability blueprints
- Date: 2026-11-10
- Scope/files reviewed: registration/reception/billing/finance/workflow/clinical/diagnostics/radiology/pharmacy/workforce/terminology/FHIR/DICOM modules and schemas.
- Changes made: added `docs/refactor/CLINICAL_FINANCE_WORKFORCE_INTEROP_PLANS.md` consolidating implementation blueprints for Phase 5 (idempotent registration→initial billing), Phase 6 (revenue/payroll/expenditure/reporting), Phase 7 (order routing/status/result linkage/retries), Phase 8 (configurable cadres and secure onboarding), and Phase 9 (terminology mapping, LOINC/ICD-11/SNOMED, FHIR, DICOMweb) with cross-cutting safety requirements and blockers.
- DB migrations (if any): none.
- Tests/checks run: N/A (planning).
- Behavioral verification: N/A.
- Risks/breaking changes/mitigations: each area requires careful additive migrations and compatibility; external dependencies documented.
- External dependencies/blockers: terminology licensing/content, PACS/FHIR partners, payment/regulator integrations, clinical/governance approvals.
- Status: partial (blueprints complete; implementation pending).

### Execution record: Prompt 4.1 — Responsive design system foundations (incremental implementation)
- Date: 2026-11-10
- Scope/files reviewed: `packages/ui/src/styles.css`, `apps/web/src/styles.css`, responsive primitives behavior.
- Changes made: improved shared responsive foundations - mobile table-wrap now stacks rows/cells full-width with left-aligned content and supports optional `data-label`, dialogs use dynamic viewport height and full-width sheet sizing on small screens, form/grid/row/datalist/card/page-header patterns collapse/stack to full-width on narrow breakpoints, and added universal mobile overflow/stack safeguards in app styles.
- DB migrations (if any): none.
- Tests/checks run: `npm run -s typecheck` -> pass.
- Behavioral verification: static CSS/structure review; ensures no forced min-width overflow from core grid/form patterns and better small-screen stacking. Full visual verification across all modules/pages still pending.
- Risks/breaking changes/mitigations: global responsive changes can affect existing layouts; mitigated by additive media rules and preserving desktop behavior. Some tables remain unlabeled until per-page `data-label`/component refactors (Phase 4.3).
- External dependencies/blockers: none.
- Status: partial (foundations applied; shell and module-by-module retrofit pending).

### Execution record: Prompt 4.1 — Responsive primitives enhancement (tables/labels)
- Date: 2026-11-10
- Scope/files reviewed: `packages/ui/src/primitives.tsx`.
- Changes made: `Table` now auto-derives and injects `data-label` attributes on body cells from headers in responsive mode, enabling consistent mobile stacked presentation without requiring every call site to be manually updated immediately.
- DB migrations (if any): none.
- Tests/checks run: `npm run -s typecheck` -> pass.
- Behavioral verification: type-checked; preserves existing table API and desktop rendering.
- Risks/breaking changes/mitigations: label text derived from header nodes may be imperfect for complex headers; can be overridden per cell later. No contract break expected.
- External dependencies/blockers: none.
- Status: partial (foundational primitive improved; module-level UI verification remains).

### Execution record: Prompt 4.2/4.3 — Shell and auth/onboarding mobile-first refinements (incremental)
- Date: 2026-11-10
- Scope/files reviewed: `apps/web/src/components/AppShell.tsx`, `AuthFrame.tsx`, auth pages (`LoginPage`, `RegisterPage`, `InvitationPage`), shell/auth styles.
- Changes made: added app-level CSS refinements for full-width/left-aligned auth intro and panel stacking on mobile, full-width auth card actions on small screens, and mobile-safe search/sheet viewport sizing to reduce clipping/overflow.
- DB migrations (if any): none.
- Tests/checks run: `npm run -s typecheck` -> pass.
- Behavioral verification: style/structure review; no route or API behavior changes. Comprehensive per-page viewport and interaction verification remains pending.
- Risks/breaking changes/mitigations: broader button width rules scoped to auth cards/small screens to limit regressions.
- External dependencies/blockers: none.
- Status: partial (targeted improvements applied; full module-by-module retrofit and manual/device checks pending).

### Execution record: Prompt 2.2/3.1 — Subscription policy hardening for high-risk finance mutations (incremental)
- Date: 2026-11-10
- Scope/files reviewed: `apps/api/src/lib/billing-middleware.ts`, finance route mutation inventory.
- Changes made: refined backend subscription-restriction enforcement to remove blanket finance-route mutation allowance; only essential patient-billing/collection continuity POSTs remain allowlisted (bill/invoice creation, line removal, payment/cash/mobile-money collection and status checks). High-risk finance mutations (e.g. reversals, refunds, voids, waivers, billing settings, catalog/pricing changes) are now blocked under restricted subscriptions in enforce mode.
- DB migrations (if any): none.
- Tests/checks run: `npm run -s typecheck` -> pass.
- Behavioral verification: static route-policy review; DB-backed/integration verification pending.
- Risks/breaking changes/mitigations: stricter than prior behavior by design for protected operations; continuity paths preserved to avoid disrupting care/payment collection.
- External dependencies/blockers: full policy/permission matrix and dual-auth for designated high-risk ops still pending.
- Status: partial.

### Execution record: Prompt 4.2/4.3 — Shell, dashboard and queues mobile retrofit (incremental)
- Date: 2026-11-10
- Scope/files reviewed: `apps/web/src/components/AppShell.tsx`, `apps/web/src/pages/DashboardPage.tsx`, `apps/web/src/pages/QueuesPage.tsx`, `apps/web/src/styles.css`.
- Changes made: improved primary nav strip active/overflow behavior for small screens, hardened dashboard role/stat text wrapping, and made queue add action full-width on mobile; adjusted shell styles for responsive scrolling/spacing.
- DB migrations (if any): none.
- Tests/checks run: `npm run -s typecheck` -> pass.
- Behavioral verification: static responsive/layout review; device/manual viewport verification pending.
- Risks/breaking changes/mitigations: additive CSS/layout-only changes; no API/route behavior changes.
- External dependencies/blockers: full module-by-module retrofit and UI verification remain.
- Status: partial.

### Execution record: Prompt 4.2/4.3 — Encounter page mobile interaction tweaks (incremental)
- Date: 2026-11-10
- Scope/files reviewed: `apps/web/src/pages/EncounterPage.tsx`.
- Changes made: made timeline/entry selection note buttons full-width to improve tap targets and stacked layout behavior on small screens.
- DB migrations (if any): none.
- Tests/checks run: `npm run -s typecheck` -> pass.
- Behavioral verification: static UI review; no clinical/API logic changes. Device/manual verification pending.
- Risks/breaking changes/mitigations: layout-only.
- External dependencies/blockers: broader encounter subcomponent responsive retrofit still pending.
- Status: partial.

### Execution record: Prompt 4.2/4.3 — Encounter actions mobile ergonomics (incremental)
- Date: 2026-11-10
- Scope/files reviewed: `apps/web/src/pages/EncounterPage.tsx`.
- Changes made: made observation/follow-up/referral submit actions full-width on small screens for improved tap targets and stacking consistency.
- DB migrations (if any): none.
- Tests/checks run: `npm run -s typecheck` -> pass.
- Behavioral verification: static UI review; no clinical logic/API changes.
- Risks/breaking changes/mitigations: layout-only.
- External dependencies/blockers: encounter subcomponents (`ClinicalNotePanel`, `VisitWorkflowPanel`, `TriagePanel`) still need deeper responsive retrofit.
- Status: partial.

### Execution record: Prompt 4.2/4.3 — Triage and workflow panel mobile actions (incremental)
- Date: 2026-11-10
- Scope/files reviewed: `apps/web/src/components/TriagePanel.tsx`, `apps/web/src/components/VisitWorkflowPanel.tsx`.
- Changes made: made triage submit, billing link/action, recommendation and supply form submit/cancel actions full-width on small screens for consistent stacking and tap targets.
- DB migrations (if any): none.
- Tests/checks run: `npm run -s typecheck` -> pass.
- Behavioral verification: static UI/layout review; no workflow/API logic changes.
- Risks/breaking changes/mitigations: layout-only.
- External dependencies/blockers: `ClinicalNotePanel` deeper responsive refactor and cross-device verification pending.
- Status: partial.

### Execution record: Prompt 5.1 — Registration-to-initial-billing automation (incremental, additive)
- Date: 2026-11-10
- Scope/files reviewed: `apps/api/src/routes/reception.ts`, `apps/api/src/routes/finance.ts`, `apps/api/src/services/registration-billing.ts`, `packages/contracts/src/index.ts`, `packages/db/migrations/122_registration_initial_billing.sql`, billing/catalog/settings migrations.
- Changes made: added additive migration `122_registration_initial_billing.sql` (facility setting fields `registration_charge_enabled`, `registration_charge_catalog_id` and idempotent trace table `patient_registration_billing` with unique `(tenant_id, patient_id)`, RLS/grants). Extended billing settings contract/API to configure an approved active price-list item as the default registration/initial consultation charge. Implemented transactional, idempotent `ensureInitialRegistrationBilling` (advisory lock + unique marker) that creates an open invoice/line labeled auto-generated (not service delivery/payment) and emits audit/outbox; safely no-ops when disabled/unconfigured/unavailable. Wired into assisted registration and facility enrollment in `reception.ts` so first facility link can generate a single initial charge and results are returned in API payload.
- DB migrations (if any): `packages/db/migrations/122_registration_initial_billing.sql` (additive, forward-only).
- Tests/checks run: `npm run -s typecheck` -> pass.
- Behavioral verification: static code review of transactional/idempotent paths and configuration validation; DB-backed/integration and retry-concurrency behavior not executed in this session.
- Risks/breaking changes/mitigations: billing now occurs only when explicitly configured/enabled; misconfiguration does not fail registration (returns unavailable/not_configured status). Existing facilities default disabled. Requires applying migration and configuring an approved catalog item per facility.
- External dependencies/blockers: facility-specific fee selection, exemptions/insurance/discount policy UX, and full reporting/reconciliation validation.
- Status: partial (backend hook/config/migration implemented; UI visibility, exemptions, and end-to-end DB/integration verification pending).

### Execution record: Prompt 5.2 — Registration billing radar/UX visibility and initial integration test (incremental)
- Date: 2026-11-10
- Scope/files reviewed: `apps/web/src/pages/PatientsPage.tsx`, `apps/web/src/pages/PriceListPage.tsx`, `tests/integration/registration-billing.test.ts`.
- Changes made: surfaced `registrationBilling` outcome in patient registration and enrollment flows (billed/already-billed/not-configured/unavailable messaging) so reception sees initial charge creation/status; extended billing settings UI to enable/configure default registration/initial consultation charge against approved active catalog items. Added integration test `tests/integration/registration-billing.test.ts` covering configuration, creation on registration, idempotent replay, and single-marker invariant (with cleanup/disable). 
- DB migrations (if any): none (uses 122).
- Tests/checks run: `npm run -s typecheck` -> pass. New integration test added but **not executed** in this session (DB/env).
- Behavioral verification: static UI/API contract review; runtime/integration verification pending.
- Risks/breaking changes/mitigations: UI depends on backend `registrationBilling` payload (now provided); settings payload now includes registration charge fields (backward-compatible defaults). Test mutates tenant billing settings/catalog in synthetic DB and restores disabled state.
- External dependencies/blockers: full exemptions/insurance/discount/zero-cost flows, billing-radar/report reconciliation views, and DB-backed CI execution.
- Status: partial.

### Execution record: Continuation checkpoint — 5.2 done (partial), 2.2/2.3 next
- Date: 2026-11-10
- Summary: completed A (4.2/4.3 mobile retrofit slices) and B (5.1 backend hook + 5.2 registration/enrollment billing-status UX, billing-settings config UI, and added `tests/integration/registration-billing.test.ts` [not executed]). 
- Next: begin 2.2/2.3 RBAC/dual-auth rollout per `docs/refactor/SECURITY_RBAC_PLAN.md` with incremental, backend-enforced hardening on high-risk modules and design/additive scaffolding for dual authorization (no destructive changes).

### Execution record: Prompt 2.3 — Separation-of-duties hardening on finance high-risk operations (incremental)
- Date: 2026-11-10
- Scope/files reviewed: `apps/api/src/routes/finance.ts` (payment reversal/refund, invoice void, billing waiver handlers).
- Changes made: added backend self-approval/separation-of-duties guards for designated high-risk finance mutations: block reversal/refund by the user who recorded the payment; block invoice void by the user who issued the bill; block/skip waiver of items billed by the same user and reject when only self-billed items are selected. Audit metadata enriched with actor linkage (received/issued/refunded/voided/waived/selfBlocked).
- DB migrations (if any): none.
- Tests/checks run: `npm run -s typecheck` -> pass.
- Behavioral verification: static code review; integration/negative authorization tests and DB-backed behavior not executed in this session.
- Risks/breaking changes/mitigations: stricter than previous behavior (intentional for separation of duties); may affect single-operator workflows—requires operational roles/process and future configurable dual-approval workflow. Full request→independent approve→execute workflow for all designated ops still pending (additive schema/service/UI).
- External dependencies/blockers: generalized dual-authorization entities/state machine, facility policy configuration, and comprehensive permission-matrix tests.
- Status: partial.

### Execution record: Registration billing verification/fix (5.1/5.2 hardening)
- Date: 2026-11-10
- Scope/files reviewed: `apps/api/src/services/registration-billing.ts`, `packages/db/migrations/122_registration_initial_billing.sql`, `apps/api/src/routes/reception.ts`, `tests/integration/registration-billing.test.ts`, invoice RLS/constraints in DB.
- Changes made: applied migration 122 in local dev DB and added additive follow-up migrations `123_registration_billing_rls.sql` (allow tenant-scoped receptionist insert/read paths required for registration-generated invoice/item creation) and `124_registration_invoice_source.sql` (extend `invoice_items.source` to include `registration` while preserving source/link integrity constraints). Adjusted integration test replay assertion to validate idempotent replay by identical patient/invoice linkage and single-marker invariant.
- DB migrations (if any): 123, 124 (additive/constraint-safe, forward-only).
- Tests/checks run: `npm run -s typecheck` -> pass; `DATABASE_URL=... MIGRATION_DATABASE_URL=... APP_ENV=test npx vitest run tests/integration/registration-billing.test.ts` -> pass (1/1) against local dev DB.
- Behavioral verification: end-to-end in-process API + DB confirms configured registration creates one billed invoice/line and replay/idempotency does not duplicate marker.
- Risks/breaking changes/mitigations: broadened invoice/item insert RLS to receptionist for registration automation (tenant-bound, existing finance/admin retained); source enum expanded additively. Requires migration apply in other environments.
- External dependencies/blockers: CI/hosted DB execution, exemptions/insurance/discount/zero-cost policy UI, reporting reconciliation.
- Status: partial (core 5.1 path verified locally; broader billing/finance scope remains).

### Execution record: REFACTOR.md gap review + Capacitor enablement
- Date: 2026-11-10
- Scope/files reviewed: `REFACTOR.md`, existing phase records, `apps/web/{package.json,vite.config.ts,index.html,src/lib/api.ts}`, root scripts/docs.
- Gap review (high level): 0.x baselines documented (full-suite/DB-backed runs still environment-dependent). 1.x modularization and contract splitting largely pending. 2.x RBAC consolidation, generalized dual-authorization workflow for all designated high-risk ops, and full audit/PHI-read coverage remain partial (finance SoD hardened; subscription policy narrowed). 3.x subscription enforcement improved but not exhaustively policy/tested across every protected surface. 4.x mobile-first foundations/shell/key flows improved; universal module-by-module retrofit + device verification pending. 5.1 core path verified locally with additive migrations 122–124; exemptions/insurance/discount/zero-cost and full reconciliation UI pending. 6.x payroll runs/payslips/deductions, expenditure ledger, and reconciled reporting largely unimplemented (scaffold tables/routes only). 7.x unified order routing/status/result-linkage/idempotency hardening incomplete. 8.x configurable cadres/invitation/onboarding authorization flows incomplete. 9.x terminology mapping/versioning, FHIR expansion, ICD-11/SNOMED/LOINC, DICOMweb completeness blocked/partial by licensing, content, and external systems. 10.x comprehensive verification/reporting pending.
- Changes made (Capacitor): added `apps/web/capacitor.config.ts`; added Capacitor deps/scripts in `apps/web/package.json` and root convenience scripts (`cap:sync/android/ios`); set Vite `base: "./"` for native asset loading; made API client honor `VITE_API_BASE_URL` with `credentials: "include"` for cross-origin/native; documented native build/config/auth considerations in `README.md`. Mobile viewport/safe-area support already present.
- DB migrations (if any): none.
- Tests/checks run: `npm run -s typecheck` -> pass (pending this execution); lint targeted as needed.
- Behavioral verification: static/config review. Native platform projects (`android`/`ios`) require `cap add` with platform SDKs and were not generated in this environment; config/scripts prepared for full native packaging.
- Risks/breaking changes/mitigations: `base: "./"` affects web asset paths but is compatible with SPA build; `VITE_API_BASE_URL` defaults to same-origin so existing deployments unaffected. Cross-origin native auth requires correct CORS/cookie/CSRF server config in target environments.
- External dependencies/blockers: Android Studio/Xcode/SDKs for platform generation and store builds; deployed API with compatible session/CORS policy; many REFACTOR phases remain dependent on product decisions, data/config, and external healthcare integrations/licensing.
- Status: partial (Capacitor project enablement complete in repo; full native platform generation/build and remaining REFACTOR functional scope not fully completable in this environment).

### Execution record: Status rescan & REFACTOR tracker update (continuation)
- Date: 2026-11-11
- Scope/files reviewed: `REFACTOR.md`, `docs/refactor/**` (incl. `phase1a/*`), git history/remote, latest production release evidence (`.wrangler/release-evidence/production-2026-11-11T07-47-16-023Z.json`), deployed version state.
- Changes made: updated `REFACTOR.md` with current status (prod deployed `92da33b/4778062e@100%`), explicit Phase 1A deployed-but-partial assessment, prompt status matrix of unfinished work/blockers, and mandatory incremental execution procedure (select/pre-check/implement/verify/record/commit-push/iterate, block with evidence when infeasible).
- DB migrations (if any): none.
- Tests/checks run: read-only analysis; no code behavior changes.
- Behavioral verification: N/A (documentation/tracking only).
- Risks/breaking changes/mitigations: none; improves transparency of remaining gaps.
- External dependencies/blockers: many phases blocked by licensing/partners/credentials, governance/ops/DR/CI, env access, and large-scope implementation (see matrix).
- Status: completed (tracker update). Overall REFACTOR remains incomplete/partially blocked.

### Execution record: Incremental verification pass (post-rescan, Phase 0.2/1A confidence)
- Date: 2026-11-11
- Scope/files reviewed: build/test tooling and Phase 1A-touched surfaces (`packages/authz`, `apps/api/src/lib/{actor,authorization}.ts`, `apps/api/src/routes/workspace.ts`, `tests/unit/authz*.test.ts`, `tests/integration/workspaces.test.ts`).
- Changes made: none (verification only).
- DB migrations (if any): none.
- Tests/checks run: `npm run -s lint` -> exit 0; `npm run -s typecheck` -> exit 0; `npx vitest run tests/unit/authz-phase1a.test.ts` -> 1 file, 16 passed; `npx vitest run tests/unit/authz.test.ts` -> 1 file, 12 passed; `npx vitest run tests/integration/workspaces.test.ts` -> 1 file, 15 passed (local `*_test` env per guard).
- Behavioral verification: targeted authz contract and workspace/shared-supply route/integration behaviors (incl. UI-safe empty shared-supply view, auth/permission guards, cross-tenant receive denial, RLS isolation assertion where applicable) exercised in tests; does not replace full permission-matrix or full-suite baseline.
- Risks/breaking changes/mitigations: full repo integration/e2e/smoke and all 1A negative cases remain partially unverified; continue incremental, targeted verification per slice.
- External dependencies/blockers: full hosted/CI baseline and env-dependent suites.
- Status: partial (targeted re-verification passed).

### Execution record: Prompt 2.1/2.2 — Canonical authorization matrix foundation (additive)
- Date: 2026-11-12
- Scope/files reviewed: `packages/authz/src/{index,permissions,policy,contract}.ts`, `apps/api/src/lib/{actor,authorization,scope}.ts`, `apps/api/src/auth/middleware.ts`, `apps/api/src/services/access.ts`, all API route files inventoried for protected-action coverage, `docs/refactor/phase1a/*`, `docs/refactor/final-remediation-20261111/*`.
- Changes made: added `packages/authz/src/matrix.ts` as the canonical protected-action inventory layered on the existing `authorize()` engine (not a competing framework). It records `AUTHORIZATION_MATRIX_VERSION = "2026-11-12.phase0-1.foundation"`, ~100 `MatrixEntry` records (key/domain/resource/verb/scope/permission/route file/route patterns/enforcement/tenantBound/RLS/requirements/dual-auth candidate/status), `NON_PERMISSION_ENDPOINTS` for intentional public/webhook/health/self/flow-token routes, lookup helpers, and the `decideAction()`/`assertMatrixAuthorized()` decision contract. `unresolved` entries carry `permission: null` and always deny; `legacy` entries retain their existing role/predicate authority. Extended `PolicyActor` (`organizationIds`, `unitId`), `ResourceContext` (`organizationId`, `unitId`) and `PolicyReason` (`platform-role-required`, `organization-mismatch`, `unit-mismatch`, `unknown-action`, `unresolved-action`) additively, and exported the matrix API from `packages/authz/src/index.ts`. No API routes were rewired; runtime enforcement is unchanged.
- DB migrations (if any): none.
- Tests/checks run: `npm run -s typecheck` -> pass; `npm run -s lint` -> pass; `npx vitest run tests/unit/authz-matrix.test.ts tests/unit/authz.test.ts` -> 28 passed (16 new matrix + 12 existing); `npx vitest run tests/unit/authz-phase1a.test.ts` -> 16 passed.
- Behavioral verification: unit tests cover matrix integrity (unique keys, known permissions, unresolved/null invariant, HTTP route binding, dual-auth candidates, lookup helpers, version), decision composition (policy-first denial e.g. tenant mismatch), unresolved/unknown denial, platform-role requirement, organization scope, self-scope, separation of duties, and structured `MatrixDeniedError`; existing authz/Phase 1A suites remain green.
- Risks/breaking changes/mitigations: additive types/exports only; no route behavior change. Route-by-route adoption of `decideAction()` and canonical permissions for the `legacy`/`unresolved` entries (theatre, emergency, maternity, telehealth, documents, devices, AI, patient merge, reports, finance catalog/void/waiver, billing, operations) remain future scoped work and must preserve existing role + contextual checks until introduced.
- External dependencies/blockers: owner-approved permissions for unresolved actions (patient merge, reports, document templates, finance catalog/void/waiver, billing subscription), generalized dual-authorization workflow, and full route-adoption/negative coverage.
- Status: partial (foundation + contract + tests complete; route rewiring and unresolved-permission decisions pending).

### Execution record: Prompt 1.2 — Authorization matrix modularization + API route reconciliation
- Date: 2026-11-12
- Scope/files reviewed: `packages/authz/src/{matrix.ts,index,permissions,policy,contract}.ts`, `apps/api/src/app.ts` router mounts, all 49 `apps/api/src/routes/*.ts`, `apps/api/src/{fhir,terminology}/router.ts`, `tests/unit/authz*.test.ts`.
- Changes made: split the monolithic matrix into `packages/authz/src/matrix/` — `types`, `version`, `exemptions`, `lookup`, `decision`, and 17 domain modules under `actions/` (patient, clinical, pharmacy, diagnostics, radiology, finance, billing, inventory, organization, workforce, content, directory, integration, platform, audit, operations, tenant). `matrix.ts` is now a thin compatibility facade re-exporting the unchanged public API. Corrected 10 `admin.ts` route bindings that omitted the `/admin` mount prefix. Behaviour and matrix version `2026-11-12.phase0-1.foundation` unchanged; no routes rewired.
- DB migrations (if any): none.
- Tests/checks run: `npx vitest run tests/unit/authz-matrix.test.ts tests/unit/authz.test.ts tests/unit/authz-phase1a.test.ts` -> 45/45 passed; `npx tsc -p tsconfig.json --noEmit` -> exit 0; `npx eslint . --max-warnings=0` -> exit 0; structural parity replay of original matrix vs modular `AUTHORIZATION_MATRIX` -> 0 drift (125/125 entries identical on key/domain/status/permission/routeFile).
- Behavioral verification: recovered original matrix source exactly (original write + 10 edits replayed from session history) and confirmed byte-level entry parity after splitting; all 325 matrix route patterns and 36 exemption patterns resolve to real mounted routes (0 stale). Docs: `docs/refactor/phase1-2/{00_BASELINE,01_API_ROUTE_INVENTORY,02_MATRIX_RECONCILIATION,03_ROUTE_COVERAGE_REPORT,04_VERIFICATION_REPORT}.md`.
- Risks/breaking changes/mitigations: additive structural change behind an unchanged facade; no behavior change. `clinical.ts` is 484 lines but data-only (29 entries) — justified exception to the ~300 LOC guideline.
- External dependencies/blockers: 356 of 711 API routes are not yet described by the matrix (not auto-bound; owner approval required); route rewiring/adoption and deployment not performed.
- Status: partial (modularization + inventory + reconciliation + coverage complete and verified; route adoption and deployment pending approval).

### Execution record: Phase 1.2 approval + reuse-slice adoption
- Date: 2026-11-12
- Scope/files reviewed: `docs/refactor/phase1-2/05_GAP_PERMISSION_MAPPING_PROPOSAL.md`, `packages/authz/src/matrix/actions/{inventory,radiology,organization,workforce}.ts`, `tests/unit/authz-matrix.test.ts`, route handlers in `apps/api/src/routes/{inventory,radiology,organizations,onboarding}.ts`.
- Changes made: recorded owner approval of all 346 gap permission mappings (24 reuse + 322 new; 10 exemption candidates remain unverified). Adopted the first slice by binding the 24 reuse-approved routes in the matrix: added `inventory.asset.read`, `inventory.asset.manage`, `inventory.count.manage`, `inventory.report.read` and `organization.link.lifecycle`; appended PACS/critical-communication/image routes to `radiology.study.register`/`radiology.report.draft`/`radiology.images.view`, organization link lifecycle routes, and `GET /onboarding/catalogue/versions`. No permissions added to the catalog and no route runtime enforcement changed by this slice.
- DB migrations (if any): none.
- Tests/checks run: `npx vitest run tests/unit/authz-matrix.test.ts tests/unit/authz.test.ts tests/unit/authz-phase1a.test.ts` -> 47/47 passed; `npm run typecheck` -> exit 0; `npm run lint` -> exit 0; route/matrix reconcile -> 130 actions, 349 patterns, all matched, 0 stale, 5 intentional multi-claims.
- Behavioral verification: new matrix tests assert every approved reuse route is bound to its existing permission, the inventory asset read allows a pharmacist and denies reception, and all existing matrix/policy tests remain green. Coverage moved from 320 matrix routes / 355 covered / 356 gaps to 344 / 379 / 332.
- Risks/breaking changes/mitigations: registry-only adoption in this increment; routes keep their existing inline permission checks, so no behavior change. The 322 NEW mappings are approved but not yet added to `PERMISSIONS` or role bundles; each requires an adoption slice with tests.
- External dependencies/blockers: adoption of the 322 NEW mappings (catalog + role grants + route wiring per domain) and verification of the 10 exemption candidates remain.
- Status: partial (approval recorded; reuse slice adopted and verified; NEW mappings and exemption verification pending).

### Execution record: Phase 1.2 inventory NEW slice
- Date: 2026-11-12
- Scope/files reviewed: `docs/refactor/phase1-2/05_GAP_PERMISSION_MAPPING_PROPOSAL.md`, `packages/authz/src/permissions.ts`, `packages/authz/src/matrix/actions/inventory.ts`, `tests/unit/authz-matrix.test.ts`.
- Changes made: adopted the approved NEW mappings for `inventory.ts` (15 routes, 13 unique permissions): added `inventory.{adjustment,count,item,location,policy,recall,requisition,transfer}.read`, `inventory.requisition.{manage,submit}`, `inventory.movement.reverse.manage`, `inventory.reservation.{manage,release.manage}` to the permission catalog, granted them via `inventoryGapRead`/`inventoryGapOperate` to the approved candidate roles (pharmacist, ward_manager, facility_admin, cssd, biomedical), and bound the routes in the matrix. Route handlers keep their existing inline checks; no runtime route rewiring.
- DB migrations (if any): none.
- Tests/checks run: `npx vitest run tests/unit/authz-matrix.test.ts tests/unit/authz.test.ts tests/unit/authz-phase1a.test.ts` -> 50/50 passed; `npm run typecheck` -> exit 0; `npm run lint` -> exit 0; route/matrix reconcile -> 143 actions, 364 patterns, all matched, 0 stale, 5 intentional multi-claims.
- Behavioral verification: tests assert every approved inventory NEW route is bound, the five candidate roles receive all 13 permissions, reception is denied, and a biomedical user can read items while reception cannot. Coverage: 359 matrix routes / 394 covered / 317 gaps; `inventory.ts` is 51/51 covered.
- Risks/breaking changes/mitigations: additive catalog/role/matrix changes only; no route behavior change. Candidate-role grants are broad by approval and remain subject to contextual policy and RLS.
- External dependencies/blockers: 307 NEW routes in other domains and 10 exemption candidates remain.
- Status: partial (inventory domain fully adopted at registry level; runtime rewiring and other domains pending).

### Execution record: Phase 1.2 small-domain gap slice
- Date: 2026-11-12
- Scope/files reviewed: `docs/refactor/phase1-2/05_GAP_PERMISSION_MAPPING_PROPOSAL.md`, `packages/authz/src/permissions.ts`, `packages/authz/src/matrix/actions/{clinical,operations,organization,billing,inventory,platform}.ts`, `tests/unit/authz-matrix.test.ts`.
- Changes made: adopted 30 approved routes across nine small domains. Added 22 permissions to the catalog and granted them via capability groups to the approved candidate roles: clinical (emergency case/session/consent/draft), document read, AI job read, devices read, organization resource read, subscription checkout quote/renewal/cancel, procurement purchase-order/supplier read+receive+status, and five platform-observability reads (platform-operator role required). Bound all routes in the matrix; route handlers keep their existing inline checks, no runtime route rewiring.
- DB migrations (if any): none.
- Tests/checks run: `npx vitest run tests/unit/authz-matrix.test.ts tests/unit/authz.test.ts tests/unit/authz-phase1a.test.ts` -> 53/53 passed; `npm run typecheck` -> exit 0; `npm run lint` -> exit 0; route/matrix reconcile -> 165 actions, 394 patterns, all matched, 0 stale, 5 intentional multi-claims.
- Behavioral verification: tests assert every adopted route is bound, candidate roles receive the grants, reception is denied, and observability reads require a platform-operator grant. Coverage: 389 matrix routes / 424 covered / 287 gaps; `inventory.ts` remains 51/51 covered, and emergency/telehealth/documents/AI/devices/facility-logo/subscription-checkout/platform-observability are 100% matrix-covered.
- Risks/breaking changes/mitigations: additive catalog/role/matrix changes only; no route behavior change. Candidate-role grants are broad by approval and remain subject to contextual policy and RLS.
- External dependencies/blockers: 277 NEW routes in other domains and 10 exemption candidates remain.
- Status: partial (nine small domains adopted at registry level; larger domains, runtime rewiring and deployment pending).

### Execution record: Phase 1.2 operations/content gap slice
- Date: 2026-11-12
- Scope/files reviewed: `docs/refactor/phase1-2/05_GAP_PERMISSION_MAPPING_PROPOSAL.md`, `packages/authz/src/permissions.ts`, `packages/authz/src/matrix/actions/{operations,content,organization}.ts`, `tests/unit/authz-matrix.test.ts`.
- Changes made: adopted 33 approved routes: 17 in `operations.ts` (housekeeping, porter, mortuary, technical assets/CSSD/work orders) and 16 in `content.ts` (access summary, bookmarks, editorial items, sources, dashboards, opportunity withdraw/report) plus `GET /opportunities` folded into the existing organization branding read. Added 27 permissions (14 operations, 13 content/organization) with capability groups granted to facility_admin/owner, ward_manager, quality, hr, content_editor, content_reviewer and opportunity_moderator. `POST /technical/assets` is bound to the existing `operations.asset.manage` entry to preserve a unique action key. Registry-only change; no runtime route rewiring.
- DB migrations (if any): none.
- Tests/checks run: `npx vitest run tests/unit/authz-matrix.test.ts tests/unit/authz.test.ts tests/unit/authz-phase1a.test.ts` -> 56/56 passed; `npm run typecheck` -> exit 0; `npm run lint` -> exit 0; route/matrix reconcile -> 191 actions, 427 patterns, all matched, 0 stale, 5 intentional multi-claims.
- Behavioral verification: tests assert every adopted route is bound, candidate roles receive the grants, reception and ward_manager boundaries hold, and a ward manager is authorized for operations reads while reception is denied. Coverage: 422 matrix routes / 457 covered / 254 gaps; `operations.ts` is 22/22 and `content.ts` is 39/39 matrix-covered.
- Risks/breaking changes/mitigations: additive catalog/role/matrix changes only; no route behavior change. Broad candidate-role grants remain subject to contextual policy and RLS.
- External dependencies/blockers: 244 NEW routes in other domains and 10 exemption candidates remain.
- Status: partial (operations/content adopted at registry level; larger domains, runtime rewiring and deployment pending).

### Execution record: Phase 1.2 maternity/inpatient/diagnostics gap slice
- Date: 2026-11-12
- Scope/files reviewed: `docs/refactor/phase1-2/05_GAP_PERMISSION_MAPPING_PROPOSAL.md`, `packages/authz/src/permissions.ts`, `packages/authz/src/matrix/actions/{clinical,diagnostics}.ts`, `tests/unit/authz-matrix.test.ts`.
- Changes made: adopted 46 approved routes: `maternity.ts` (17, maternity episodes/children/newborns/immunizations), `inpatient.ts` (15, admissions/wards/tasks/handoffs) and `diagnostics.ts` (14, diagnostic orders/reporting/critical communications/lab tests/imaging). Added 40 permissions via `maternityInpatientCore` (granted to clinician, nurse, midwife, specialist_clinician) and `diagnosticsGapCore` (granted to laboratory, lab_validator, diagnostic_practitioner) and bound all routes in the matrix. Registry-only; no runtime route rewiring.
- DB migrations (if any): none.
- Tests/checks run: `npx vitest run tests/unit/authz-matrix.test.ts tests/unit/authz.test.ts tests/unit/authz-phase1a.test.ts` -> 58/58 passed; `npm run typecheck` -> exit 0; `npm run lint` -> exit 0; route/matrix reconcile -> 231 actions, 473 patterns, all matched, 0 stale, 5 intentional multi-claims.
- Behavioral verification: tests assert representative routes are bound and clinical/diagnostic candidate roles receive the grants while reception is denied. Coverage: 468 matrix routes / 503 covered / 208 gaps; `maternity.ts`, `inpatient.ts` and `diagnostics.ts` are 100% matrix-covered.
- Risks/breaking changes/mitigations: additive catalog/role/matrix changes only; no route behavior change. Broad candidate-role grants remain subject to contextual policy and RLS.
- External dependencies/blockers: 198 NEW routes in other domains and 10 exemption candidates remain.
- Status: partial (maternity/inpatient/diagnostics adopted at registry level; other domains, runtime rewiring and deployment pending).

### Execution record: Phase 1.2 final gap adoption + exemptions
- Date: 2026-11-12
- Scope/files reviewed: `docs/refactor/phase1-2/05_GAP_PERMISSION_MAPPING_PROPOSAL.md`, `packages/authz/src/permissions.ts`, `packages/authz/src/matrix/exemptions/index.ts`, all relevant `packages/authz/src/matrix/actions/*.ts`, `tests/unit/authz-matrix.test.ts`, route handlers in `apps/api/src/routes/{auth,payment-callbacks}.ts` for exemption control verification.
- Changes made: adopted the remaining 198 approved permission-mapped routes (176 new permissions/action entries) across fhir, organization/workspace/onboarding/admin/workforce-reference, directory, workflow/theatre/programmes, radiology, reception, billing, ehmis, finance/pharmacy-pos, credentials, pharmacy, integrations/terminology and promotions. Verified and added the 10 exemption candidates to `NON_PERMISSION_ENDPOINTS`: 8 `auth.ts` routes (flow-token/self-scope with rate limiting, token/lookup/minimal-disclosure controls; `POST /auth/verify-email/resend` authenticated-self; `GET /auth/totp/dev` dev-only guarded) and 2 `payment-callbacks.ts` Yo! failure webhooks (signature verification, provider-reference tenant resolution, idempotency, rate limit). Updated matrix integrity test to accept `ALL` route methods. Registry-level adoption; route handlers keep existing inline enforcement, no runtime route rewiring.
- DB migrations (if any): none.
- Tests/checks run: `npx vitest run tests/unit/authz-matrix.test.ts tests/unit/authz.test.ts tests/unit/authz-phase1a.test.ts` -> 58/58 passed; `npm run typecheck` -> exit 0; `npm run lint` -> exit 0; route/matrix reconcile -> 404 actions, 671 patterns, all matched, 0 stale, 5 intentional multi-claims.
- Behavioral verification: reconcile confirms 666 matrix-covered + 46 exempt - 1 overlap = 711/711 covered (0 gaps). Previously-added slice tests remain green (including clinical.resource.read/manage now carrying merged route patterns). Exemption additions backed by handler controls (rate-limit/token/hash/signature/idempotency/dev-guard).
- Risks/breaking changes/mitigations: additive catalog/role/matrix and exemption-list changes only; no route behavior change. Broad candidate-role grants remain subject to contextual policy and RLS. Credential/pharmacy gaps with empty proposal role columns were granted to domain-appropriate roles (credential_reviewer/facility_admin/owner/hr/records and pharmacist/facility_admin/owner) consistent with the approved mapping intent.
- External dependencies/blockers: runtime route rewiring not performed. Production/staging deploy executed after this slice only if explicitly approved with valid credentials/context.
- Status: complete (Phase 1.2 matrix/reconciliation/coverage adoption at registry level, 711/711 covered).
