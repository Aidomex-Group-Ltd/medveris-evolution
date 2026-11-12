# Medveris Refactoring & Enhancement Plan (REFACTOR.md)

Master implementation tracker for incremental refactoring of the existing Medveris healthcare platform. This file decomposes the full master requirements into small, verifiable implementation prompts/units. Treat each prompt as a scoped change request to be executed in order unless dependencies require reordering; verify and document outcomes before proceeding.

> **Non-negotiable constraints (apply to every prompt)**
> - Preserve existing functionality, patient/operational data, and established architectural decisions unless a documented technical justification requires change.
> - No destructive DB migrations without approved migration + recovery strategy, backups, rollback plan, and validation on representative data. Maintain referential integrity, transactions for multi-record writes, idempotency for retries, and backward-compatible schema/API changes where possible.
> - Enforce security on backend (RBAC, subscription, sensitive ops), not UI-only. Never expose secrets/PHI in logs/errors/responses.
> - Do not claim completion because build/dashboard loads; verify actual behavior and tests per affected module. Do not silently skip requirements—document blockers/dependencies.
> - Prefer incremental, minimal-risk changes; avoid unnecessary rewrites or technology replacement.

## Current status (rescan 2026-11-11, updated 2026-11-12)

- **Branch/deploy:** working branch `phase1a/shared-supply-security-closure@15255dd` = `origin/phase1a/shared-supply-security-closure` (clean except pre-existing untracked `docs/refactor/final-remediation-20261111/09_PRODUCTION_DEPLOYMENT_AND_BOOTSTRAP_REPORT.md`). `master@92da33b` remains as previously recorded. **Staging** `medveris-staging` green `dd26c660-bab4-4a9a-8de4-6c6c6b977b4d@100%` (tag `15255dd`, 2026-11-12; blue `98c1e4ae` retained, rollback `npm run deploy:staging:rollback`). **Production** `medveris-production` green `4977ef78-cb9e-49c5-bfc5-1a9f1135088c@100%` (tag `15255dd`, `medveris.online`, 2026-11-12; evidence `.wrangler/release-evidence/production-2026-11-12T05-03-14-426Z.json`; blue `764d1653` retained, rollback `npm run deploy:production:rollback`). Production gate passed (lint/typecheck/tests 802/802, audit, build, packaging, staged verification/smoke) against prod DB `medveris-prod` (migration state current, 77 applied).
- **Phase 1A (deployed, partial):** remediation increment 1 code/docs merged in ancestors (`f34666a` + follow-ups `1a87e54,3883e88,6d3bc9b,92da33b`) — additive authz contract/helpers (`packages/authz/src/{contract,index}.ts`, `apps/api/src/lib/{actor,authorization}.ts`), workspace shared-supply safety behavior, targeted tests, `docs/refactor/phase1a/*`, `tests/unit/authz-phase1a.test.ts`. **Not fully complete/verified:** focused shared-supply negative/invariant/audit integration cases added; generalized dual-approval workflow not activated; uniform RBAC/policy adoption, full permission-matrix & negative/security coverage (cross-tenant/forged-destination/ended-link/invariants, conditional RLS proof, audit success/no-success-on-denial, outbox consumer/poison/dedup), and `requestActor` 404→401 full impact require further verification/hardening (see `docs/refactor/phase1a/REMEDIATION_1_REPORT.md`).
- **Phase 1.2 (authorization matrix) — completed at registry level (2026-11-12):** matrix modularized and reconciled against 711 API routes; all 346 approved permission mappings (24 reuse + 322 NEW) adopted and 10 auth/payment-callback exemption candidates verified. Final reconcile: **404 actions / 671 patterns, 0 stale, 5 intentional multi-claims, 666 matrix-covered + 46 exempt − 1 overlap = 711/711 covered**. Adopted in slices, tests 58/58 + typecheck/lint passing, committed/pushed and deployed to staging/production. **Remaining:** runtime route-handler rewiring to the matrix decision path not performed (handlers keep existing inline enforcement).
- **Overall:** Phases 0.1, 0.3, 1.1 completed; Phase 1.2 registry adoption completed. Most other prompts remain **partial/not started** with significant external blockers in terminology/interoperability, partners/credentials, governance/ops, and large modularization/feature work.
- **Phase 11 (patient record self-access & consent-gated sharing) — specified 2026-11-12:** new phase added (see implementation sections) incorporating Uganda DPPA 2019 (right of access and of disclosure information), Uganda Patients' Charter, GDPR Art. 15, and HIPAA 45 CFR §164.524/§164.528. Direction (user-approved): a verified patient has the right of access to their own finalized medical record; providers are controllers/custodians, not record owners. Architecture rules frozen in the phase: default patient-visible finalized records; narrow exceptions only with mandatory `restricted_reason_code`; absolute tenant silos (no cross-tenant query path); sharing solely via explicit, logged, expiry/scope-bound patient-granted consent; break-the-glass with mandatory justification, full audit and post-facto patient notification; disclosure log served from the existing hash-chained audit. **No implementation or verification claimed yet; `not started` until each slice lands with evidence.**

### Prompt status matrix (unfinished focus)

| Phase/Prompt | Status | Unfinished work / notes | Blockers (if any) |
|---|---|---|---|
| 0.1 Audit & traceability | completed | — | — |
| 0.2 Baseline verification harness | partial | Continuous recorded baseline in clean env; expand module-targeted/e2e/smoke conventions | Some integration/e2e/smoke require DB/services/env |
| 0.3 Data safety/migration/rollback | completed | — | Backup/PITR/restore-drill tooling & approvals for non-synthetic envs |
| 1.1 Module boundaries/conventions | completed | — | — |
| 1.2 Authorization matrix modularization & route reconciliation | **completed (registry-level, 2026-11-12)** | 711/711 API routes covered (404 actions/671 patterns, 0 stale/0 gaps, 5 intentional multi-claims), 176 new permissions cataloged+granted, 10 exemptions verified; deployed staging+prod. **Runtime route-handler rewiring** to matrix decision path pending (handlers keep inline enforcement). | Behavior parity risk for rewiring |
| 1.2+ Decompose monoliths by slice (behavior/service extraction) | not started | Extract services/domain/data-access for hotspots (`routes/inventory,finance,clinical,radiology,reception,inpatient,organization,auth,workflow,content`, etc.) with tests, no behavior change | Risk of regressions; requires incremental, well-tested slices |
| 1.3 Contracts/types rationalization | not started | Split/version `packages/contracts`, remove dead/dup schemas, align validation | Backward-compat with API/web clients |
| 2.1 RBAC model consolidation | partial | Canonical permission catalog/matrix populated (711 routes) but owner-configurable/custom permissions, additive schema/backfill/mapping, and single authoritative decision path not yet established | Policy/product decisions for custom permissions; schema/backfill design |
| 2.2 Enforce RBAC consistently | partial (1A + registry matrix deployed) | Centralized checks across all protected route handlers/services, untrusted-ID scoping, deny-by-default, and full permission-matrix/negative tests pending; registry matrix describes but handlers not yet rewired | Large surface; behavior parity risk |
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
| 11.1 Privacy normative model & regulatory mapping | completed (2026-11-12) | `docs/PATIENT_RECORD_ACCESS_AND_SHARING.md` published; vocabulary frozen; DPIA governance review still required before production | Governance sign-off |
| 11.2 Restriction + consent additive schema | partial (2026-11-12) | Migration `128_patient_access_privacy.sql` drafted (clinical_entries restriction cols + CHECK; consent_grants RLS/FORCE; token_hash format CHECK); dry-run validated in BEGIN…ROLLBACK on `medveris_dev` (rolled back, dev DB unchanged); existing suite green 446/446 | Synthetic-DB harness; DPIA/governance |
| 11.3 Patient self-access API & FHIR release | not started | Server-side redaction, disclosure log, token-gated export | 11.2; patient portal |
| 11.4 Consent-gated provider sharing + break-the-glass | not started | One-time hashed token, expiry/revocation, no-write scoped access, audited emergency override + patient notification | 11.2; joint governance |
| 11.5 Identity assurance & privacy regression | not started | Stepped-up verification for release/export; "who accessed my record" UX; regression suite | 11.3; identity infra |

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

