# Acceptance and verification plan

The coding agent must implement tests against actual application handlers and database policies. This document is an acceptance specification, not evidence that tests have already passed. Real integrations and clinical models require separate task-specific validation.

| Test | Scenario | Expected result |
|---|---|---|
| AT01 | Register two patients; request chart using only a public ID | IDs are unique/non-sequential; anonymous requests disclose nothing |
| AT02 | Facility submits no credentials, then uploads evidence | Registration succeeds; no verified badge until an authorized evidence review |
| AT03 | A staff member supplies another tenant ID; membership later removed | Cross-tenant request denied; removed membership cannot continue access |
| AT04 | Two source facilities contribute permitted records | Authorized timeline preserves source, author, times and version lineage |
| AT05 | Facility B requests A's record before grant, after grant and after revocation | Deny, filtered allow, deny; override requires scoped reason/MFA and review task |
| AT06 | Sign, amend with reason, amend without reason, race two amendments | Original preserved; reasonless action denied; only one stale-version race succeeds |
| AT07 | Register → queue → triage → consult → sign → follow-up | Correct transitions, role filters and visible pending tasks |
| AT08 | Two admissions attempt the same bed concurrently | One succeeds; no overlapping occupancy; transfer remains atomic |
| AT09 | Theatre/maternity/critical-care workflow with missing required safety checks | Approved state gates enforced; exceptions are explicit and audited |
| AT10 | Correct a lab/radiology report and retry a medicine dispense | Prior result retained and recipients notified; no duplicate dispense |
| AT11 | Retry payment and reverse an invoice settlement | One financial effect per command; reversal history reconciles |
| AT12 | Record chronic/hospice plan and change goals | Versioned patient-specific plan with authorized review and follow-up |
| AT13 | Export public health aggregate with a small cohort | Approved suppression/review and disclosure policy applied; no accidental identity release |
| AT14 | Unauthorized participant requests video token; media connection fails | No token issued; authenticated user receives a documented fallback |
| AT15 | Replay reading, reassign device, submit wrong unit or late reading | Deduplication, correct binding, quarantine/rejection and truthful freshness states |
| AT16 | AI sees malicious document, missing data and changed source versions | No tool/access escalation; limitations visible; stale result flagged; manual review required |
| AT17 | Send unsupported imaging modality and wrong patient/study pairing | Explicit unsupported/quarantine result; no final report issued by AI |
| AT18 | Modify stored record bytes; ledger unavailable | Proof verification detects modification; primary audited care continues and anchor stays pending |
| AT19 | Audit insert fails during sign or protected read | Clinical write rolls back; protected bytes are not returned |
| AT20 | Revoke grant while export is queued, then fetch an earlier document URL | Job/delivery checks deny; no durable URL bypass |
| AT21 | Reuse pooled DB connections across tenants and roles | Transaction context cannot leak; missing context denies |
| AT22 | Restore backup to a clean isolated environment | Referential integrity, versions and audit continuity verified within declared RPO/RTO |
| AT23 | Fetch same clinical route as two users through configured caches | No shared clinical response; no-store and client-state clearing verified |
| AT24 | Reception/admin/finance user attempts clinical export and direct object retrieval | All routes enforce minimum-necessary permissions |
| AT25 | Credential expires while scheduled task is unavailable | Request-time policy and badge rendering respect actual expiry |
| AT26 | Merge suspected duplicate patients | No automatic merge; reviewed reversible identity linkage with full history |

## Test layers

Unit: state machines, permissions, clinical-value representation, grant scope, serialization and idempotency. Integration: actual PostgreSQL, RLS runtime roles, transaction atomicity, constraints, version races and pooled context. API: schema contracts, status codes, denial semantics, file access and error redaction. Browser: signup, staff context switch, reception flow, note signing/amendment, patient consent and revoked exchange. Resilience: queue replay, storage failure, audit failure, email failure, backup recovery and model/video outages.

Two-tenant fixtures must include at least two clinicians, a receptionist, a finance user, an administrator without clinical privileges, a verifier, a patient and a proxy. Use only synthetic identifiers. Test every sensitive list/search/count/download/export and worker execution path for tenant filtering. Do not substitute SQLite for PostgreSQL isolation tests.

## Release evidence

For each test record ID, requirement, implementation commit, command or manual procedure, environment, expected/actual result, evidence reference, reviewer and open defects. Define representative load profiles and measure latency, error rate, database saturation and queue lag. Test accessibility with automated checks plus keyboard and screen-reader spot checks. Clinical sign-off and penetration testing are distinct from developer unit tests.

## Standards and API acceptance scenarios

| Test | Scenario | Expected result |
|---|---|---|
| AT27 | Validate implemented FHIR projections against pinned profiles and compare `/metadata` | Validator succeeds for supported fixtures; advertised interactions match deployed behavior; FHIR errors use OperationOutcome |
| AT28 | Attempt cross-tenant FHIR search, include, history, count and paging; revoke exchange mid-session | No identity/record leakage or history bypass; current grants enforced on each request |
| AT29 | Search/select a valid clinical concept, submit inactive or fabricated code, then upgrade release | Contextual validation; invalid codes rejected/flagged per policy; historical signed coding unchanged |
| AT30 | Map local laboratory tests with differing specimen/method/unit; translate an unapproved ConceptMap | Correct reviewed LOINC mapping and UCUM validation; no automatic false equivalence |
| AT31 | Terminology upstream times out or requested content is unlicensed | Clear failure/local-draft policy; no fabricated validation or unapproved demo fallback |
| AT32 | Store/query/retrieve synthetic DICOM study, including duplicates and partial STOW failure | Per-instance results reconciled; original objects/UIDs preserved; exact supported media types tested |
| AT33 | Fetch another tenant's DICOM metadata, frames, thumbnails or bulk reference; supply arbitrary PACS URL | Access denied and audited; no SSRF or UID-only access |
| AT34 | Map device metric and units to FHIR Observation, including unknown native code | Correct LOINC/UCUM and provenance; unresolved mapping quarantined; no invented code |
| AT35 | AI proposes nonexistent terminology code or interprets incompatible units/release | Schema/value-set validation and clinical review prevent silent chart commit |
| AT36 | Replay signed adapter webhook, rotate credentials and exceed vendor quota | Deduplicated command, revoked credentials denied, bounded retries and truthful integration status |

FHIR profile validation, DICOM conformance checks and production terminology adapter tests are separate from JSON syntax checks on this kit. Record actual release, package editions, fixtures, validators, partner sandbox results and known unsupported capabilities.
