# Standards implementation requirements

Version 1.1 • 25 October 2026. This document strengthens the earlier baseline: HL7 FHIR, DICOM, SNOMED CT and LOINC are required architecture capabilities, delivered in the stages below. They are not optional labels, automatic certifications, interchangeable formats, or a promise that all resources and modalities are supported at the first release.

## Responsibilities and canonical identifiers

| Standard | Required responsibility | Canonical identifier or version policy |
|---|---|---|
| HL7 FHIR | Structured clinical and operational exchange API, profiles, validation and provenance | FHIR R4 4.0.1 baseline; pin implementation-guide packages |
| DICOM and DICOMweb | Diagnostic imaging objects, metadata, storage, discovery and retrieval | Pin PACS conformance edition and supported SOP classes/transfer syntaxes |
| SNOMED CT | Clinical concepts for findings, disorders, procedures and applicable coded values | Coding.system `http://snomed.info/sct`; store edition/version URI |
| LOINC | Identify ordered/performed laboratory and clinical observations, panels and supported documents | Coding.system `http://loinc.org`; store release version |
| UCUM | Machine-readable units for quantitative observations | Quantity.system `http://unitsofmeasure.org`; retain original units |

FHIR transports structured meaning; SNOMED CT and LOINC supply coded meaning in their appropriate roles; DICOM carries diagnostic imaging. None replaces the other. Codes are strings, including SNOMED CT identifiers: do not coerce them into JavaScript numbers. A terminology code-system URI is not necessarily the network endpoint to call.

## Required FHIR service

Provide a versioned FHIR base such as `/fhir/r4` behind the same patient, tenant, purpose, consent and audit controls as the native API. Prefer integrating a maintained FHIR engine or a carefully bounded facade rather than implementing the entire specification from scratch. Keep PostgreSQL source ownership and domain commands authoritative. Do not create an unsynchronized second clinical database merely to expose FHIR.

Publish `/metadata` with the actual CapabilityStatement, not an aspirational resource list. Use FHIR media types, OperationOutcome for FHIR errors, searchset Bundles and standard paging links. Publish the supported profiles, search parameters, terminology bindings, version semantics and limitations. R4 is the chosen baseline; translate R4B/R5 partner payloads through separately tested adapters rather than mixing releases in one endpoint.

M1 resources: Patient, Organization, Practitioner, PractitionerRole, Encounter, Observation, Condition, AllergyIntolerance, DocumentReference, Consent, Provenance and AuditEvent as implemented projections. A resource may be restricted to read or search. Sensitive consent/audit resources are not generally readable just because a client can read a Patient. M2 adds Appointment, Location, ServiceRequest, Specimen, DiagnosticReport, ImagingStudy and medication workflow resources. M3 adds CarePlan, Goal and operational resources such as Claim, ClaimResponse and Invoice only when partner mappings are agreed. Payment settlement and local stock operations can remain native APIs; do not invent FHIR resources.

Support read and patient/subject-constrained search for the selected initial clinical resources. Add version-specific reads and history where implemented and authorized. Every history version remains permission checked. Allowlisted `_include`, `_revinclude`, chained searches, totals and pagination must not reveal another tenant's resources. Deny unsupported operations clearly. Do not offer unrestricted system-wide search, bulk export, history or arbitrary transaction Bundles by default.

External writes are disabled in M1 unless a scoped ingestion path is explicitly implemented. When enabled later, profile validation, identity reconciliation, permissions, expected-version handling, mandatory correction reason and the native audit transaction all apply. Direct PUT/PATCH must not overwrite signed content. Medveris may reject unsupported updates or route them through a documented versioned amendment operation. A selected transaction Bundle must succeed atomically for supported actions; never advertise transaction support if it is merely sequential processing.

Use OAuth/OIDC and SMART App Launch profiles where applicable to partner integration. Register client audience, redirect URIs, scopes, allowed organizations and patient context. A SMART scope limits access but does not replace Medveris consent and source ownership checks. Discover authorization configuration only when that SMART profile is actually supported.

## Required terminology service

Deploy or contract a production-supported terminology service with the approved SNOMED CT edition, LOINC release and local value sets. Snowstorm or another compatible service can be evaluated; its runtime and indexing belong in suitable dedicated infrastructure, not a presumed Workers-native process. A Workers adapter handles authorization, entitlement, bounded queries and provider credentials. Do not use public training/demo SNOMED endpoints for production clinical entry. Verify upstream capabilities, authentication, quotas and rights before selecting a hosted service.