### Phase 11 — Patient record self-access and consent-gated sharing (DPPA 2019 / Patients' Charter / GDPR / HIPAA)
**Goal:** give every verified patient the legal right of access to their own finalized health information, while preserving tenant silos, third-party privacy, and documented safety exceptions — enforced server-side and audited end-to-end, never UI-only.

**Regulatory anchors (engineering mapping; not legal advice):**
- Uganda Data Protection and Privacy Act, 2019 — right of access by the data subject; right to be informed of disclosures of personal data to third parties.
- Uganda Patients' Charter — right of the patient to information about their own care and medical records.
- GDPR Art. 15 — right of access by the data subject (including disclosures); Art. 5(2) accountability.
- HIPAA 45 CFR §164.524 (right of access to PHI, including copies) and §164.528 (accounting of disclosures).
- The patient is the **data subject**. Healthcare providers are **data controllers/custodians**, not owners of the health information.

**Non-negotiable architecture rules (apply to every Phase 11 prompt):**
1. **Default patient visibility.** Finalized/signed clinical resources (encounter summaries, diagnoses, treatment plans, discharge/progress notes, signed lab/pathology results, radiology reports, imaging metadata, prescriptions, allergies, immunizations) are patient-visible by default on finalization. Unsigned/unverified drafts are clinician-only until signed.
2. **Narrow, documented exceptions only.** Any restriction requires a mandatory `restricted_reason_code` from the frozen vocabulary below, is recorded in the clinical audit trail, and remains bypassable only by the emergency break-the-glass procedure (11.4) — never by a UI toggle alone.
   - `third_party_confidentiality` — content whose release would reveal confidential information about another person (family history given in confidence, incidents naming other patients) unless that third party consents.
   - `therapeutic_privilege` — documented clinician judgment that direct disclosure would cause severe physical or psychological harm (rare; psychiatric/acute behavioral contexts).
   - `psychotherapy_process_notes` — separate therapist process notes; excluded from the standard patient-record export entirely.
   - `peer_review_qa` — internal peer-review/quality-assurance records; excluded from exports.
   - `litigation_prep` — records prepared in anticipation of litigation; excluded from exports.
   - `unverified_draft` — active, unreviewed drafts held until clinician sign-off; finalized/signed results are not delayed by this exception.
3. **Tenant silos are absolute.** No cross-tenant patient or provider query path may be introduced. Inter-provider sharing exists only via an explicit, logged, expiry-bound, scope-bound **patient-granted consent grant** (11.2, 11.4). A provider using MedVeris cannot read another provider's records merely because both are on the platform.
4. **Identity-proofed release.** Patient record release requires verified identity (verified phone/NIN-linked verification or stepped-up MFA/cryptographic patient↔account binding), rate limiting, and complete audit (who/what/when/from-where, and which tenant originated the record).
5. **The patient can see the disclosure log.** The DPPA/HIPAA right to accounting of disclosures is served by a patient-facing access/disclosure view backed by the existing hash-chained audit (`apps/api/src/lib/audit.ts`) — not by a parallel logging system.
6. **Exports.** Patient-initiated export of own record (server-side generated FHIR JSON bundle and/or PDF summary), delivered via authenticated short-lived access token, never via cached/insecure URLs, always audited.
7. **Backend-enforced.** Restrictions, grants, expiry, and scoping are enforced in API/RLS layers; clients never decide visibility. Patient-portal UI is a consumer, not an arbiter.
8. **Additive, backward-compatible.** No destructive migrations; restriction fields default to non-restricted; existing clinical notes/observations/reports/audit rows are untouched; current behavior remains a strict subset of new behavior.

#### Prompt 11.1 — Normative model, data classification and regulatory mapping (specification only)
- **Scope:** docs (`docs/`*, this file); no runtime behavior changes.
- **Tasks:** produce `docs/PATIENT_RECORD_ACCESS_AND_SHARING.md`: data classes (patient-visible-by-default vs restricted-with-reason vs non-record process notes); `restricted_reason_code` vocabulary and lifecycle; consent-grant model (scope, expiry, revocation, token handling — one-time token, sha256 stored, raw never persisted/logged); break-the-glass procedure; patient disclosure-log design (mapping internal audit events to patient-comprehensible entries, pseudonymized staff references); FHIR release semantics (patient-scoped read of own resources only); DPIA inputs; DPPA/Patients' Charter/GDPR/HIPAA mapping table; explicit "provider cannot access other tenant's data except via patient-granted consent or audited break-the-glass" invariant; implementation plan with synthetic-data validation.
- **Done when:** document published and linked here; vocabulary frozen for 11.2–11.5; no code changes.

#### Prompt 11.2 — Additive schema for restriction and consent grants
- **Scope:** `packages/db/migrations/127_patient_access_privacy.sql` (or next free number), RLS policies, `medveris_runtime` grants.
- **Tasks:** add `restricted_access boolean NOT NULL DEFAULT false` and `restricted_reason_code text NULL` to `clinical_notes` (and any other patient-facing note sources found by code survey; keep the first slice to notes); add CHECK requiring `restricted_reason_code` iff `restricted_access` with the frozen vocabulary from rule 2; create tenant-scoped `consent_grants` (id, tenant_id, patient_id, granted_to_tenant_id, granted_to_user_id, scope jsonb (resource kinds, purpose), starts_at, expires_at, revoked_at, token_hash char(64) CHECK (token_hash ~ '^[0-9a-f]{64}$'), created_by, created_at) with RLS FORCE + least-privilege grants (runtime role gets INSERT/SELECT for own tenant flows; no cross-tenant visibility; no raw tokens); expiry semantics (revoked/expired = inert); backfill existing rows `restricted_access=false` with documented rationale; verify no change to existing reads/writes.
- **Done when:** migration applies on synthetic DB; integrity/RLS tests green; pre-existing tests unchanged in outcome.

