# Integrated departments: gap analysis and phased plan

Date: 2026-10-28. Scope: the integrated HMS directive (pharmacy "Octa Pharm", laboratory "Phleb Tec", radiology "RadioPlus", shared governance, billing, inventory and the unified record). Evidence is the code at `a2901eb` plus the fixes below; file references are relative to the repository root. Status labels follow `FEATURE_GAP_MATRIX.md`. All data is synthetic and nothing here is clinically validated.

## Decision: extend, do not add three applications

MedVeris already runs pharmacy, laboratory and radiology as role-guarded modules on one tenant model, with forced row-level security, a transactional outbox, audit and an integration registry. The three products are integrated as bounded modules inside the existing API (`apps/api/src/routes/{pharmacy,diagnostics,radiology,inventory,finance}.ts`), schema and web app. No technology change is needed. Each module keeps its own routes, permissions, worklists and reports, and talks to the others through shared records (orders, results, invoices, inventory movements) and outbox events.

## Defects fixed in this pass

| Defect | Risk | Fix | Evidence |
|---|---|---|---|
| `POST /lab-results` accepted `status: final` from a clinician and recorded them as verifier of their own result | Bypassed two-person validation | Results are always entered as preliminary; finalisation is the separate `/finalize` step by another clinician or `lab_validator` | `departments.test.ts` (clinician final-at-entry returns 403 and stores nothing) |
| Diagnostic worklist sorted on priority `stat`, which the schema never stores; `emergency` sorted with routine | Emergency specimens queued behind routine work | Sort `emergency`, then `urgent`, then routine | `departments.test.ts` (emergency order ahead of urgent) |
| Order detail hid "Finalize result" from `lab_validator` and offered clinicians a "Final" option at entry | Validators could not validate in the UI | Validators see the action; entry is preliminary only | Build, lint |
| Assisted registration derived the facility MRN from the last four characters of the public ID | Same-facility collisions after roughly a thousand patients; registration failed with HTTP 500 on `tenant_local_mrn_unique` (reproduced by `patients.test.ts` on an accumulated test database) | MRN carries the whole public ID body (`localMedicalRecordNumber`), unique because public IDs are; existing MRNs unchanged | `domain.test.ts`, `patients.test.ts` |
| Radiology critical findings could be sent to `specialist_clinician`/`midwife` and escalated to `department_lead`, who cannot read the row (RLS) or acknowledge it | Finding addressed to someone who cannot open it | Recipients must be clinician or nurse, escalation must be a clinician | `radiology.test.ts` |

## Gap analysis

### Pharmacy
Implemented: medicine list, clinician prescribing, pharmacist approve/reject review, lot receipt with expiry blocking, idempotent dispensing recorded against pharmacist, lot, quantity and prescription, administration, audit.
Gaps, in priority order:
1. **Prescribed quantity is not recorded** (`medication_orders` has dose, frequency and duration only), so an active order can be dispensed without limit. Needs a prescribed quantity and a dispensed-versus-prescribed cap. Safety-critical.
2. Pharmacy stock (`stock_lots`) is separate from the inventory ledger (`inventory_items/lots/movements`), which already has FEFO, transfers, reservations, recalls and valuation. Migrate pharmacy stock onto the ledger instead of building a second one.
3. No allergy check at review or dispense although `allergies` exists. Interaction, duplicate-therapy and dose checks need a licensed drug knowledge source and must stay **Unavailable** until one is contracted.
4. No clarification or substitution request to the prescriber, no counselling record, no dispense return or reversal.
5. Missing: suppliers, purchase orders, goods received notes, controlled-medicine register and permission, point of sale, receipts, refunds, credit control.
6. RLS lets `pharmacist` write `medication_orders`; restrict to status changes through the review route. `facility_admin` passes the API read check but RLS returns nothing.

### Laboratory
Implemented: LOINC-coded test catalogue, clinician orders, specimen collect/receive/reject, result entry, separate-person validation, correction with immutable version history, critical communication and acknowledgement, release, turnaround report.
Gaps:
1. No panels, structured reference ranges (by sex, age, method), automatic flagging, calculated tests or delta checks.
2. No accession numbers, barcode labels, custody log, storage or disposal states; no recollection workflow.
3. No technical-review step before validation; no escalation for unacknowledged critical lab results.
4. Released `lab_results` rows are updated in place on correction (history survives only in `lab_result_versions`); runtime may update/delete `lab_results`. Make released values immutable at the database level.
5. Patients' RLS read on `lab_results` ignores release status; no patient route exposes results yet. Restrict to released results before adding one.
6. Missing: QC, EQA, nonconformity and corrective-action records; reagent consumption linked to tests; analyser link to equipment; external referral laboratories; printable patient report; charges.

### Radiology
Implemented: server accession numbers, acquisition states, 12 versioned structured templates, autosaved drafts, radiologist-only signing, immutable signed versions, addenda, corrections, critical findings with overdue, escalation and acknowledgement, turnaround, honest DICOMweb status (no PACS state other than `not-configured`).
Gaps:
1. Legacy `POST /imaging-studies` and `/diagnostic-reports` (`diagnostics.ts`) bypass templates, acquisition checks and critical-communication gating. Retire them in favour of `/radiology/*`.
2. No procedure catalogue (modality list is free text and hard-coded in the UI; no mammography or fluoroscopy), no room or modality scheduling, no preparation instruction catalogue.
3. No radiation dose, pregnancy screening or contrast administration records.
4. No sensitive-study restriction; no equipment-to-modality link or availability; no consumable or contrast consumption; no charges; no utilisation or repeat-study indicators; no external image import with provenance.

