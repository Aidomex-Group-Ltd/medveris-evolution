# Requirement implementation matrix

Status date: 25 October 2026. Local synthetic environment only.

Status definitions:
- **Verified** — application behaviour exists and the referenced automated check has passed.
- **Implemented** — the API, database and UI path exist, but the listed gap or external validation remains.
- **Partial** — only a bounded slice is implemented; the remaining work is named.
- **Externally blocked** — the adapter boundary or workflow exists, but a named credential, licence, device, content right or clinical approval is unavailable.
- **Missing** — no real application behaviour exists yet.

"No clinical deployment approval" applies to every row. A route or navigation item alone is never treated as implementation.

## Foundation, identity and security

| ID | Requirement | Source | Role / outcome | Evidence and dependencies | Status |
|---|---|---|---|---|---|
| FND-01 | Verified tenant context and forced PostgreSQL RLS | 02, 04, 08, 17 | Staff and patients only reach the active tenant or own record | Runtime-role isolation, direct cross-tenant reads, inserts and pooled-context reset in `tests/integration/rls.test.ts` | Verified |
| FND-02 | Authentication, staff MFA, patient sessions, CSRF, session revocation | 02, 08 | All users authenticate without account enumeration | `tests/integration/http.test.ts`; browser sign-in in `tests/e2e/smoke.spec.ts` | Verified |
| FND-03 | Resource-level role authorization and mismatched-tenant denial | 02, 08 | Administration, reception, finance and laboratory cannot read clinical narratives | Unit role boundaries, HTTP denial tests, departmental role boundary test | Verified |
| FND-04 | Append-only hash-chained audit and transactional outbox | 09, 17 | Governance can attribute every command and protected read | Audit writes on command paths; `scripts/workers-smoke.mjs` verifies deduplication and checkpoint | Verified |
| FND-05 | Signed integrity checkpoints and truthful ledger state | 09, 17 | Integrity evidence is available without claiming blockchain confirmation | Local HMAC-signed Merkle checkpoint; ledger state remains `not-requested` | Implemented; external WORM/ledger anchoring blocked by provider choice |
| FND-06 | Consent-scoped cross-facility exchange and revocation | 02, 05, 08 | Patients control which categories another facility receives | `app.exchange_project` projection, grant checks, audited read; native API path | Implemented; no external partner conformance test |
| FND-07 | Controlled emergency access with MFA and review task | 02, 08 | Clinicians can break glass only with reason and review | `apps/api/src/routes/consent.ts`; review surface; synthetic emergency access evidence | Implemented |
| FND-08 | Protected-read audit before returning clinical content | 08, 17 | Identifiable reads are attributable | Encounter/emergency/telehealth/exchange reads write audit inside the transaction | Implemented; no exhaustive route-level audit assertion |
| FND-09 | Optimistic concurrency, atomic clinical write/audit/outbox | 04, 06, 17 | Concurrent amendment and disposition races do not overwrite silently | Domain tests, stale amendment path, emergency stale-disposition test | Verified for covered commands |
| FND-10 | Private uploads, quarantine and local/production adapters | 08, 16 | Credential evidence is not publicly addressable | Local storage adapter and quarantine metadata; production object store not configured | Partial; R2/provider blocked |
| FND-11 | Local setup, migrations, seeds, synthetic reset and CI script | 14, 16 | Developers can reproduce the local system | `docs/LOCAL_DEVELOPMENT.md`, migrations 001–005, seed and reset scripts, committed CI workflow | Verified locally; hosted CI not executed |
| FND-12 | Production monitoring, backups, restore, alerting and incident response | 16 | Operations can recover and observe the service | No backup/restore drill, metrics, paging or on-call runbook executed | Missing / externally blocked by operations ownership |

## Patient and provider experience