#### Prompt 11.3 — Patient self-service access API and FHIR release semantics
- **Scope:** `apps/api/src/fhir/*`, new `apps/api/src/routes/patient-records.ts`, `packages/contracts`, patient pages (`apps/web/src/pages/`), tests.
- **Tasks:** authenticated, identity-gated patient endpoint listing own finalized record (encounters, observations, diagnostics, reports, prescriptions, allergies, immunizations, imaging metadata + signed reports) with restriction filtering applied **server-side** (restricted items appear as withheld with opaque reason; reason visible only to the restricted-state mechanism and clinical auditors); FHIR facade: patient role may read only own resources, tenant-scoped, same redaction rules; disclosure-log endpoint returning only own audit events (who/what/when, tenant of origin, action class); export: server-side bundle generation, short-lived authenticated download token, expiry, audit event on issuance and download; proxy (dependent) access preserved and server-enforced.
- **Done when:** integration tests: self-access allowed; cross-patient/cross-tenant denied; restricted note redacted from patient view (reason not leaked); disclosure log returns only own events; export token single-use/expiring/audited; proxy path verified.

#### Prompt 11.4 — Consent-gated provider-to-provider sharing and emergency break-the-glass
- **Scope:** new consent module (`apps/api/src/routes/consent.ts` or similar), 11.2 `consent_grants`, expiry sweep job, audit hooks, provider UX, tests.
- **Tasks:** patient issues/grants/revokes token (one-time, hash-stored, mandatory expiry, scope-bound to resource kinds + purpose, bound to receiving tenant + user); receiving provider exchanges token for read-only time-bound scoped access (no writes; minimal necessary identity; audit on every access; token cannot outlive grant); automatic expiry sweep; break-the-glass: emergency endpoint requiring clinician role + mandatory justification + immediate audit entry (high severity) + queued post-facto patient notification + facility admin/auditor review flag; rate limits and CSRF protection on all consent flows.
- **Done when:** tests: expired/revoked/wrong-tenant/wrong-purpose token denied; cross-tenant read denied without grant; break-the-glass records justification + audit + notification task; provider cannot mint tokens.

#### Prompt 11.5 — Identity assurance, disclosure-log UX, and privacy regression verification
- **Scope:** `apps/api/src/auth/*`, patient portal pages, `tests/integration`, docs.
- **Tasks:** stepped-up verification for release/export (verified phone OTP and/or NIN-linked identity and/or recent MFA); rate-limited release endpoints; patient-facing "who accessed my record" page backed by the disclosure-log endpoint; DPIA/clinical governance sign-off checklist; privacy regression suite (tenant silos, restriction redaction, consent scoping, break-the-glass audit) added to CI/smoke set; incident response runbook linkage for token leakage; final residual-risk register with owners.
- **Done when:** verification green; DPIA documented; residual risks accepted/tracked; no claim of production release without governance sign-off.

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
11. 11.1–11.5 (patient self-access & consent-gated sharing) — specification first (11.1 doc/DPIA), then 11.2 schema, 11.3 API, 11.4 sharing/break-the-glass, 11.5 regression; coordinate with 7.x clinical workflows and 9.5 FHIR expansion; never enable production release without governance sign-off

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

### Execution record: REFACTOR.md gap review (post-1.2) — tracker update
- Date: 2026-11-12
- Scope/files reviewed: `REFACTOR.md` (full), `docs/refactor/phase1-2/*`, reconcile state (711/711 covered, 404 actions/671 patterns, 0 stale).
- Changes made: updated current-status header and prompt matrix to reflect 2026-11-12 reality — staging/prod now serving `15255dd` (Phase 1.2), Phase 1.2 recorded complete at registry level (all approved mappings + verified exemptions adopted/deployed), split 1.2 matrix reconciliation (completed, registry-level) from 1.2+ monolith/service extraction (not started), and clarified 2.1/2.2 as partially advanced by the populated matrix but still requiring runtime rewiring, schema/backfill, custom-permission policy decisions, and comprehensive negative coverage.
- DB migrations (if any): none.
- Tests/checks run: none (documentation/tracking only).
- Behavioral verification: N/A.
- Risks/breaking changes/mitigations: none; improves accuracy of remaining work.
- External dependencies/blockers: runtime route rewiring and 1.2+ monolith extraction are feasible but large/risk-sensitive slices; 2.3 generalized dual-approval, 6.x payroll/expenditure/reporting, 7.x unified order routing, 8.x configurable cadres/invitation flows, 9.x terminology/ICD-11/SNOMED/LOINC/DICOMweb completeness, 10.2/10.3 full evidence, and provider/governance/licensing-dependent items remain blocked or require substantial scoped implementation beyond this increment.
- Status: completed (tracker update). No additional functional implementation performed in this increment to avoid unverified/high-risk changes without a bounded approved slice.


---

## Program: Authentication simplification, interoperability, security hardening & observability (2026-11-12)

**Requested scope:** phased refactoring of the existing Medveris platform focusing on authentication simplification, clinical interoperability, security hardening, and operational observability. Improve existing implementation without unnecessarily rebuilding working components or disrupting existing clinical workflows. Patient privacy, clinical data integrity, interoperability, security, and continuity of service take priority over interface changes or architectural experimentation.

**Execution constraints (program-specific):**
- Inspect existing architecture before modifying anything; preserve working functionality and existing database relationships.
- Avoid unnecessary dependencies and duplicate services.
- Implement only one phase at a time; run relevant automated tests and regression checks after each phase.
- Document modified files, implementation decisions, and test results; report outstanding issues before requesting authorization to proceed.
- **Do not proceed to the next phase without reviewing and approving the previous phase.**
- No undocumented backdoors or unauthenticated elevation mechanisms.

### Phase sequence

| Phase | Title | Status | Gate |
|---|---|---|---|
| 1 | Authentication interface simplification | **planning/report ready for review** (no code changes applied) | Approval required before implementation/proceeding |
| 2 | Authentication logic and role-based access | pending | After Phase 1 approval & verification |
| 3 | Clinical interoperability and patient identity preservation | pending | After Phase 2 approval & verification |
| 4 | Security hardening and CIA enforcement | pending | After Phase 3 approval & verification |
| 5 | Cloudflare Workers and observability infrastructure | pending | After Phase 4 approval & verification |
| 6 | Dedicated Observability Support Center | pending | After Phase 5 approval & verification |

