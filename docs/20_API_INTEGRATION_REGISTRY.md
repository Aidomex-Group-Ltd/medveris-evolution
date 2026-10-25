# API integration registry and service contracts

This registry distinguishes native Medveris operations from standard services and external provider adapters. Base URLs are environment configuration, not hard-coded vendor production endpoints. A listed capability remains unavailable until implemented, contracted where applicable, configured and tested. No credential or production integration is included in this kit.

## Platform API families

| API family | Base or operation | Required behavior and stage |
|---|---|---|
| Native operations | `/api/v1` | Existing tenant, encounters, consent, amendments, finance and administration; M1 onward |
| FHIR clinical exchange | `/fhir/r4/metadata`, `/fhir/r4/{resourceType}` | R4 4.0.1 CapabilityStatement, permitted read/search and versioned profiles; M1 onward |
| FHIR terminology | `/terminology/fhir/r4` | Entitlement-controlled terminology facade; M1 |
| PACS DICOMweb | `/dicomweb` logical proxy or approved PACS base | Authorized QIDO-RS, WADO-RS, STOW-RS; M2 |
| Partner ingestion | `/api/v1/integrations/{adapter}/...` | Signed, idempotent, reconciled external payloads; by module stage |
| Device ingestion | `/api/v1/integrations/devices/observations` | Device/patient binding, quality, LOINC/UCUM mapping; M4 |
| AI inference jobs | `/api/v1/ai/jobs` | Authorized evidence pointers, task eligibility and clinician review; M5 |

## Terminology operation contract

Use POST FHIR Parameters where supported to avoid putting sensitive user-entered fragments in URLs. Read operations can use GET when appropriate, with URL/log hygiene. Canonical operations include `CodeSystem/$lookup`, `CodeSystem/$validate-code`, `ValueSet/$expand`, `ValueSet/$validate-code` and `ConceptMap/$translate`. Parameters and return types follow R4; errors use OperationOutcome. `$lookup` and `$validate-code` return Parameters, `$expand` returns ValueSet, and `$translate` returns Parameters with mapping matches. Do not wrap these as the native Medveris JSON envelope.

Specify system/version, code/display, canonical value-set URL/version or ConceptMap URL/version as applicable. Expansion supports a bounded filter, count, offset and active-only behavior where implemented; pin version and language context for repeatable results. Reject unsupported systems, unlicensed editions and unapproved maps. Never send entire notes, patient names or diagnosis narratives to a public terminology endpoint. Simple code lookups and approved non-identifying search text are the intended upstream payload.

## DICOMweb contract

Typical route shapes under the chosen DICOMweb base are GET `/studies`, `/studies/{studyUID}/series`, `/studies/{studyUID}/series/{seriesUID}/instances` for queries; GET `/studies/{studyUID}` and selected series/instance/frame/metadata routes for retrieval; and POST `/studies` for storage. Use the exact standard resource semantics and negotiated MIME types supported by the PACS. Metadata responses can use `application/dicom+json`; object transfer commonly uses the specified multipart DICOM representations. Do not treat these as generic JSON CRUD or assume rendered JPEG is diagnostically equivalent.

Handle STOW partial acceptance per instance, duplicate SOP instances and transport retries without duplicating work. Route signed asynchronous completion events to the platform for indexing and identity review. A store acknowledgement does not automatically attest to storage commitment, long-term preservation or successful patient reconciliation. Resolve patient binding before releasing studies to a chart or AI job.

## External service adapters

| Adapter | Function | Required safeguards |
|---|---|---|
| Identity/OIDC | Signup, login, MFA, recovery | Validated issuer/audience, scopes, revocation and recovery |
| Production terminology | SNOMED CT/LOINC lookup and validation | Licensed editions, pinned releases, no patient payloads, capability tests |
| PACS and laboratory | Imaging and diagnostic orders/results | Identity reconciliation, structured codes, source provenance and correction notifications |
| Provider licensing authority | Optional supported credential verification | Authoritative source, clear manual fallback and actual checked scope |
| Email/SMS/push | Invitations, appointments and generic alerts | Consent/preferences, generic text, signed callbacks and delivery truthfulness |
| Video/WebRTC | Teleconsultation media | Participant authorization, regional review, consent and recording policy |
| Payment/insurance | Settlement, claims and eligibility | Hosted payment data, minimal clinical fields, webhook verification and reconciliation |
| Public health | Approved surveillance/reporting | Authority, versioned dataset, suppression and disclosure audit |
| Device/vendor gateway | Observations and quality | Per-device source, binding, sequences, revocation and retry safety |
| AI/model provider | Bounded summaries, predictions or image tasks | Intended-use validation, scoped data, retention terms and kill switches |
| Ledger | Batch commitment anchoring | No patient payload, documented network/finality and idempotent submission |

## Common adapter requirements

Each adapter owns a versioned configuration, vendor/service owner, processing country, approved data classes, contractual status, credential reference, timeout, retry/backoff, circuit breaker, quotas, webhook signature/replay checks and fallback. Distinguish retryable failures from permanent validation errors. Use scoped service credentials rotated independently of staff accounts. Validate destination allowlists to prevent SSRF and data exfiltration.

Store external event IDs, native IDs, source versions, correlation IDs, request/response digests and reconciliation status with restricted access. Keep PHI out of general telemetry and dead-letter payloads. Clinical result corrections and device reassignment are domain events, not generic last-write-wins updates. Recheck current authorization before queued work or delivery.

## Configuration template

Use `specs/integration-config.example.json` for logical names, feature flags, pinned-release placeholders and secret reference names. It is not a Wrangler configuration and contains no real endpoints or keys. Validate it with the implemented configuration schema. No adapter becomes enabled merely because its base URL is populated. Approve licensing and data-processing prerequisites separately from technical connectivity.