| ID | Requirement | Source | Role / outcome | Evidence and dependencies | Status |
|---|---|---|---|---|---|
| PAT-01 | Self-registration and unique Medveris ID | 01, 06 | Patients create an account and receive a non-sequential public ID | Registration APIs; domain public-ID tests; patient portal Playwright flow | Verified |
| PAT-02 | Assisted registration and temporary/emergency identity | 06, 07 | Reception and emergency staff register patients without a device | Assisted registration UI/API; temporary emergency identity in `tests/integration/emergency.test.ts` | Verified |
| PAT-03 | Exact-ID resolution and identity confirmation | 02, 06 | Staff cannot open a chart from a public ID alone | Exact ID + family name + DOB resolution; lookup audited | Verified |
| PAT-04 | Duplicate review without automatic merge | 02, 06, 15 (AT26) | Administrators review reversible linkage | Duplicate candidates and review console; no automatic merge | Implemented; merge workflow remains review-only by design |
| PAT-05 | Patient profile and permitted medical history | 05, 06, 07 | Patients see released records from linked facilities | Patient portal records, observations, conditions, allergies, appointments | Verified for signed/released records |
| PAT-06 | Appointments, follow-ups and referrals | 05, 06 | Reception schedules; clinicians record follow-up and referral | Appointment API/UI; follow-up and referral commands on encounters | Implemented; referral is a local record, not an external transmission |
| PAT-07 | Consent and record-access management | 02, 07 | Patients grant, inspect and revoke scoped access | Consent API and patient portal consent screen | Implemented |
| PAT-08 | Patient-readable disclosure/access history | 07, 09 | Patients see who accessed their record | `/me/access` and patient access-history page | Implemented |
| PAT-09 | Proxy/guardian access | 02, 06, 07 | Authorized carers can act for a patient | No patient relationship/proxy model or delegated session exists | Missing; requires policy and identity-proofing decision |
| PAT-10 | Facility registration and configuration | 01, 05 | Facilities register and administer their own scope | Facility registration, tenant settings, administration console | Verified for local synthetic facilities |
| PAT-11 | Memberships, role management and scheduling scope | 02, 05 | Administrators invite members with least privilege | Membership APIs and admin UI; tenant context switching | Implemented |
| PAT-12 | Credential submission, independent verification, expiry and review | 10 | Practitioners submit evidence; an independent reviewer decides | Quarantine upload, credential decisions, expiry-aware badge | Implemented; authoritative licensing-authority lookup blocked |
| PAT-13 | Separate account, credential, privilege and facility-capability states | 10 | A verified badge does not imply clinical privilege | Data model and reviewer UI separate these states | Implemented |

## Reception, outpatient and emergency

| ID | Requirement | Source | Role / outcome | Evidence and dependencies | Status |
|---|---|---|---|---|---|
| REC-01 | Appointments, walk-in registration and queue routing | 06, 07 | Reception moves a patient from arrival to the right queue | Reception APIs, queue board, encounter creation | Verified |
| REC-02 | Triage and observations before clinical documentation | 06, 15 (AT07) | Nurses record complaint, urgency, allergy state and validated observations | `TriagePanel`, `tests/integration/emergency.test.ts`, seeded flows | Verified |
| REC-03 | Clinical encounter, conditions, allergies, assessment and plan | 06 | Clinicians document a complete encounter | Encounter chart, clinical note panel, coded condition/allergy commands | Implemented |
| REC-04 | Signed notes, reasoned amendments, entered-in-error and versions | 06, 09, 15 (AT06) | Authors can correct without destroying history | Domain tests; `scripts/clinical-smoke.mjs`; immutable versions | Verified |
| REC-05 | Orders, follow-up, referral and pending-task visibility | 06, 07 | Clinicians see unfinished work before closing an encounter | Worklist counts, order/follow-up/referral commands, completion gate | Implemented |
| REC-06 | Emergency temporary/unidentified registration | 06, 07 | Emergency staff document before identity is confirmed | `emergency_cases` + temporary patient creation; emergency integration test | Verified |
| REC-07 | Emergency triage, serial observations and urgent orders | 06 | Care continues while the patient is unstable | Emergency board uses triage, observation and existing order workflows | Verified for triage/observations; urgent order reuse is API-level |
| REC-08 | Emergency team handoff | 06, 07 | Receiving clinician is named with a summary | `emergency_handoffs`; emergency integration test | Verified |
| REC-09 | Emergency disposition, transfer/admission and review | 06, 07 | Closure requires a disposition note; admission requires a real admission | Disposition gate, stale-version conflict, admission precondition; emergency tests | Verified |
| REC-10 | Billing not required for emergency documentation | 06 | Emergency care is never blocked by finance state | No billing dependency in emergency routes; emergency test uses no invoice | Verified |

## Inpatient and specialist wards