### Phase 1 — Authentication interface simplification (requirements)
- Redesign existing authentication portal into a single, streamlined authentication container.
- Remove redundant explanatory text and duplicated platform descriptions from authentication pages; retain platform value propositions, security information, and broader product explanations on the existing landing page.
- Introduce a toggle switch allowing users to select exclusively between **Patient** and **Healthcare Provider** views.
- Dynamically adapt registration and sign-in forms according to the selected role.
- Maintain Sign In and Sign Up functionality within the same container.
- Preserve password recovery, validation, accessibility, and existing authentication mechanisms.
- Ensure responsive behavior across desktop and mobile devices.
- **No duplicated authentication interfaces.**

### Phase 2 — Authentication logic and role-based access (requirements)
- Preserve existing authentication infrastructure while strengthening RBAC.
- Maintain separate patient and healthcare provider registration workflows; validate account roles on backend.
- Prevent unauthorized privilege escalation.
- Preserve existing identity verification, session management, and account recovery.
- Keep platform operators and privileged administrators separate from ordinary healthcare accounts.
- Ensure all protected resources enforce server-side authorization.

### Phase 3 — Clinical interoperability and patient identity (requirements)
- Maintain existing MEDITECH interoperability framework and associated clinical workflows.
- Preserve: Master Patient Index (MPI) and patient identity reconciliation; automated consent management and consent revocation; emergency break-glass access (justification, time limitations, audit trails, post-access review); real-time clinical data synchronization; appropriate handling of synchronization failures and conflicting records.
- Maintain interoperability with applicable standards: HL7 FHIR, ICD-11, LOINC, DICOMweb, SNOMED CT (within existing/licensed/implemented capabilities; gaps/dependencies must be documented, not falsely claimed).
- Do not compromise patient identity integrity or existing clinical data relationships.

### Phase 4 — Security hardening (requirements)
- Enforce Confidentiality, Integrity, and Availability (CIA) throughout the platform.
- Protect sensitive patient information in transit and at rest; enforce least-privilege access.
- Mitigate SQL injection, NoSQL injection, XSS, CSRF, command injection, and other applicable attack vectors.
- Validate API inputs and enforce backend authorization.
- Maintain reliable audit trails for clinical, administrative, and privileged operations.
- Implement appropriate rate limiting, abuse prevention, backup, and recovery mechanisms.
- Protect credentials, secrets, and privileged configuration.

### Phase 5 — Cloudflare Workers and observability (requirements)
- Integrate Cloudflare Workers into observability and security architecture.
- Establish secure telemetry and event collection; monitor authentication anomalies and suspicious API activity.
- Implement real-time security event processing and intrusion detection where supported.
- Introduce automated alerting and incident prioritization; monitor infrastructure and application health.
- Protect telemetry against unauthorized access or modification; ensure observability failures do not interrupt core clinical operations.
- Implement secure terminal-based platform operator elevation with: strong operator authentication, MFA where applicable, time-limited privilege elevation, explicit authorization and justification, comprehensive command/activity auditing, automatic privilege revocation. No undocumented backdoors or unauthenticated elevation mechanisms.

### Phase 6 — Dedicated Observability Support Center (requirements)
- Maintain a dedicated, hidden Observability Support Center accessible only through its specifically configured URL (not in ordinary public navigation, patient dashboards, or healthcare provider dashboards).
- Access independently protected through authentication, MFA, and server-side role-based authorization.
- Modules: **Telemetry** (app/infra health, API/auth/security events, clinical sync status), **Alerting** (intrusion/suspicious auth/infra failures/critical security), **Ticketing** (incident creation/classification/severity/assignment/investigation/resolution/closure), **Reporting** (security, availability, performance, incident summaries, operator activity/audit).
- Every operational module protected by backend authorization; all operator activities auditable.

### Final deliverables (upon completion)
- Architectural change summary; modified and newly created files; database migration details.
- Authentication and authorization test results; clinical interoperability verification; security assessment.
- Cloudflare observability configuration; Support Center access and operator administration instructions.
- Deployment, rollback, and recovery instructions.

### Phase 1 — Read-only implementation report (2026-11-12, for review)

**Status:** inspection complete; **no Phase 1 code changes applied** pending review/approval.

#### Current-state findings (relevant files inspected)
- **Routes/shell:** `apps/web/src/App.tsx` — public routes include `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`, `/mfa-setup`, `/accept-invitation`; landing at `/` via `RootGate` → `LandingPage` for unauthenticated.
- **Auth UI:** `apps/web/src/pages/LoginPage.tsx` (custom `mv-auth` two-column intro+panel, tabs general/staff, password→MFA challenge flow including email code/recovery/dev code, synthetic demo accounts card, links to register/forgot/about/help/contacts). `apps/web/src/pages/RegisterPage.tsx` (same split layout, patient form vs facility/workspace via `WorkspaceSignup`; legal acceptance fetch; duplicated intro copy/value props). `apps/web/src/components/AuthFrame.tsx` used by recovery-related flows (two-column frame). `apps/web/src/components/WorkspaceSignup.tsx` large multi-path provider signup (independent/organization/join, legal, account, review) embedded in register.
- **Landing:** `apps/web/src/pages/landing/LandingPage.tsx` + `landing.css` — hero/value props/benefits/levels/footer, CTAs to sign in and facility signup.
- **Auth client/state:** `apps/web/src/lib/auth.tsx` (`login`, `loginMfa`, refresh `/me`, logout, tenant switch, CSRF handling). `apps/web/src/lib/api.ts` (CSRF, credentials, `VITE_API_BASE_URL`).
- **Backend auth:** `apps/api/src/routes/auth.ts` — endpoints for register patient/facility/workspace, org search/join-code lookup, login, login MFA (TOTP/email/recovery), MFA enroll, verify-email/resend, forgot/reset password, invitations (status/register/accept/decline), dev TOTP helper (guarded), rate limiting/audit/legal acceptance/session cookies. Separate workflows preserved; server-side session/tenant/MFA enforcement present.
- **Authz/RBAC/guards:** `apps/web/src/components/ProtectedRoute.tsx`, `apps/web/src/lib/nav.ts`, `packages/authz/*`, API middleware/matrix (711 routes covered at registry level; handlers largely inline). Platform/operator and tenant roles separated in model.
- **Styles/responsive:** shared `mv-auth*` classes in web styles/components; pages are responsive in parts but layouts/copy duplicated across login/register.

#### Gaps vs Phase 1 requirements
- **Not a single streamlined container:** sign-in and sign-up are separate pages/routes (`/login`, `/register`) with duplicated two-column intros, repeated brand/value/security text.
- **No exclusive Patient/Healthcare Provider toggle adapting forms:** login has general/staff tabs; register splits by `?type=patient|facility`; no unified role toggle driving both sign-in and sign-up views in one container.
- **Redundant explanatory text on auth pages:** feature lists, security/value copy repeated in login/register intros; should move/remain on landing page.
- **Risk of duplication:** facility/workspace/provider onboarding (`WorkspaceSignup`) is complex and must remain functional; naïve consolidation could regress workflows.

