# Feature gap matrix

Status date: 30 October 2026. Labels follow the master prompt: PASS, PARTIAL, BLOCKED, UNAVAILABLE, NOT_TESTED, FAILED, NOT_REQUESTED. \"Evidence\" names tests that ran against the current code (see `IMPLEMENTATION_LOG.md`). Nothing here has been verified with real patients, real clinicians or real external partners. Production runs on synthetic data only.

## Reconciliation note

The 28 October revision of this matrix listed structured radiology reporting, authorised patient merge, the reports framework, the separate §16 roles, concurrent bed allocation and browser journeys A–G as outstanding. All six were implemented and tested afterwards (`b84ab05`, migration `025`, `reports/definitions.ts`, `packages/authz`, `reliability.test.ts`, `journeys.spec.ts`). They are marked accordingly below; only genuine gaps remain.

| # | Requirement area | Status | Evidence | Remaining work |
|---|---|---|---|---|
| 1 | Patient identity: durable public ID, demographics, assisted registration | PASS (synthetic) | `patients.test.ts`, `patient-lookup.spec.ts` | Production identity-proofing policy |
| 1a | Duplicate detection, review and authorised merge | PASS (synthetic) | `patients.test.ts` (facility-scoped candidates, no auto-merge); `patient-merge.test.ts` (two-person approval, blocker codes, reversal with reason, audited) | Cross-facility merges stay with platform review |
| 1b | Exact lookup and facility search | PASS (synthetic) | `patients.test.ts` lookup suite, `patient-lookup.spec.ts` | — |
| 1c | Contacts, next of kin, emergency contacts | MISSING | No patient contact columns or UI; only free-text caregiver relationship in `CaregiversPage.tsx` | Schema, API, registration UI and disclosure rules |
| 2 | Reception: walk-in, appointments, queues, triage | PARTIAL | `MVP_STATUS.md`; `journeys.spec.ts` Journey A; `waiting-times` report | Visit numbering, printed labels/slips and no-show reporting are not implemented |
| 2a | Duplicate encounter on repeated submission | PASS | `reliability.test.ts`: retried key replays, concurrent submissions create one encounter, second open encounter for an appointment returns 409 | — |
| 3 | Consultation/EMR: signed notes, amendments, versions | PASS (synthetic) | `domain.test.ts`, `clinical-smoke.mjs`, note integrity check in `workflow.ts` | Clinician workload and outcome reports |
| 4 | Pharmacy (internal): prescriptions, review, dispense, stock, FEFO | PARTIAL | `departments.test.ts` pharmacy flow, `reliability.test.ts` (failed/concurrent/retried dispense), `inventory.test.ts` | Interaction checks need verified clinical data; controlled-medicine reconciliation not verified |
| 4a | Pharmacy external adapter | UNAVAILABLE | `integration-registry.test.ts` | See `INTEGRATION_AVAILABILITY.md` |
| 5 | Laboratory (internal): orders, specimens, verification, correction, critical result | PARTIAL | `departments.test.ts` diagnostics flow, `terminology.test.ts` (LOINC/UCUM validation) | Reference intervals by demographic/method, QC records |
| 5a | LIS/analyzer adapter | UNAVAILABLE | `integration-registry.test.ts` | No adapter exists |
| 6 | Radiology: structured, versioned reports, drafts, sign-off, addenda, turnaround | PASS (synthetic) | `radiology.test.ts` (12 tests), `journeys.spec.ts` Journey C, `RadiologyReportPage.tsx` | Clinical template approval by named radiologists |
| 6a | PACS/DICOMweb | IMPLEMENTED, GATED | `pacs.test.ts` against a fake PACS; QIDO-RS/WADO-RS and study linkage | Becomes `available` only after a recorded passing conformance run against the configured PACS; STOW-RS not implemented |
| 7 | Maternity and newborn | PARTIAL | `hospital.test.ts` | Forms and escalation rules need maternity-staff approval |
| 8 | Wards: admissions, beds, nursing, handoff, discharge | PASS (synthetic) | `departments.test.ts`, `reliability.test.ts` (only one of two concurrent admissions takes a bed), `bed-occupancy` report with average length of stay | Specialty clinical templates remain generic |
| 9 | Cross-department journeys A–G | PASS (synthetic) | `journeys.spec.ts`: A outpatient, B laboratory, C radiology, D pharmacy, E inpatient, F maternity, G finance | — |
| 10 | Finance: invoices, cash, mobile money, reversals, claims | PARTIAL | `departments.test.ts` finance flow, `workflow-payments.test.ts`, `financial-reconciliation` report | Insurance/clearing-house integration; no provider-confirmed settlement beyond Yo! |
| 10a | Payment provider | IMPLEMENTED, GATED | `workflow-payments.test.ts` with a fake Yo! gateway; signed notifications and status checks | `available` only when `FEATURE_PAYMENTS`, `YO_MODE` and the Yo! credentials are configured |
| 11 | Reports framework (filters, pagination, export, KPIs) | PASS (synthetic) | `reports.test.ts`; role- and department-scoped definitions, CSV export with formula-injection guard, staleness bound, replica-tolerant reads | No broad BI/ad-hoc query layer |
| 12 | Roles and authorization | PASS | `authz.test.ts`, `rls.test.ts`, `departments.test.ts`; separate `radiographer`, `radiologist`, `lab_validator`, `ward_manager`, `privacy_officer` and scoped workspace roles | — |
| 13 | Staff MFA enrolment | PASS (synthetic) | `mfa-setup.spec.ts` | — |
| 14 | Integration availability registry | PASS | `integration-registry.test.ts`, `departments.test.ts` | — |
| 15 | Audit events and checkpoints | PASS (local) | Audit writes in command paths; `MVP_STATUS.md` | — |
| 15a | Ledger anchoring | NOT_REQUESTED | Registry | External WORM/ledger provider and governance |
| 16 | Telemedicine media, device gateway, AI inference, public-health transmission | UNAVAILABLE | Registry + `departments.test.ts` refusals | Named providers, approvals and conformance runs |
| 17 | Backup, restore and disaster recovery | PASS (recorded) | Aiven PITR and encrypted backups confirmed; restore drill recorded 2026-10-28T17:35:12Z (`PRODUCTION_READINESS.md`) | Recurring drill schedule owned by operations |
| 18 | Deployment safety | PASS | Blue-green staging and production releases with retained rollback versions (`PRODUCTION_READINESS.md`) | Deployment approval workflow |
| 19 | Legal/privacy compliance (Uganda DPPA 2019) | BLOCKED | — | Requires qualified legal and clinical review; no compliance is claimed |
