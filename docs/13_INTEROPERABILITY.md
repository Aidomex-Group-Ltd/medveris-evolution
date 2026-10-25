# Interoperability terminology and public health exchange

## FHIR strategy

Use a selected FHIR R4 implementation profile for the initial exchange boundary, subject to partner requirements. Map the internal model explicitly and publish a CapabilityStatement listing supported resources, searches, operations, profiles and limitations. FHIR is an exchange specification, not automatic security or compliance. Require actual authentication, authorization, transport security and audit.

| Medveris concept | Candidate FHIR resources |
|---|---|
| Global patient and relationships | Patient, RelatedPerson |
| Facility and practitioner | Organization, Location, Practitioner, PractitionerRole |
| Visits and scheduling | Encounter, Appointment |
| Clinical facts | Condition, AllergyIntolerance, Observation, Procedure |
| Plans and requests | CarePlan, Goal, ServiceRequest |
| Medication workflow | MedicationRequest, MedicationDispense, MedicationAdministration |
| Diagnostics | Specimen, DiagnosticReport, ImagingStudy |
| Documents | DocumentReference, Composition where applicable |
| Consent and traceability | Consent, Provenance, AuditEvent |
| Device linkage | Device, DeviceMetric where appropriate |

Resource mapping does not imply every listed resource is implemented at M1. Document supported profiles, cardinality choices, code bindings, patient identifier systems, source attribution and known lossy conversions. Validate output with the selected implementation guide and test round trips with a partner sandbox. Use SMART on FHIR/OAuth profiles when supported and required by the partner.

## Terminology

Adopt codes for diagnoses, laboratory observations, units, procedures and medicines through a governed terminology service. Candidate systems include ICD, LOINC, UCUM and SNOMED CT where licensing and jurisdiction permit. Record system/version and local-to-standard mappings. Validate terminology licenses before bundling content. Do not silently treat local text as a standard code. Preserve source text and mappings with reviewer and dates.

## Medical imaging

Use DICOM identifiers and DICOMweb as supported by the actual PACS. Query, retrieve and store operations require access controls, modality-specific testing and an imaging conformance statement. Maintain consistent patient identity and accession reconciliation. Do not modify original study identifiers to hide mismatches. Protect embedded patient metadata and pixel annotations; de-identification must address both.

## External and public health interfaces

Each adapter declares owner, purpose, authority, schema/version, permitted fields, region, credentials, signature verification, retry/idempotency strategy, audit and reconciliation. Use versioned schemas for public health datasets and record case definitions, date windows, facility and missingness. Aggregate-first release should include disclosure review for small groups and differencing risk. Statutory identifiable reports use an approved separate flow.

Support configurable CSV export only with explicit authorization and disclosure controls; it is not a substitute for an agreed interface. A national or government integration is unavailable until access, schema and acceptance testing exist. For Uganda, determine the actual partner programme and approved reporting interface rather than assuming national system access.

## Import controls

Validate syntax, source, patient identity, encounter context, codes, units and duplicates before importing. Quarantine ambiguous matches. Keep original payload references and transformation versions. Imported entries retain external provenance and distinguish external from local signatures. Do not automatically merge patient identities or overwrite local signed history from an inbound feed.

## Version 1.1 requirement precedence

The earlier candidate terminology wording is strengthened: documents 19 and 20 require staged SNOMED CT and LOINC terminology integration, a restricted FHIR R4 interface and DICOM/DICOMweb imaging support. The resource mapping table remains valid as a candidate per-resource mapping, but only implemented interactions appear in the CapabilityStatement. Production terminology editions, national extensions, profiles and PACS capabilities are selected and recorded before use. See AT27–AT36 and the integration registry for operational details.