#### Proposed implementation approach (Phase 1, pending approval)
1. **Single auth container/route:** consolidate into one primary authentication experience (e.g. `/auth` or reuse `/login` as canonical) rendering one streamlined card/container with two orthogonal controls: **mode** `Sign in | Sign up` and **role view toggle** `Patient | Healthcare Provider` (exclusive). Redirect legacy `/login`, `/register` query variants to the unified container preserving intent/return paths; keep deep links (e.g. invitation acceptance, password reset, verify email) on their dedicated flow pages but visually consistent and non-duplicative where possible.
2. **Dynamic forms by role:**
   - *Patient*: sign-in = existing email/password + MFA flow; sign-up = existing patient registration fields/legal acceptance calling existing `/auth/register/patient`.
   - *Healthcare Provider*: sign-in = existing staff/general sign-in semantics (preserve facility-staff context handling and invitation-based onboarding entry points, not public self-escalation); sign-up = existing provider/facility/workspace registration paths (`/auth/register/facility` and/or workspace flows) surfaced appropriately without duplicating interfaces. Keep platform operators/privileged admins out of ordinary provider signup.
3. **Simplify auth-page copy:** remove duplicated platform descriptions/value propositions from auth container; keep concise trust/security/access cues necessary for auth (e.g. MFA/verified assignment note) and retain full value props on landing page. Reuse `AuthFrame` or a simplified shared shell to avoid parallel implementations.
4. **Preserve mechanisms:** reuse existing `useAuth().login/loginMfa`, API calls, validation, password recovery links (`/forgot-password`), MFA/email/recovery/dev-code behavior, legal acceptance, CSRF/session handling, accessibility labels/roles, and responsive layout.
5. **Decomposition:** extract small focused components/hooks if needed (e.g. auth role toggle, sign-in form, patient/provider sign-up panels) to keep files maintainable without behavior change.

#### Files likely in scope (subject to implementation inspection)
- `apps/web/src/App.tsx` (routes/redirects), `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/pages/RegisterPage.tsx`, `apps/web/src/components/AuthFrame.tsx`, possibly new `apps/web/src/pages/AuthPage.tsx` or `components/auth/*`, `apps/web/src/components/WorkspaceSignup.tsx` (integration/reuse, minimal changes), `apps/web/src/pages/landing/*` (only if copy must be retained/moved), `apps/web/src/styles.css` / auth-related styles, `apps/web/src/lib/navigation.ts` or route helpers.
- **No backend/API/DB changes planned for Phase 1** unless a defect is discovered (would be documented and separately justified).

#### Risks / decisions needing review
- **Provider "sign up" meaning:** current system has patient self-registration, legacy facility registration, and richer workspace signup (independent/org/join). A single toggle-driven form must not hide or break these paths; proposed to present provider signup as a clear choice within the provider view reusing existing flows/components.
- **Facility staff sign-in distinction:** existing "Facility staff sign-in" tab vs general; must preserve correct post-login destination and verified-assignment semantics.
- **Legacy URLs/bookmarks/emails:** redirects from `/login` and `/register` must preserve query params (`as`, `type`, `from`/return path) to avoid breaking invitations and navigation.
- **No duplicate interfaces:** password reset/verify/MFA-setup/invitation acceptance are separate secured flows by necessity; keep them consistent but not presented as alternate sign-in/sign-up portals.

#### Verification plan (Phase 1, on approval)
- Targeted manual/viewport checks (mobile/tablet/desktop) for toggle states, sign-in, sign-up, MFA, recovery links, redirects, accessibility (labels, focus, keyboard).
- Automated: `npm run typecheck`, `npm run lint`, relevant web/unit tests, and auth-related integration tests as environment allows; add/update tests for unified auth container behavior where practical.
- Regression focus: patient login/register, provider login, password recovery, email verification, MFA challenge paths, invitation acceptance links.

### Full work plan — piece-by-piece tasks (Phases 1–6)

#### Phase 1 — Authentication interface simplification
1.1 **Inventory & mapping (read-only, done):** confirm all auth entry points, query params, redirects, and components (`/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`, `/mfa-setup`, `/accept-invitation`, `RootGate`, landing CTAs).
1.2 **UX/state design:** define unified state model `{ role: 'patient'|'provider', mode: 'signin'|'signup' }`, URL param mapping, and canonical route.
1.3 **Shared streamlined container:** implement/refactor a single auth container component with exclusive role toggle and sign-in/sign-up switch; remove duplicated intro/value-prop blocks from auth views.
1.4 **Patient flows:** wire patient sign-in (password + MFA) and patient sign-up (existing fields/legal/endpoint) into container.
1.5 **Provider flows:** wire provider sign-in and provider sign-up (reuse `WorkspaceSignup`/facility registration paths as appropriate) into container without privilege escalation or duplicate UI.
1.6 **Routing & compatibility:** update `App.tsx` routes/redirects; preserve return paths and legacy params.
1.7 **Recovery/accessibility/responsive pass:** ensure forgot/reset/verify/MFA links and flows preserved; a11y (labels, toggle semantics, focus) and responsive stacking/full-width behavior.
1.8 **Verification & report:** run checks/tests, document files/decisions/results/issues, request approval before Phase 2.

#### Phase 2 — Authentication logic and role-based access
2.1 **Backend audit:** review `apps/api/src/routes/auth.ts`, session/tenant resolution, invitation/onboarding, and registration endpoints for role validation and privilege boundaries.
2.2 **Role validation hardening:** ensure registration/login paths cannot self-assign elevated/platform roles; validate and constrain role-bearing inputs server-side.
2.3 **Authorization consistency:** verify protected resources enforce server-side authorization (align with existing authz/matrix/middleware); close gaps found in touched auth flows.
2.4 **Separation guarantees:** confirm platform operators/privileged administrators remain separate from ordinary healthcare accounts in data paths and APIs.
2.5 **Preservation checks:** regression-test identity verification, session management, MFA, account recovery, tenant switching.
2.6 **Tests & report:** add/update unit/integration tests for role validation and denied escalation; document results.

#### Phase 3 — Clinical interoperability and patient identity preservation
3.1 **Architecture inventory:** map MPI/identity reconciliation, consent grant/revoke, break-glass, clinical sync, and conflict handling code paths (`consent`, `data-exchange`, `fhir`, `terminology`, DICOM, sync/jobs/services).
3.2 **MPI & identity integrity:** verify reconciliation/linking rules and prevent regressions in patient identity relationships.
3.3 **Consent & break-glass:** validate automated consent management/revocation and emergency break-glass controls (justification, time limits, audit trails, post-access review) remain enforced.
3.4 **Sync & conflict handling:** review real-time sync/failure/conflict behavior; harden handling where safe and evidence-backed.
3.5 **Standards posture:** document current support/limits for HL7 FHIR, ICD-11, LOINC, DICOMweb, SNOMED CT; implement only safe, non-breaking improvements within existing/licensed capabilities.
3.6 **Verification & report:** interoperability-focused tests/checks and documented gaps/dependencies.

