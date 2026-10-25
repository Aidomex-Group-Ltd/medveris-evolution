# Medveris M0/M1 implementation status

Status date: 25 October 2026. Environment: local synthetic development only.

## Delivered

| Area | State | Evidence |
|---|---|---|
| Local PostgreSQL provisioning | Working | `npm run db:setup`, `db:migrate`, `db:seed` |
| Separate DB roles and forced RLS | Working | `tests/integration/rls.test.ts` |
| Authentication, staff MFA, patient sessions, CSRF | Working | `tests/integration/http.test.ts`, Playwright sign-in flows |
| Patient registration, assisted registration and exact-ID resolution | Working | API routes + browser flows |
| Appointments, walk-in encounters, queues and triage | Working | API + UI; seeded Kampala/Entebbe tenants |
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
| React web workspace | Working | 49-module Vite build; desktop Playwright smoke |
| Worker bundle | Builds | `apps/api/dist/worker.mjs` produced by esbuild |

## Explicitly not delivered

- Clinical validation, regulatory approval, security certification or production readiness.
- Real SNOMED CT, LOINC or UCUM content; production terminology requires licensed services.
- DICOMweb/PACS, laboratory, pharmacy, telemedicine, device ingestion, AI/radiology, payments, public health, ledger anchoring.
- FHIR writes, bulk export, SMART/OAuth client registration or cross-facility FHIR reads.
- Cloudflare deployment, Hyperdrive verification, R2/Resend production integration, hosted CI execution evidence, deployment pipelines, backups, monitoring and incident response.
- Production identity proofing, consent legal-basis configuration, retention automation and jurisdictional forms.

## Known defect fixed during verification

Signing initially returned HTTP 500 because the immutability trigger allowed the draft-to-signed transition but the runtime role lacked `UPDATE`. Migration `002_signing_privileges.sql` grants only the required table update and the end-to-end sign/amend flow now passes.

A second hardening migration (`003_access_hardening.sql`) scopes patient updates to linked facilities and permits pre-authentication denial audit records.
