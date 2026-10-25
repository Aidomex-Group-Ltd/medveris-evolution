# Medveris M0/M1 and departmental operations status

Status date: 25 October 2026. Environment: local synthetic development only.

## Delivered

| Area | State | Evidence |
|---|---|---|
| Local PostgreSQL provisioning | Working | `npm run db:setup`, `db:migrate`, `db:seed` |
| Separate DB roles and forced RLS | Working | `tests/integration/rls.test.ts` |
| Authentication, staff MFA, patient sessions, CSRF | Working | `tests/integration/http.test.ts`, Playwright sign-in flows |
| Patient registration, assisted registration, exact-ID resolution and facility-scoped duplicate review | Working | API routes + browser flows; `tests/integration/patients.test.ts`; no automatic merge |
| Appointments, walk-in encounters, queues and triage | Working | API + UI; seeded Kampala/Entebbe tenants |
| Follow-up worklist and referral tracking | Working, local only | API + UI; versioned status changes; no external referral transmission |
| Emergency temporary identity, triage, serial observations, handoff and disposition | Working | `tests/integration/emergency.test.ts`; emergency board + case UI; Playwright emergency journey |
| Signed clinical notes, amendments, entered-in-error and versions | Working | `scripts/clinical-smoke.mjs`, `tests/unit/domain.test.ts` |
| Append-only hash-chained audit + transactional outbox | Working | audit writes in every command path; `scripts/workers-smoke.mjs` |
| Outbox worker with deduplication, retry and dead-lettering | Working | `apps/jobs`, `smoke:workers` |
| Signed Merkle integrity checkpoints | Working | `integrity_checkpoints`; batch 1 recorded |
| Patient portal records, consent and access history | Working | Playwright patient flow + seeded release |
| Consent-scoped cross-facility exchange projection | Working | SECURITY DEFINER grant validation and audited read |
| Emergency override with review task | Working | API routes; synthetic clinical role |
| Credential submission and independent review | Working | API + reviewer console |
| Facility administration, memberships, queue management | Working | API + admin console |
| FHIR R4 read facade | Working subset | metadata, Patient, Encounter, Observation, Condition, AllergyIntolerance, DocumentReference, Provenance, Consent, AuditEvent |
| Terminology facade | Working synthetic only | ValueSet expand/validate, CodeSystem lookup/validate |
| Inpatient wards, beds, nursing care, handoffs and discharge | Working, synthetic | `tests/integration/departments.test.ts`; Wards/admission UI |
| Theatre checkpoints: preop, consent, sign-in/time-out/sign-out, anesthesia, recovery, counts, specimens | Working, synthetic | integration checkpoint flow + Playwright theatre case |
| Diagnostics orders, specimens, results, correction, critical communication, imaging reports | Working, synthetic only | integration diagnostics flow; external modalities are not connected |
| Pharmacy prescriptions, stock, dispensing, administration | Working, synthetic only | integration pharmacy flow; no external e-prescribing or wholesaler |
| Invoicing, payments, reversals, claims and finance summary | Working, synthetic only | integration finance flow; no payment rail |
| Care programmes, enrolments, care plans, events, advance care | Working, synthetic | API + programmes UI |
| Aggregate public-health reporting with small-cell suppression and release | Working, synthetic | API + public-health UI |
| Telehealth sessions, consent and completion | Working, metadata only | no media transport; join is disabled |
| Device registry, assignment, observation ingestion and alerts | Working, synthetic | no vendor gateway or real device data |
| Assistive AI job history and clinician review surface | Read-only placeholder | jobs run synthetically; no model inference |
| React web workspace | Working | Vite build; emergency workspace; stacked/collapsible sidebar, left-side mobile navigation drawer with keyboard focus management, desktop and mobile Playwright flows |
| Worker bundle | Builds | `apps/api/dist/worker.mjs` produced by esbuild |

## Explicitly not delivered

- Clinical validation, regulatory approval, security certification or production readiness.
- Real SNOMED CT, LOINC or UCUM content; production terminology requires licensed services.
- External integration transports: DICOMweb/PACS, laboratory analysers, e-prescribing/wholesalers, telemedicine media, device gateways, model inference, payment rails, regulator submission and ledger/WORM anchoring. Departmental workflows run on synthetic data with feature flags off by default; disabled pages state this explicitly.
- FHIR writes, bulk export, SMART/OAuth client registration or cross-facility FHIR reads.
- Cloudflare deployment, Hyperdrive verification, R2/Resend production integration, hosted CI execution evidence, deployment pipelines, backups, monitoring and incident response.
- Production identity proofing, consent legal-basis configuration, retention automation and jurisdictional forms.

## Known defect fixed during verification

Signing initially returned HTTP 500 because the immutability trigger allowed the draft-to-signed transition but the runtime role lacked `UPDATE`. Migration `002_signing_privileges.sql` grants only the required table update and the end-to-end sign/amend flow now passes.

A second hardening migration (`003_access_hardening.sql`) scopes patient updates to linked facilities and permits pre-authentication denial audit records.