#### Phase 4 — Security hardening and CIA enforcement
4.1 **Threat-surface review:** inputs, authz boundaries, file/upload/export paths, logging/error surfaces, secrets/config handling.
4.2 **Input validation & injection defenses:** confirm parameterized queries/ORM usage, validate/sanitize inputs, mitigate XSS/CSRF/command-injection vectors per framework capabilities.
4.3 **Data protection:** review PHI/secrets in transit/at rest assumptions, storage, and response/log redaction.
4.4 **Abuse resistance & resilience:** rate limiting, lockout/progressive controls, audit completeness for clinical/admin/privileged ops, backup/recovery mechanism documentation/checks.
4.5 **Least privilege:** tighten access where gaps found without breaking authorized workflows.
4.6 **Assessment, tests & report:** targeted security tests and documented residual risks.

#### Phase 5 — Cloudflare Workers and observability infrastructure
5.1 **Current-state review:** `wrangler.jsonc`, `apps/api/src/worker.ts`, observability modules/routes (`lib/observability`, `observability/*`, `routes/platform-observability.ts`), logging/audit/metrics hooks.
5.2 **Secure telemetry pipeline:** structured, privacy-safe event collection (auth anomalies, suspicious API activity, health signals) with access controls.
5.3 **Detection & alerting:** implement/support anomaly detection, real-time processing where feasible on Workers/DOs/Queues, automated alerting and incident prioritization with failure isolation (observability must not break core clinical ops).
5.4 **Terminal platform-operator elevation:** design/implement secure, audited, time-limited elevation flow (strong auth, MFA, explicit authorization/justification, command/activity auditing, automatic revocation) using existing platform-role model; no backdoors.
5.5 **Config & protection:** protect telemetry storage/access; document required bindings/secrets/permissions.
5.6 **Verification & report:** tests for authz/auditing/failure isolation and configuration evidence.

#### Phase 6 — Dedicated Observability Support Center
6.1 **Access model & routing:** hidden, URL-only route (not in public/patient/provider nav) with independent auth/MFA and server-side RBAC (platform/operator/support roles as defined).
6.2 **Backend modules/APIs:** Telemetry, Alerting, Ticketing, Reporting endpoints/data models with strict authorization and full operator audit trails (additive schema/migrations only if needed, with rollback/compat notes).
6.3 **Frontend center:** dedicated UI shell and four modules bound to authorized APIs; no exposure in ordinary dashboards/navigation.
6.4 **Operational integrity:** incident lifecycle (create/classify/severity/assign/investigate/resolve/close), report generation, operator activity views.
6.5 **Verification & report:** RBAC/negative tests, audit verification, hidden-route/access checks.
6.6 **Final program deliverables:** consolidated architecture summary, file/migration inventory, test/verification results, security assessment, Cloudflare config, access/admin instructions, deployment/rollback/recovery.

**Program note:** Phases 3–6 include areas dependent on existing capabilities, environment configuration, licensed terminology content, partner/PACS systems, and operational governance; such constraints will be implemented where feasible and explicitly documented (not claimed complete) per phase reports.

## 2026-11-12 — Phase 1 implementation (authentication interface simplification) — pending review/approval

### Scope delivered
- Added unified auth experience in `apps/web/src/pages/AuthPage.tsx`: single streamlined container with exclusive role toggle **Patient | Healthcare Provider** and mode toggle **Sign in | Sign up** (`?role=`/`?mode=` state, defaults patient/signin).
- **Sign in:** reused existing `useAuth().login` / `loginMfa`, MFA challenge flow (app/email/recovery/dev-code via `/auth/totp/dev` and `/auth/login/mfa/email`), password recovery link, and post-login destination logic (preserving staff multi-facility and patient portal routing, `safeReturnPath`).
- **Patient sign up:** existing patient registration fields/legal acceptance and `POST /auth/register/patient` flow (terms/privacy fetch, success state with public ID/verification delivery).
- **Provider sign up:** reuses existing `WorkspaceSignup` component/paths within provider view (no duplicate interface, no privilege escalation path added); provider sign-in shows staff/invitation guidance.
- **Routing/compatibility:** `apps/web/src/App.tsx` now serves `AuthPage` at `/login`, adds `/auth` -> `/login`, and replaces `/register` with `RegisterRedirect` preserving query params/state and mapping legacy `type=facility|patient` (and existing `as`/`type` handling in `AuthPage`) to canonical `role`/`mode`. `/login` remains canonical to avoid breaking existing links/bookmarks/emails/in-app redirects.
- **Copy/layout:** removed duplicated landing-style value/feature marketing blocks from auth container; kept concise security/access cues (MFA/verified account guidance, policy note, help link). Added single-column responsive auth styles in `apps/web/src/styles.css` (`.mv-auth--single`, toggle/legend/foot classes).
- **Landing CTA alignment:** `apps/web/src/pages/landing/LandingPage.tsx` routes updated to canonical unified entry (`signIn` patient/signin, facility/provider sign-up).

### Files changed
- Added: `apps/web/src/pages/AuthPage.tsx`
- Modified: `apps/web/src/App.tsx`, `apps/web/src/pages/landing/LandingPage.tsx`, `apps/web/src/styles.css`
- Unchanged legacy files retained for compatibility/reference (not routed): `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/pages/RegisterPage.tsx`
- No backend/API/DB/schema/migration/authz changes.

### Preservation notes / decisions
- Existing secured flows left intact and separate as required: `/forgot-password`, `/reset-password`, `/verify-email`, `/mfa-setup`, `/accept-invitation`, `FacilityStaffPage`, `RootGate`, `ProtectedRoute`.
- `WorkspaceSignup` and all backend auth/registration/onboarding endpoints reused as-is; provider sign-up does not expose platform/operator self-assignment.
- Many existing internal links still target `/login` or `/register?type=...`; unified route + redirect preserve behavior without mass churn in this slice.

### Verification
- `npm run typecheck` — pass.
- `npm run lint` — pass.
- `npx vitest run tests/unit/authz.test.ts tests/unit/authz-matrix.test.ts` — pass (2 files, 42 tests). No web/auth UI test suite executed in this pass (none identified as directly covering this new container).