| ID | Requirement | Source | Role / outcome | Evidence and dependencies | Status |
|---|---|---|---|---|---|
| WARD-01 | Admission requests and admission records | 06 | Clinicians admit from an active encounter | `apps/api/src/routes/inpatient.ts`; admission UI; integration test | Verified |
| WARD-02 | Configurable general, adult, paediatric, surgical, maternity, NICU and ICU wards | 06 | Administrators configure appropriate units | Ward type constraint and configuration UI | Verified for configuration; specialty clinical templates remain generic |
| WARD-03 | Bed configuration, availability and atomic assignment/transfer | 06, 15 (AT08) | Only one active occupant per bed | Partial unique indexes, row locks, bed board; integration test | Verified |
| WARD-04 | Nursing assessments, observation charts, tasks and handoffs | 06 | Nurses document care and hand over tasks | Assessment/task/handoff APIs; admission detail UI; integration test | Verified for structured notes, not device-grade charts |
| WARD-05 | Discharge, transfer-out and death documentation | 06 | Clinicians close an admission with a disposition | Admission transition API/UI with summary/reason | Implemented |
| WARD-06 | Mother/newborn identity and controlled linkage | 06 | Maternity records separate identities | No dedicated mother/newborn linkage exists | Missing; requires clinical and identity design |
| WARD-07 | Pending orders/results visibility on the ward | 06, 07 | Ward staff see outstanding work | Admission detail exposes tasks; department worklists | Partial |

## Theatre, anaesthesia and recovery

| ID | Requirement | Source | Role / outcome | Evidence and dependencies | Status |
|---|---|---|---|---|---|
| THR-01 | Procedure request, scheduling and theatre allocation | 06 | Clinicians schedule a case and allocate a theatre/team | Theatre case API/UI; Playwright theatre flow | Verified |
| THR-02 | Preoperative assessment and procedure consent | 06, 15 (AT09) | Safety gates prevent unprepared progression | Preop and consent commands; checkpoint transition test | Verified |
| THR-03 | Patient/site/laterality confirmation | 06 | Wrong-site risk is surfaced before time-out | Laterality/site fields and checklist; integration flow | Verified for structured capture, not a validated checklist standard |
| THR-04 | Configurable safety checklist stages | 06 | Sign-in, time-out and sign-out are recorded separately | Checklist API with unique stage; tests cover all three | Verified |
| THR-05 | Anaesthesia and intraoperative documentation | 06 | Clinicians record anaesthesia and counts | Anaesthesia record, counts, specimens; integration test | Verified |
| THR-06 | Recovery observations and postoperative handoff | 06 | Recovery is documented before completion | Recovery API; transition gate; integration test | Verified |
| THR-07 | Documented emergency exceptions | 06 | Missing consent can be overridden only with a reason | Versioned transition with `emergencyExceptionReason` and audit | Verified |
| THR-08 | Specimens/implants/counts where specified | 06 | Traceability of theatre items | Specimens and counts; implant registry not implemented | Partial |

## Diagnostics and pharmacy

| ID | Requirement | Source | Role / outcome | Evidence and dependencies | Status |
|---|---|---|---|---|---|
| DIA-01 | Test catalogue with reviewed local-to-LOINC mapping | 13, 19 | Laboratory selects a validated test | `lab_tests` with mapping metadata; catalogue UI; integration test | Implemented with synthetic catalogue |
| DIA-02 | Orders, specimen collection, accession and rejection/recollection | 06 | Laboratory receives and accepts/rejects specimens | Order/specimen APIs and order-detail UI | Verified |
| DIA-03 | Preliminary/final results, correction history and critical communication | 06, 15 (AT10) | Corrected results preserve history and notify recipients | Result versions, correction reason, critical communication; integration test | Verified |
| DIA-04 | Radiology order, booking and accession | 06 | Imaging workflow is recorded | Imaging study/report tables and diagnostics UI | Implemented |
| DIA-05 | PACS DICOMweb integration and diagnostic viewer | 11, 13, 19, 20 | Authorized QIDO/WADO/STOW and viewer | No DICOMweb adapter or PACS configuration; no viewer | Externally blocked by PACS/VNA and conformance testing |
| DIA-06 | Preliminary/final imaging reports, amendments and critical acknowledgement | 06, 11 | Radiologists sign and correct reports | Report version tables and APIs; no PACS link | Implemented as records |
| PHA-01 | Governed medicine catalogue and authorised review | 06, 12 | Pharmacists review medication orders | Medicine catalogue, review queue, integration test | Implemented with synthetic catalogue |
| PHA-02 | Dispensing, administration, reconciliation and stock lots/movements | 06, 15 (AT10) | Retry-safe dispensing and truthful stock | Stock lots/movements/dispenses, row locks, integration test | Verified |
| PHA-03 | Drug interaction/dose decision support | 06, 11 | Only approved knowledge sources may advise | No approved medicine knowledge source configured | Externally blocked; feature must remain unavailable |
| PHA-04 | External e-prescribing/wholesaler integration | 20 | Orders flow to external pharmacy | Adapter boundary not configured | Externally blocked |

