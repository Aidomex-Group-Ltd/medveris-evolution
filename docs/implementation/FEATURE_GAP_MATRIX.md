# Feature gap matrix

Labels follow the master prompt: PASS, PARTIAL, BLOCKED, UNAVAILABLE, NOT_TESTED, FAILED, NOT_REQUESTED. "Evidence" names tests that actually ran on 2026-10-28 (see `IMPLEMENTATION_LOG.md`). Prior module evidence is in `docs/MVP_STATUS.md`. Nothing here has been verified with real patients, real clinicians or production infrastructure.

| # | Requirement area | Status | Evidence | Remaining work |
|---|---|---|---|---|
| 1 | Patient identity: durable public ID, demographics, assisted registration | PASS (synthetic) | `patients.test.ts`, `patient-lookup.spec.ts` | Production identity-proofing policy |
| 1a | Duplicate detection and review | PARTIAL | `patients.test.ts` (facility-scoped candidates, audited no-merge review) | Authorized merge workflow with reversible audit history is not implemented |
| 1b | Exact lookup and facility search | PASS (synthetic) | `patients.test.ts` lookup suite, `patient-lookup.spec.ts` | — |
| 1c | Contacts, next of kin, emergency contacts | NOT_TESTED | Not audited in this pass | Audit schema and UI |
| 2 | Reception: walk-in, appointments, queues, triage | PARTIAL | `MVP_STATUS.md`; smoke e2e | Visit numbering, labels/slips, waiting-time and no-show reports not verified |
| 2a | Duplicate encounter on repeated submission | NOT_TESTED | — | Add idempotency key test for `POST /encounters` |
| 3 | Consultation/EMR: signed notes, amendments, versions | PASS (synthetic) | `domain.test.ts`, `clinical-smoke.mjs` (not run in this pass) | Clinician workload and outcome reports |
| 4 | Pharmacy (internal): prescriptions, review, dispense, stock, FEFO | PARTIAL | `departments.test.ts` pharmacy flow, `inventory.test.ts` | Interaction checks need verified clinical data; controlled-medicine reconciliation not verified |
| 4a | Pharmacy external adapter | UNAVAILABLE | registry tests | See `INTEGRATION_AVAILABILITY.md` |
| 5 | Laboratory (internal): orders, specimens, verification, correction, critical result | PARTIAL | `departments.test.ts` diagnostics flow | Reference intervals by demographic/method, QC records, turnaround reports |
| 5a | LIS/analyzer adapter | UNAVAILABLE | registry tests | — |
| 6 | Radiology: orders, studies, free-text reports, corrections, release | PARTIAL | `departments.test.ts` | **Structured, versioned templates, draft autosave, separate radiologist sign-off, addenda UI, turnaround tracking are not implemented.** Highest-priority next item |
| 6a | PACS/DICOMweb | UNAVAILABLE | `departments.test.ts` asserts PACS claims are refused | — |
| 7 | Maternity and newborn | PARTIAL | `hospital.test.ts` | Forms and escalation rules need maternity-staff approval; reports not verified |
| 8 | Wards: admissions, beds, nursing, handoff, discharge | PARTIAL | `departments.test.ts` | Concurrent bed allocation not tested; occupancy/LOS reports not verified |
| 9 | Cross-department journeys A–G | PARTIAL | API-level flows in `departments.test.ts`; no single end-to-end browser journey per letter | Browser journeys per §14 |
| 10 | Finance: invoices, manual payments, reversals, claims | PARTIAL | `departments.test.ts` finance flow | Reconciliation reports |
| 10a | Payment provider | UNAVAILABLE | registry tests | — |
| 11 | Reports framework (filters, pagination, export, KPIs) | PARTIAL | inventory CSV export audit; public-health aggregates | No shared reporting service; facility report list in §15 not implemented |
| 12 | Roles and authorization | PARTIAL | `authz.test.ts`, `rls.test.ts`, department boundary test | Roles listed in §16 (lab validator, radiographer, radiologist, ward manager, privacy officer, system administrator) are not separate roles |
| 13 | Staff MFA enrolment | PASS (synthetic) | `mfa-setup.spec.ts` | — |
| 14 | Integration availability registry | PASS | `integration-registry.test.ts`, `departments.test.ts` | Persisted verification runs when the first adapter is built |
| 15 | Audit events and checkpoints | PASS (local) | audit writes in command paths; `MVP_STATUS.md` | — |
| 15a | Ledger anchoring | NOT_REQUESTED | registry | — |
| 16 | Telemedicine, devices, AI, public-health submission | UNAVAILABLE | registry + `departments.test.ts` refusals | — |
| 17 | Backup, restore and disaster recovery | BLOCKED | No restore drill performed | Needs Aiven backup/PITR confirmation and a recorded restore drill |
| 18 | Deployment safety (staging) | PASS | blue-green release with rollback drill, 2026-10-28 | Production environment does not exist |
| 19 | Legal/privacy compliance (Uganda DPPA 2019) | BLOCKED | — | Requires qualified legal and clinical review; no compliance is claimed |