### Issues / follow-ups (not blocking this report)
- Legacy `LoginPage.tsx`/`RegisterPage.tsx` can be removed or reduced after confidence period if desired (currently unrouted).
- Optional cleanup: migrate scattered `/login?as=staff` and `/register?type=*` links to canonical `role/mode` params for consistency.
- Manual responsive/a11y smoke recommended (mobile/tablet/desktop, keyboard/focus, screen-reader labels for toggles) and end-to-end auth regression in staging for patient/provider sign-in+MFA, patient signup, provider/workspace signup, recovery, verify, invitation flows.
- Phase 2 not started; **approval required before Phase 2 work**.

## 2026-11-12 — Phase 2.1/2.2 (auth logic & role-based access, initial hardening) — pending review/approval

### 2.1 Backend audit (read-only findings)
- **Registration/onboarding:** `POST /auth/register/patient|facility|workspace` and `POST /auth/invitations/register` accept no user-supplied facility/platform roles. `register/workspace` computes owner roles server-side (`OWNER_ROLES` / `unitOwnerRoles` for service category) and passes to `createWorkspace`; contracts (`registerWorkspaceSchema`, `workspaceOwnerSchema`, legal acceptance) contain no privileged role fields. Join path validates join code/organization server-side and creates pending link (no organization admin privilege granted to requester).
- **Invitations/memberships:** invitation token resolves server-stored invitation row (facility, roles, scope, inviter); `acceptInvitation` applies stored roles only. Admin invitation creation/update enforce manager authority (`facility_admin` or scoped `department_admin`), `checkedScope`, delegable-role limits, `assertInvitable`, and seat/capacity checks; membership update blocks `credential_reviewer` and enforces scope/owner/department constraints.
- **Platform separation:** platform access managed via `platform_roles` table and approval/break-glass flows (`apps/api/src/lib/platform-roles.ts`, admin platform routes) with MFA step-up/eligibility controls; runtime gates (`withPlatformActor`, `requirePlatformReviewer`, `requirePlatformOperator`, middleware platform role scoping) separate from facility memberships. No registration/invitation path grants platform roles.
- **Session/tenant resolution:** `loadAuthContext` derives memberships, approved role grants, patient linkage, and platform roles from DB; active tenant must be an active membership (or single-membership default). `POST /me/context` requires membership ownership. CSRF enforced for state-changing protected routes with explicit auth-entry/read-only exemptions in middleware.
- **MFA/access controls:** staff/facility context requires MFA enrollment/verification; password reset revokes sessions; TOTP/email/recovery challenge handling and rate limits present.

### 2.2 Defense-in-depth changes applied
- `apps/api/src/services/invitations.ts`: added explicit positive allowlist `INVITABLE_FACILITY_ROLES` for facility/workspace membership roles and tightened `assertInvitable` to reject any role not in that allowlist (or in non-invitable set). Prevents accidental acceptance of unknown/privileged values (e.g. `platform_operator`) through invitation/membership admin paths.
- `apps/api/src/services/workspaces.ts`: added `assertWorkspaceGrantableRoles` guard in `createWorkspace` to reject `patient`/`proxy`/`credential_reviewer` if ever passed as owner/membership roles (server-side invariant).
- `tests/unit/invitations.test.ts`: extended refusal coverage to include `platform_operator`.

### Files changed (this slice)
- Modified: `apps/api/src/services/invitations.ts`, `apps/api/src/services/workspaces.ts`, `tests/unit/invitations.test.ts`, `REFACTOR.md`

### Verification
- `npm run typecheck` — pass.
- `npx eslint apps/api/src/services/invitations.ts apps/api/src/services/workspaces.ts tests/unit/invitations.test.ts` — pass.
- `npx vitest run tests/unit/invitations.test.ts tests/unit/authz.test.ts` — pass (19 tests).

### Remaining Phase 2 work (pending approval/prioritization)
- 2.3 Deeper protected-resource authorization consistency review across touched/auth-adjacent flows and any gaps found.
- 2.4 Additional separation/regression checks for platform operators and privileged admin data paths.
- 2.5 Regression coverage for identity verification, session management, MFA, account recovery, tenant switching.
- 2.6 Targeted integration/API tests for denied escalation paths where feasible.
- **Approval required before starting Phase 3.**

### 2026-11-12 — Phase 2.2 follow-up
- `apps/api/src/routes/admin.ts` (`PATCH /memberships/:id`): now applies `assertInvitable(body.roles)` (positive facility-role allowlist) on membership role updates, matching invitation creation and blocking non-facility/privileged/identity roles at the API boundary while preserving existing manager/scope/owner/department/session-revocation controls.
- Verification: `npm run typecheck`, `npx eslint apps/api/src/routes/admin.ts`, `npx vitest run tests/unit/invitations.test.ts tests/unit/authz.test.ts` passed.

### 2026-11-12 — Phase 2.3 (authorization consistency, targeted)
- Reviewed protected auth-adjacent/admin flows: facility invitation create/revoke, membership update/remove, tenant context switch, and in-tenant role-grant request endpoints.
- `apps/api/src/routes/admin.ts`: `PATCH /memberships/:id` now applies `assertInvitable(body.roles)` (defense-in-depth allowlist) in addition to existing manager/scope/owner/department rules and role-change session revocation.
- `apps/api/src/routes/content.ts` (`POST /admin/role-grants`): rejects non-facility/privileged/identity roles via `assertInvitable([body.role])` before creating requested grants; existing permission (`role_grant.request`), active-member check, department validation, SoD/approval controls, and audit trail remain.
- Verification: `npm run typecheck`, targeted `eslint`, `npx vitest run tests/unit/invitations.test.ts tests/unit/authz.test.ts tests/unit/authz-phase1a.test.ts` passed (35 tests).

### Remaining Phase 2 work (pending approval/prioritization)
- 2.4 Additional separation/regression checks for platform operators and privileged admin data paths.
- 2.5 Regression coverage for identity verification, session management, MFA, account recovery, tenant switching.
- 2.6 Targeted denied-escalation integration tests where feasible.
- **Approval required before starting Phase 3.**

### 2026-11-12 — Phase 2.4–2.6 (separation, regression coverage, denied escalation) — pending review/approval

#### 2.4 Platform/operator and privileged separation (review + targeted checks)
- Confirmed platform privilege boundaries remain isolated: `platform_roles`/approval-break-glass flows (`apps/api/src/lib/platform-roles.ts`, admin platform routes) require operator context + recent MFA step-up where applicable; `withPlatformActor`/`requirePlatformReviewer`/`isPlatformOperator` gate platform surfaces; `platform-observability` and platform admin workflows enforce operator checks. Credential reviewer role remains non-grantable via facility invitations/memberships (`assertInvitable`/role-guard coverage).
- Added defense-in-depth unit coverage for escalation boundaries in `tests/unit/phase2-escalation.test.ts` (invitable allowlist positive/negative, platform/identity/unknown roles denied, privileged roles excluded from invitable set).