## Continuing, community and public health

| ID | Requirement | Source | Role / outcome | Evidence and dependencies | Status |
|---|---|---|---|---|---|
| CARE-01 | Programme configuration and enrolment | 06 | Clinicians run chronic/primary/preventive programmes | Programme APIs and UI; integration test | Verified |
| CARE-02 | Immunization, screening, community referral and home-visit events | 06 | Community activity is documented | Programme events with governed types; UI | Implemented |
| CARE-03 | Longitudinal goals, care plans and versioned review | 06, 15 (AT12) | Goals change without losing history | Care plans + immutable versions; integration test | Verified |
| CARE-04 | Hospice/palliative symptom tracking and advance-care documents | 06 | Authorized goals and preferences are recorded | Programme events and advance-care documents | Implemented |
| PUB-01 | Programme configuration, cohorts and case-definition versions | 06 | Public-health staff define aggregate reports | Report definitions, versions, aggregate JSON | Implemented |
| PUB-02 | Small-cohort suppression and disclosure review | 06, 15 (AT13) | Aggregate output cannot expose a small group | Minimum-cell suppression, review/release states; integration test | Verified |
| PUB-03 | Identifiable reporting, export/transmission and acknowledgement/correction | 06, 20 | Regulator exchange is authorised and traceable | No regulator adapter or transmission acknowledgement | Externally blocked |

## Administration, finance and operations

| ID | Requirement | Source | Role / outcome | Evidence and dependencies | Status |
|---|---|---|---|---|---|
| ADM-01 | Facilities, departments/locations and staff memberships | 01, 05 | Administrators configure operational scope | Tenant, membership and admin console; location model is minimal | Partial |
| ADM-02 | Service catalogue and decimal pricing with explicit currency | 06, 17 | Finance bills accurate amounts | `service_catalog` numeric price + ISO currency; finance test | Verified |
| ADM-03 | Invoices, payments, reversals and reconciliation | 06, 15 (AT11) | One financial effect per command | Invoice/payment/reversal APIs; integration test | Verified for manual records; no payment rail |
| ADM-04 | Insurance/claims workflow | 06 | Claims are prepared and tracked | Claims table/API/UI | Implemented as local records; no clearing-house integration |
| ADM-05 | Procurement and inventory | 06 | Stock and purchasing are managed | Pharmacy stock only; general procurement missing | Partial |
| ADM-06 | Operational reports from stored data | 06, 07 | Managers see real local data | Finance summary and public-health aggregate; no broad BI layer | Partial |
| ADM-07 | Manual payment is not external settlement | 06, 17 | Staff do not mistake a recorded payment for cleared funds | Payment records are local/manual; claim states remain local | Implemented |

## Telemedicine, devices and bounded AI

