# Implementation Blueprints: Clinical Routing, Finance, Workforce, Interoperability (Phases 5–9)

Consolidated actionable design for remaining master-requirement areas. Each item must be implemented incrementally with additive DB changes, backend enforcement, audit/idempotency/transactions, tests, and mobile-first UI updates.

## Phase 5 — Patient registration and initial billing
- **Backend:** hook post-registration/patient-facility-link creation (reception/onboarding/patient services) in a single transaction: resolve facility billing config + default consultation fee + applicable price list; create billing-radar/initial invoice or charge entry if not already present (idempotency key = tenant+patient+registration event/context). Store traceability refs (patient, tenant, registration/encounter source, price list/version, amount, currency). Support exemptions/insurance/discounts/adjustments/zero-cost via authorized config; never mark delivered/paid.
- **DB (additive):** billing radar/initial-charge markers or unique partial index for idempotency; config fields for default consultation fee/price list linkage if missing.
- **API/UI:** expose status in registration/reception/patient/finance views; handle retries gracefully.
- **Tests:** new registration creates exactly one initial entry; retry/idempotent; facility-specific pricing; exemption/zero-cost authorized cases; no false delivered/paid state.

## Phase 6 — Comprehensive financial management
- **Revenue/patient billing:** audit and complete invoice/receipt lines for consultation/procedure/pharmacy/lab/radiology, insurance/third-party, balances/receivables, refunds/discounts/adjustments with dual-auth where high-risk, categorization, and reconciliation to transactions.
- **Payroll (gap):** additive schema for employment details, grade/salary/allowances, payroll periods/runs, earnings/deductions components, approvals, disbursements/payment history; service layer for calculation engine (configurable components, idempotent run generation), authorization, and audit. UI for setup/run/history/reports. Keep separate from clinical records.
- **Operational expenditure:** additive schema for expense categories, vendors/payees optional, recurring/non-recurring entries, approvals, attachments refs, links to maintenance/supplies/utilities/admin costs; reports and authorization.
- **Reporting:** revenue/expenditure summaries, cash flow, receivables aging, payroll expenditure, operational cost breakdowns, P&L where applicable; exportable (authorized, no PHI leakage), reconciled.
- **Key paths:** `routes/finance.ts`, `routes/billing.ts`, `services/billing.ts`, domain billing, `routes/pharmacy-pos.ts`, workforce/payroll refs, jobs; decompose monoliths per slice.

## Phase 7 — End-to-end clinical workflow automation
- **Order routing service:** normalize order creation for lab/radiology/pharmacy/other service requests (`ServiceRequest`-like internal model): persist order + destination department + unique business ID + status `pending`, enqueue/notify destination work queue transactionally, emit audit/outbox. Idempotency key prevents duplicates on retry.
- **Statuses:** enforce valid transitions (`pending→acknowledged→in_progress→completed|cancelled|rejected` as applicable) with actor/role checks, timestamps, reasons, and audit.
- **Result linkage:** lab results, imaging reports/studies, medication dispense/admin records must reference originating order and encounter; clinician-facing encounter/timeline views aggregate authorized results.
- **Reliability:** outbox/job retry for notifications/integration dispatch without duplicate domain effects; failure states visible and auditable.
- **Coverage:** outpatient, inpatient, pharmacy, lab, radiology; verify end-to-end per department.
- **Key paths:** `routes/workflow.ts`, `routes/{clinical,diagnostics,radiology,pharmacy,reception,inpatient,care}.ts`, `services/clinical.ts`, queue/worklist views.

## Phase 8 — Staff onboarding and professional cadres
- **Configurable taxonomy:** data-driven cadre/profession/department/specialty catalogs (searchable) covering required categories and facility-defined additions; separate entities/fields for professional cadre, department assignment, system role, and permission level.
- **Onboarding/invitations:** secure tokenized invite/accept/verify flows, expiry/revocation, least-privilege role assignment by authorized admins, audit of grants/changes, mobile-first UI.
- **Integration:** connect to RBAC/permissions, credentialing/privileging context, workforce records/payroll eligibility where relevant.
- **Key paths:** `routes/{workforce-reference,organization,workspace,onboarding,admin,credentials}.ts`, `services/invitations.ts`, seed/reference data, memberships.

## Phase 9 — Interoperability and terminology
- **9.1 Central terminology/mapping layer (foundational):** additive schema/services for code systems (ICD-11, SNOMED CT, LOINC, local), versions/releases/effective dates, concepts, value sets, and mappings (internal code ↔ standard code) with provenance, status, and audit; import/export/validation APIs; keep original clinical text; runtime adapters resolve by tenant/config/version.
- **9.2 LOINC:** map lab tests/observations/panels/results; use in order/result capture and exchange.
- **9.3 ICD-11:** diagnosis/problem coding with search/selection, versioning, reporting/billing hooks (not auto-billable).
- **9.4 SNOMED CT:** findings/procedures/symptoms/problems encoding and search/mapping; license-aware enablement.
- **9.5 FHIR R4:** expand `apps/api/src/fhir/{capability,router,mapping}.ts` and services for supported resources (Patient, Practitioner, Organization, Encounter, Observation, Condition, DiagnosticReport, ServiceRequest, MedicationRequest, MedicationDispense, ImagingStudy, AllergyIntolerance, Procedure, relevant admin/financial) with correct references, search params, validation, tenant/patient authorization, and truthful capability statement; implement writes/bundles/transactions only where safe and scoped.
- **9.6 DICOM/DICOMweb:** harden QIDO-RS/WADO-RS, add STOW-RS if storage/integration architecture supports, link ImagingStudy/ServiceRequest/DiagnosticReport/encounter/patient; authorized access and audit.
- **Blockers (must document, not assume):** SNOMED CT/ICD-11/LOINC licensing and distribution, terminology servers/content packages, partner PACS/FHIR endpoints, conformance testing, national regulatory requirements.

## Cross-cutting requirements for all phases
- Additive, backward-compatible migrations with RLS/grants/policies/integrity checks and rollback plans.
- Transactional multi-write operations, idempotency for retries/callbacks/jobs.
- Backend RBAC/permission checks + dual authorization for designated high-risk actions.
- Complete audit records (actor(s), approver, timestamps, action, affected record, before/after, status) and protected-read auditing as required.
- No PHI/secret leakage in logs/errors/exports.
- Mobile-first UI for every affected screen.
- Automated tests and verification evidence per slice.