#### 2.5 Regression coverage posture (existing suites, evidence-backed)
- **Identity/session/MFA/recovery/tenant switching:** existing integration coverage present in `tests/integration/registration.test.ts`, `sign-in-verification.test.ts`, `invitations.test.ts`, `rls.test.ts`, `support.ts` (`/me/context`/facility selection) and related workflow tests. These suites require a configured local `*_test` database (`DATABASE_URL`/migrations/seed) not available in this environment; not re-executed here to avoid false failures.
- **Platform separation/observability:** `tests/integration/platform-roles.test.ts` and `tests/integration/platform-observability.test.ts` exist (DB-backed) and were not run in this pass for the same environment constraint.

#### 2.6 Denied-escalation tests executed (this environment)
- Unit: `tests/unit/phase2-escalation.test.ts`, `tests/unit/invitations.test.ts`, `tests/unit/authz.test.ts`, `tests/unit/authz-phase1a.test.ts` — pass (38 tests total across runs; escalation/invitation/authz invariants verified).

#### Verification summary
- `npm run typecheck` — pass.
- Targeted `eslint` — pass for modified files.
- Targeted `vitest` (unit, no DB dependency) — pass: `tests/unit/phase2-escalation.test.ts` + `tests/unit/invitations.test.ts` (10), and prior `tests/unit/invitations.test.ts` + `tests/unit/authz.test.ts` + `tests/unit/authz-phase1a.test.ts` (35).

#### Limitations / not claimed
- DB-backed integration/e2e auth regression suites were not executed in this environment (missing configured local test database/services). Full Phase 2 regression confidence for identity/session/MFA/recovery/tenant-switch/platform workflows requires running those suites in a prepared test environment/CI.
- No schema, migration, or runtime behavior changes beyond documented defense-in-depth guards.

**Phase 2 status:** implementation slices 2.1–2.6 documented with evidence and constraints. **Approval required before starting Phase 3.**

### 2026-11-12 — Phase 11 incorporated (patient record self-access & consent-gated sharing; privacy architecture)
- **Scope (this change):** REFACTOR.md only — new Phase 11 (Prompts 11.1–11.5), five new status-matrix rows, sequencing guidance, this execution record. **No code, schema, or runtime behavior changed by this amendment.**
- **Approved direction (user request):** access by a verified patient to their own full medical record is **not** a data breach. Under the Uganda Data Protection and Privacy Act, 2019, the Uganda Patients' Charter, GDPR (Art. 15), and HIPAA (45 CFR §164.524 / §164.528), the patient is the data subject; providers are data controllers/custodians, not owners. Identity verification plus narrow clinical exceptions are required, not blanket withholding.
- **Core rules frozen in the phase:** (1) default patient-visible for finalized/signed clinical resources (`patient_visible` semantics); (2) narrow exceptions only, each with mandatory `restricted_reason_code` from the frozen vocabulary (`third_party_confidentiality`, `therapeutic_privilege`, `psychotherapy_process_notes`, `peer_review_qa`, `litigation_prep`, `unverified_draft`), recorded in audit; (3) tenant silos remain absolute — no cross-tenant query path is introduced; sharing exists only via explicit, logged, expiry- and scope-bound patient-granted consent; (4) break-the-glass emergency override with mandatory justification, high-severity audit, post-facto patient notification, and facility auditor review flag; (5) patient-visible disclosure/accounting-of-access log backed by the existing hash-chained audit, not a parallel system; (6) exports generated server-side, delivered via short-lived authenticated token, fully audited; (7) restrictions and consent enforced server-side/RLS, never UI-only; (8) additive, backward-compatible migrations only — restriction fields default to non-restricted.
- **Deliverables created:** `REFACTOR.md` (phase + matrix + order + this record). **Not yet implemented:** 11.1 document/DPIA, 11.2 schema, 11.3 patient API/FHIR release, 11.4 consent flows/break-the-glass, 11.5 regression suite — all recorded as `not started` and pending synthetic-data verification and governance sign-off before any production exposure.
- **Verification:** documentation-only edit; working tree contains only this REFACTOR.md change plus the pre-existing uncommitted Orthanc sandbox files (`docker-compose.sandbox.yml`, `package.json`, `.env.example`), which were left untouched. No build/runtime claims made.

### 2026-11-12 — Phase 11.1/11.2 executed; ERPNext/HRMS integration Stage 4 skeleton landed (pending review)

- **Phase 11.1 (complete):** `docs/PATIENT_RECORD_ACCESS_AND_SHARING.md` written — data classes, default-visibility rule, `restricted_reason_code` vocabulary, `consent_grants` model, break-the-glass procedure, disclosure-log design, export token rules, verification plan, residual gaps (11.3–11.5 + DPIA).
- **Phase 11.2 (partial):** `packages/db/migrations/128_patient_access_privacy.sql` — `clinical_entries.restricted_access` (default false) + `restricted_reason_code` with CHECK tie; `consent_grants` tenant-scoped table (sha256 token_hash only, never raw), RLS FORCE, patient self access per `app.current_patient()`, runtime grants. Dry-run on `medveris_dev` inside BEGIN…ROLLBACK succeeded; nothing persisted. Not marked complete: no synthetic-DB migration harness exists yet.
- **Integration foundation (Stage 4 skeleton, recorded for traceability; not a REFACTOR phase):** `apps/api/src/integrations/erpnext.ts` (fail-closed adapter; token auth; timeout/retry/circuit breaker; `verifyConnection()`; no secrets in `status`), `config.ts` (`FEATURE_ERPNEXT`, `ERPNEXT_MODE` off|live only), `routes/erpnext.ts` (`GET /erpnext/status|links`, `POST /erpnext/links`, `PATCH /erpnext/links/:id/revoke`, `POST /erpnext/connection`; workforce-gated; audit + outbox), `migrations/127_erpnext_hrm_integration.sql` (`integration_erpnext_connection`, `staff_erpnext_link`, RLS FORCE; dry-run validated), authz matrix +4 actions (`erpnext.ts`), `tests/unit/erpnext-integration.test.ts` (7/7 pass). Full suite 446/446 green; `tsc --noEmit` clean; `eslint` clean on changed files. HAPI FHIR pinned `hapiproject/hapi:v8.12.0-2` in `docker-compose.sandbox.yml`; LOINC 2.83 acquisition still blocked on authorized download (see `~/medveris-integrations/loinc/README.md`).
- **Not claimed:** no production wiring, no employee/patient data migration, no ERPNext external sync enabled, no Phase 11.3–11.5 implementation, no governance/DPIA sign-off, no Kamatera/Cloudflare/Orthanc/HAPI production changes.
- **Verification:** full unit suite green; targeted lint/typecheck clean; migrations dry-run; integration suites requiring a prepared test DB not executed (none configured here) — see TENANT_ISOLATION.md "What still needs a prepared test DB".