Expose the supported subset of FHIR CodeSystem `$lookup` and `$validate-code`, ValueSet `$expand` and `$validate-code`, and ConceptMap `$translate`. SNOMED hierarchy/subsumption and ECL filtering can be enabled through a tested vendor adapter where needed; they are not assumed universally available. Publish TerminologyCapabilities and version selection. Search results must identify system, version, code, preferred display, active status and relevant context.

Maintain field-specific value sets: complaint/finding, diagnosis, procedure, allergy substance/reaction, observation type and result answer. Clinical findings and diagnoses use reviewed SNOMED CT subsets; measurement names generally use LOINC; quantitative units use UCUM. For a categorical laboratory result, a governed SNOMED CT or LOINC answer-list value may be appropriate. Do not use SNOMED CT as an assumed global product/drug inventory catalogue or LOINC as a diagnosis vocabulary.

LOINC selection considers component, property, timing, system/specimen, scale and method where relevant. A matching display string is insufficient. Preserve local laboratory test IDs and reviewed ConceptMap mappings. Validate specimen, units, method and result type before publishing. No automatic one-to-one mapping between SNOMED CT, LOINC and ICD is assumed. Mapping results retain relationship/equivalence, direction, version, reviewer and approval state; a translation is not proof of clinical equivalence.

Persist Coding `{system, version, code, display, userSelected}` within a CodeableConcept plus original text. Record value-set version and validation outcome. Never relabel a historical signed code when a new release changes its preferred term. Detect inactive codes for new entry and offer reviewed replacements while preserving the original meaning and identifier.

M1 must implement coded entry, contextual search, validation and a synthetic test terminology adapter, plus a configurable production adapter. Production standardized coding requires approved content and entitlement. If terminology service is unavailable, existing records remain readable; approved policy may permit a clearly unvalidated local/text draft for care continuity. It must not masquerade as a validated standard code or be exported to a required-binding profile until reconciled. Use versioned local release caches only where permitted and label stale availability. License-safe caches contain terminology only, never patient search text.

## Required DICOM workflow

Use a private PACS/VNA with a selected DICOMweb implementation. QIDO-RS discovers authorized studies, series and instances; WADO-RS retrieves permitted metadata, objects, frames and supported representations; STOW-RS stores studies with per-instance result handling. These names describe services; each exact method, path, media type and response follows the chosen DICOM edition and server conformance statement.

Scope queries using an authorized patient-to-study index and verify ownership/consent again on every retrieved object, metadata result, frame, thumbnail and bulk-data reference. StudyInstanceUID, SeriesInstanceUID and SOPInstanceUID are identifiers, not access credentials. Never expose arbitrary PACS URL proxying. Patient ID and issuer, accession number, encounter and study mapping require reconciliation; a DICOM PatientID is not automatically the global Medveris ID.

Keep original DICOM objects immutable under the governed lifecycle. Preserve transfer syntax, SOP class, study/series/instance UIDs and required metadata. ImagingStudy links identities and instance metadata; DiagnosticReport links report/order/results; DocumentReference may describe documents. These FHIR resources do not substitute for original image pixels or turn a generic file bucket into a PACS. Separate source images, rendered derivatives, AI overlays and signed reports.

Hospital modalities using DIMSE and modality worklist require a validated site gateway/PACS interface. DICOMweb alone does not ensure every acquisition device can connect. Record supported modality, SOP class, transfer syntax, compression, partial failure behavior and diagnostic viewer capabilities. Test unsupported, corrupt, duplicate and wrong-patient studies. Large study transfer and inference use dedicated services, bounded streaming or approved direct paths that maintain audit and token revocation requirements.

## Milestones and proof

M0: select version baselines and service interfaces; document content rights and partner capabilities. M1: coded clinical fields, terminology facade, FHIR profile package and restricted foundation exchange with a CapabilityStatement. M2: PACS/DICOMweb, laboratory LOINC mappings and imaging/report FHIR links. M3: agreed operational/public-health interfaces and controlled mappings. M4: device measurements mapped to LOINC/UCUM and FHIR Observation with provenance. M5: AI consumes versioned codes/source studies and proposed codes require clinical review.

Acceptance requires FHIR validator reports for implemented profiles, terminology validation/upgrade tests, wrong-tenant search/history tests, DICOM conformance evidence and actual adapter contract tests. An API route name or a successful JSON parse is not evidence of standards conformance. See AT27–AT36 in the acceptance plan and the API registry in document 20.
