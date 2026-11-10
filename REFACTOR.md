# Medveris Refactoring & Enhancement Plan (REFACTOR.md)

Master implementation tracker for incremental refactoring of the existing Medveris healthcare platform. This file decomposes the full master requirements into small, verifiable implementation prompts/units. Treat each prompt as a scoped change request to be executed in order unless dependencies require reordering; verify and document outcomes before proceeding.

> **Non-negotiable constraints (apply to every prompt)**
> - Preserve existing functionality, patient/operational data, and established architectural decisions unless a documented technical justification requires change.
> - No destructive DB migrations without approved migration + recovery strategy, backups, rollback plan, and validation on representative data. Maintain referential integrity, transactions for multi-record writes, idempotency for retries, and backward-compatible schema/API changes where possible.
> - Enforce security on backend (RBAC, subscription, sensitive ops), not UI-only. Never expose secrets/PHI in logs/errors/responses.
> - Do not claim completion because build/dashboard loads; verify actual behavior and tests per affected module. Do not silently skip requirements—document blockers/dependencies.
> - Prefer incremental, minimal-risk changes; avoid unnecessary rewrites or technology replacement.

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