### Shared foundation and governance
Implemented: tenants within organisations, `departments`/`units`/`locations`/`department_assignments` with an `enabled` flag, 38 roles with implied roles, time-limited department-scoped role grants, `facility_admin` excluded from clinical content by RLS, break-glass with re-authentication, reason, expiry and auditor review, outbox with retries and dead-lettering.
Gaps:
1. **Department activation is not enforced**: `departments.enabled` gates no route and no navigation item.
2. `department_lead` cannot manage its own department's staff, settings or reports; no working hours, escalation rules or budgets per department.
3. No notifications table or delivery; outbox consumers only mark events recorded. Low stock, near expiry and critical results are pull-only.
4. Break-glass has no automated tests.
5. Referrals to other facilities are free text; no branch dimension on operational records; no plans or licensing; no offline mode (deliberately deferred).

### Billing, finance and inventory
Implemented: invoices and items, manual payments (cash, bank transfer, mobile money recorded manually), payment reversal, claim creation, reconciliation report; inventory ledger with department-scoped locations, FEFO, reservations, transfers, requisitions, approvals, recalls and idempotent movements.
Gaps:
1. **No charge capture**: lab orders, imaging studies and dispenses create no invoice lines, so there is nothing to deduplicate. `invoice_items` has no department or source reference; invoice creation has no idempotency key.
2. No payer or insurance arrangement table (insurer is free text); claims cannot change status.
3. No refunds, credit notes or void route; no department revenue reporting.
4. Payment providers stay **Unavailable** until a verified adapter exists (`INTEGRATION_AVAILABILITY.md`).

### Unified patient record
Clinical notes, observations, conditions, allergies and follow-ups are shown; prescriptions, dispensing, laboratory results, imaging reports and billing live behind separate per-module endpoints. The patient portal shows none of them.

## Phased plan

Each phase is a set of forward-only migrations with tests, released through the staging gate before production. No phase enables an external integration; adapters follow `INTEGRATION_AVAILABILITY.md`.

| Phase | Deliverable | Schema | Acceptance tests |
|---|---|---|---|
| 2a | Department activation: facility administrators activate or deactivate pharmacy, laboratory and radiology; inactive modules refuse their routes (409 `department_inactive`) and disappear from navigation; changes audited | `facility_modules` (tenant, module, active, changed_by, reason); absent row means active so existing facilities keep working | Inactive module refuses commands and lists; reactivation restores; other tenants unaffected |
| 2b | Prescribed quantity and dispense cap; allergy check at pharmacist review with recorded override reason | `medication_orders.quantity_prescribed`, dispensed totals | Over-dispensing refused; allergy match needs override reason; retries do not double-count |
| 2c | Charge capture: one invoice line per billable order item or dispense, keyed by source, priced from `service_catalog`, attributed to the department; cancellation and specimen rejection reverse the line | `invoice_items.source_type/source_id` unique, `department_type`; `lab_tests.service_id`, imaging procedure price, medicine price | Retried order does not duplicate a charge; cancellation reverses once; department revenue report |
| 2d | Notifications: department and user inboxes fed by outbox consumers for low stock, near expiry, critical results and clarification requests, with acknowledgement | `notifications`, consumer checkpoints | Event produces one notification; acknowledgement audited; RLS per recipient |
| 3 | Laboratory depth: panels, structured reference ranges and automatic flags, accession and barcode, custody log, technical review, critical escalation, immutable released values, QC/EQA records | lab panel, range, accession, custody, QC tables | Flags from ranges; released value cannot be updated; QC failure blocks release when configured |
| 3 | Pharmacy depth: pharmacy stock on the inventory ledger, suppliers, purchase orders and GRN, controlled-drug register, clarification and substitution workflow, returns | supplier, PO, GRN, register tables | Controlled dispense needs register entry and permission; GRN updates ledger once |
| 3 | Radiology depth: procedure catalogue, room and modality scheduling, safety screening and contrast records, sensitive-study restriction with audited access, retire legacy imaging routes | procedure, room, screening tables | Sensitive study hidden without reason; double-booked room refused |
| 4 | Unified record and portal: combined patient chart and released results in the portal | none, or views | Portal shows only released results; access audited |
| 5 | Security and compliance verification: break-glass tests, role-boundary matrix per module, privacy review, DPPA 2019 assessment by qualified reviewers | — | Matrix tests; signed review records |

## External dependencies (status stays honest until resolved)

| Dependency | Needed for | Current state |
|---|---|---|
| Licensed drug knowledge base | Interaction, duplicate-therapy and dose checks | Not contracted: checks report Unavailable |
| LIS or analyser interface specification and test endpoint | Analyser results | Unavailable |
| PACS / DICOMweb endpoint with conformance tests | Images, DICOM import | Unavailable |
| Payment provider and insurer interfaces | Online payments, electronic claims | Unavailable |
| SMS provider | Text notifications | Not configured; email works through Resend |
| Licensed SNOMED CT / LOINC distribution | Production terminology | Unavailable in production |
| Clinical safety, pharmacy, laboratory and radiology sign-off | Reference ranges, critical thresholds, templates, controlled-drug rules | Not obtained |
| Legal and privacy review (Uganda DPPA 2019) | Production use with real patients | Not obtained |
