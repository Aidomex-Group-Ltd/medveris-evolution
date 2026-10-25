# Product requirements

Status: proposed baseline. Product owner: Omuut Tom. Clinical and privacy owners: to appoint before clinical deployment. Scope is a multi-tenant healthcare platform, not a single hospital installation. Free registration is required; subscription pricing, transaction fees and other monetization are undecided.

## Outcomes

Patients maintain one longitudinal identity across participating facilities. Each facility conducts its own operations without seeing another facility's confidential administrative information. Authorized care teams receive relevant shared clinical history with provenance. Every alteration remains attributable. Provider trust communicates evidence rather than promising outcomes. AI and devices assist approved workflows without assuming clinical responsibility.

## Requirements

| ID | Requirement | Initial stage | Acceptance reference |
|---|---|---|---|
| PR01 | Free patient registration, recovery and non-sequential unique primary ID | M1 | AT01 |
| PR02 | Free facility/practitioner onboarding and optional credentials | M1 | AT02 |
| PR03 | Tenant memberships, role scopes, MFA and session revocation | M1 | AT03 |
| PR04 | Longitudinal record with source facility and author | M1 | AT04 |
| PR05 | Consent-scoped exchange and reviewed emergency override | M1 | AT05 |
| PR06 | Append-only signed records, audit notes and provenance | M1 | AT06 |
| PR07 | Reception, queues, triage, outpatient encounters | M1 | AT07 |
| PR08 | Admissions, bed transfers, ward observations and discharge | M2 | AT08 |
| PR09 | Emergency, maternity, pediatric, NICU, ICU and theatre workflows | M2 | AT09 |
| PR10 | Laboratory, radiology, pharmacy and medication administration | M2 | AT10 |
| PR11 | Finance, insurance, procurement, inventory and administration | M3 | AT11 |
| PR12 | Primary care, chronic care, hospice and palliative care plans | M3 | AT12 |
| PR13 | Public health surveillance and authorized reporting | M3 | AT13 |
| PR14 | Video consultations and remote follow-up | M4 | AT14 |
| PR15 | Validated device observations and alert routing | M4 | AT15 |
| PR16 | Evidence-linked diagnostic assistance and prediction | M5 | AT16 |
| PR17 | Modality-specific radiology analysis and reviewed reporting | M5 | AT17 |
| PR18 | Verifiable audit integrity and separately governed ledger anchors | M1/M5 | AT18 |

## Nonfunctional targets

These are proposed planning targets, not vendor guarantees or clinical monitoring performance claims. At an initial declared test load of 50 active users across two tenants, target p95 ordinary chart metadata requests below 2 seconds and p95 write acknowledgement below 3 seconds, measured from the pilot region with a realistic database. Exclude image transfer, video and inference and report them separately. Target 99.9% monthly availability for core workflows after pilot, database RPO at most 15 minutes and RTO at most 4 hours, subject to budget and tested backup capability. Confirm the pilot's acceptable downtime before launch.

Support mobile and desktop browsers, keyboard operation, accessible contrast, clear focus and text labels. Target WCAG 2.2 AA and verify rather than claim certification. Localize dates, language, timezone and currency. Persist clinical instants in UTC, source timezone when relevant, and distinct clinical occurrence versus entry timestamps. Support uncertainty in demographics and unknown clinical states.

## Scope exclusions and acceptance boundaries

No autonomous diagnosis, prescribing, image clearance, life-support control, universal automatic license verification, national-ID dependence, or unrestricted global clinical record search. No single AI model is assumed to interpret all radiology modalities. Device and public health integrations are adapter-specific. Offline clinical writing is deferred pending conflict, identity and device-storage designs; provide downtime procedures instead. No payment plan may make emergency escalation depend on a billing result.

The first release is an outpatient foundation, not an accepted ICU or theatre system. Later departmental releases require workflow acceptance by the participating clinical teams.

## Required standards and API capabilities

PR19: Implement the HL7 FHIR R4 exchange baseline and validated resource profiles, beginning in M1 (AT27–AT28). PR20: Implement production-configurable SNOMED CT/LOINC terminology lookup, contextual selection and server validation with release-aware persistence in M1 (AT29–AT31). PR21: Implement PACS-backed DICOM/DICOMweb acquisition integration, discovery, storage and retrieval in M2 (AT32–AT33). PR22: Use LOINC/UCUM device observation mappings and reviewed terminology for analytics/AI (AT34–AT35). PR23: Maintain API ownership, configuration, vendor rights and resilience evidence across all operational adapters (AT36). Documents 19 and 20 define normative stage details. These strengthen the earlier candidate terminology wording: standards are required, while exact editions, licensed content and partners require documented selection.