| ID | Requirement | Source | Role / outcome | Evidence and dependencies | Status |
|---|---|---|---|---|---|
| TEL-01 | Telehealth scheduling, participants, consent and completion | 12 | Clinicians record a remote consultation | Telehealth API/UI; integration consent/completion flow | Verified as metadata-only |
| TEL-02 | Short-lived participant tokens and configurable media adapter | 12, 20 | Authorized participants join a real call | No media provider configured; join returns dependency error | Externally blocked by video provider |
| TEL-03 | Connection-failure fallback and recording off by default | 12 | Failed calls do not become false completed encounters | Failed completion path; no recording feature exists | Implemented |
| DEV-01 | Device registry, capabilities and assignment intervals | 12 | Staff bind a device to a patient/encounter | Device APIs/tables/UI; synthetic integration test | Implemented |
| DEV-02 | Authenticated ingestion, deduplication, out-of-order and quality states | 12, 15 (AT15) | Stale/duplicate readings are not treated as current | Ingestion route behind flag; unique event index; quality alerts; test | Implemented behind disabled default; no vendor gateway |
| DEV-03 | LOINC/UCUM mapping and approved alert rules | 12, 19 | Observations retain provenance without invented codes | Reviewed capability mapping; no approved clinical thresholds | Partial; clinical alert rules externally blocked |
| DEV-04 | Invoice/alert escalation/resolution workflow | 12 | Alerts reach and are acknowledged by staff | Acknowledgement/resolution; escalation routing missing | Partial |
| AI-01 | Job registry with task eligibility, evidence pointers and provenance | 11, 15 (AT16) | Clinicians can see what evidence a job used | `ai_jobs` table and list/detail API; no provider | Partial |
| AI-02 | Structured output validation, stale-input detection and clinician accept/edit/reject | 11 | No model output silently enters the chart | No output/review lifecycle implemented | Missing; requires provider and validation contract |
| AI-03 | Feature-level kill switches and disabled clinical image/prediction use | 11 | Unsafe tasks remain unavailable | `FEATURE_AI=false`; disabled state stated in UI | Verified default-off behaviour |
| AI-04 | Real inference service | 11, 20 | Only approved configured inference may run | No model provider or intended-use approval | Externally blocked |

## Standards and interoperability

| ID | Requirement | Source | Role / outcome | Evidence and dependencies | Status |
|---|---|---|---|---|---|
| STD-01 | FHIR R4 4.0.1 baseline and truthful CapabilityStatement | 13, 19, 20 | Partners discover only implemented interactions | `/fhir/r4/metadata`; write blocking; HTTP tests | Verified for advertised subset |
| STD-02 | Authorized Patient/Organization/Practitioner/PractitionerRole/Encounter/Observation/Condition/Allergy/DocumentReference/Consent/Provenance/AuditEvent projections | 13, 19 | Partners read source-owned FHIR resources | Read facade, RLS and tenant scoping; HTTP tests cover Patient only | Implemented; external validator not run |
| STD-03 | FHIR appointment/specimen/diagnostic/imaging/medication resources | 13, 19 | Departmental data is exchanged | Not mapped on the FHIR facade | Missing |
| STD-04 | FHIR history, includes, paging and OperationOutcome | 13, 19 | Explicit supported semantics | Searchset Bundle, paging, OperationOutcome; includes/history rejected | Implemented |
| STD-05 | Terminology lookup, expansion, validation and translation with pinned releases | 19, 20 | Clinical coding is validated, not invented | Synthetic adapter and production HTTP adapter; `/terminology/fhir/r4` subset | Implemented with synthetic data; production licensing externally blocked |
| STD-06 | Contextual SNOMED CT/LOINC/UCUM search and historical coding preservation | 07, 19 | Clinicians select governed concepts | `CodingPicker`, field value sets, stored version/display | Implemented with synthetic content |
| STD-07 | ConceptMap translation with reviewed equivalence | 19, 20 | Local lab tests map to LOINC only when approved | Synthetic reviewed map; unapproved maps rejected | Implemented |
| STD-08 | DICOM QIDO-RS, WADO-RS, STOW-RS and patient/study reconciliation | 13, 19, 20 | Imaging studies are discoverable and retrievable | No DICOMweb route, PACS, original-object store or viewer | Externally blocked |
| STD-09 | FHIR bulk export, SMART/OAuth client registration and external writes | 13, 19 | Partner exchange is governed | Explicitly disabled in config and CapabilityStatement | Externally blocked by governance and partner onboarding |
| STD-10 | Public-health ConceptMap/reporting transport | 19, 20 | Aggregate reporting reaches an authority | Aggregate report exists; no transport | Externally blocked by authority agreement |

## Verification summary

Executed after the emergency increment:

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm test` — unit, PostgreSQL isolation, HTTP and departmental suites, including 3 new emergency tests.
- `npm run test:e2e` — browser journeys, including the emergency registration/triage journey.
- `npm run build` — web, API server and worker bundles.
- `npm run smoke:clinical`, `npm run smoke:workers` — see `docs/TEST_EVIDENCE.md`.

The externally blocked items above are not counted as clinically complete. Production prerequisites remain: clinical safety ownership, privacy/legal review, licensed terminology, PACS/laboratory/video/device/payment/AI contracts, Cloudflare/Hyperdrive/R2 verification, backups, monitoring, penetration testing and jurisdiction-specific forms.
