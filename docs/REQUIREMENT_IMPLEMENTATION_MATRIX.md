# Requirement implementation matrix

Status date: 25 October 2026. Local synthetic environment only. "Implemented" means the workflow exists in the API and web UI with synthetic data and automated evidence. It does not mean production integration, clinical validation or regulatory approval.

## Platform and governance

| Requirement | Status | Evidence / limit |
|---|---|---|
| Tenant isolation with forced RLS | Implemented | `tests/integration/rls.test.ts` |
| Authentication, MFA, sessions, CSRF | Implemented | `tests/integration/http.test.ts`, Playwright sign-in |
| Patient registration, resolution, portal | Implemented | API + patient portal Playwright flow |
| Append-only hash-chained audit and outbox | Implemented | audit writes on command paths; `smoke:workers` |
| Signed integrity checkpoints | Implemented locally | no external ledger/WORM anchoring |
| Consent-scoped cross-facility exchange | Implemented | SECURITY DEFINER projection + audited read |
| Emergency override with review task | Implemented | API + reviewer surface |
| Credentialing and independent review | Implemented | API + reviewer console |
| Facility administration and memberships | Implemented | admin console |
| FHIR R4 read facade | Partial | read-only documented subset; no external validator run |
| Terminology facade | Synthetic only | licensed SNOMED CT/LOINC required for production |
| Deployment, monitoring, backups, CI evidence | Not implemented | see `IMPLEMENTATION_GAPS.md` |

## Clinical and departmental operations

| Requirement | Status | Evidence / limit |
|---|---|---|
| Appointments, walk-in encounters, queues, triage | Implemented | API + UI |
| Signed notes, amendments, entered-in-error | Implemented | domain tests + `smoke:clinical` |
| Inpatient admissions, beds, transfers, discharge | Implemented | `tests/integration/departments.test.ts` |
| Nursing assessments, tasks and handoffs | Implemented | same integration suite + admission UI |
| Theatre preop, consent, checklists, anesthesia, recovery, counts, specimens | Implemented | integration checkpoint flow + Playwright theatre case |
| Diagnostics orders, specimens, results, correction, critical communication | Implemented with synthetic catalogue | external analyser/PACS integration absent |
| Imaging study/report records | Implemented as records | no DICOMweb/PACS connection |
| Pharmacy prescriptions, review, dispensing, administration, stock | Implemented with synthetic stock | no e-prescribing/wholesaler integration |
| Invoicing, payments, reversals, claims, summary | Implemented with synthetic ledger | no payment gateway or insurer clearing |
| Care programmes, enrolments, care plans, events, advance care | Implemented | API + programmes UI |
| Aggregate public-health reporting and release | Implemented with synthetic aggregates | small-cell suppression applied; no regulator transport |
| Telehealth session metadata, consent, completion | Partial | no media transport; join disabled |
| Device registry, assignment, ingestion, alerts | Partial | synthetic ingestion only; no vendor gateway |
| Assistive AI job history | Placeholder | read-only; no model inference |
| DICOMweb, laboratory interfaces, e-prescribing, telemedicine media, device gateways, AI inference, payment rails, regulator submission, ledger anchoring | Not implemented | feature flags default off; pages state the limitation |

## Verification commands

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
```

Expected current results: typecheck/lint clean, 40 unit/integration tests pass, 9 Playwright tests pass, web/API/worker bundles build.
