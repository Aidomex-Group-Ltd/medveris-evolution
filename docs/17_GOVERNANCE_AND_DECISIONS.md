# Governance clinical safety and outstanding decisions

This kit provides technical requirements and draft governance structures. It does not determine the system's legal classification or supply final jurisdiction-specific agreements, clinical protocols, validation reports or licensing advice. Those deliverables depend on actual countries, operators, intended uses and vendors.

## Accountable roles

Product owner decides product scope and delivery priority. Clinical safety lead owns clinical hazard review, workflow acceptance and model intended use. Privacy lead owns data mapping, lawful-basis decisions, consent design, retention and disclosures. Security lead owns access architecture, testing and incident response. Facility clinical leads approve local workflows and escalation coverage. Credential reviewers verify evidence independently of submitters. Name the people and deputies before the corresponding production capability is enabled.

## Clinical safety process

Maintain a hazard register with hazard ID, trigger, possible harm, inherent severity, likelihood, controls, verification, residual assessment, accountable owner and release decision. Review wrong-patient documentation, hidden allergies, stale results, duplicate medication actions, alert nonresponse, model errors and downtime. The initial CSV contains seed hazards, not a completed safety case. Every release records which intended workflows and environments were assessed. Open unacceptable hazards block the affected feature.

## Privacy and legal work products to complete

1. Identify legal operator, contracting entities, facility responsibilities, deployment countries and controller/processor arrangements; do not infer the operator from another product.
2. Build a personal-data inventory and processing/location map, including vendors, images, telemetry, audit, backups and AI.
3. Complete a privacy impact assessment and document lawful bases, guardian/minor handling, sensitive categories and emergency/public-health exceptions.
4. Draft and obtain review of patient privacy notice, provider terms, data-processing agreement, data-sharing agreement, telemedicine consent, optional recording consent and AI information/consent where required.
5. Adopt retention and disposal schedules, legal holds, patient access/correction procedures, complaint handling and incident notification procedures.
6. Assess actual product functions and AI/device intended uses for applicable medical-device or other regulatory obligations.
7. Confirm professional/facility verification policies, jurisdiction constraints, cross-border processing and vendor contractual permissions.

For a Uganda pilot, appoint local reviewers to identify the applicable authorities and current requirements. This document deliberately does not claim Ugandan or global legal compliance. Add other jurisdictions only after their requirements and processing locations are assessed.

## Decision register

| Decision | Proposed starting point | Required owner/evidence |
|---|---|---|
| Canonical name | Medveris; Mediverse Cloud treated as descriptive | Product owner |
| Operator/legal entity | Unconfirmed | Product owner and legal reviewer |
| First deployment/pilot | One partner facility and limited clinical workflows | Clinical/product owners |
| Backend migration | Preserve working backend; PostgreSQL for new default | Architecture review and repository assessment |
| Identity provider | Maintained provider with MFA and secure recovery | Security and integration testing |
| Patient identity verification | Non-national-ID-dependent assisted process | Clinical/privacy policy and pilot acceptance |
| Cross-facility basis | Scoped grants plus documented exceptions | Privacy and clinical governance |
| Minors and proxies | Explicit authority, dates and sensitive-category policy | Local legal/clinical review |
| Result release | Configurable reviewed patient-release policy | Facility clinical leads |
| Residency and vendors | Undecided until contracts and data map | Privacy/security owners |
| Retention | Category- and jurisdiction-specific | Privacy/legal owners |
| PACS and viewer | Select compatible validated workflow | Radiology lead and conformance tests |
| AI/model choices | Per-task selection, disabled until validated | Clinical safety and model review |
| Device pilot | One noncritical measurement use case | Nursing/clinical engineering owners |
| Ledger | Signed private checkpoints initially; network undecided | Security/privacy/product review |
| RPO/RTO and support | Proposed targets in operations document | Funded operations plan and restore drill |

## Production gate

Release only the workflows whose relevant identity, isolation, consent, clinical safety, security, recovery, training and operational prerequisites have evidence. Missing decisions can be harmless for synthetic development but may block production processing. Do not stop local engineering merely because a production vendor or review is outstanding; keep those features disabled and record the exact remaining work.

## Terminology and conformance decisions

Appoint a terminology steward and an interoperability owner. Confirm SNOMED CT deployment rights for actual use countries, selected edition/extensions and redistribution/API permissions. Review current LOINC license notices and any service access terms; free content does not guarantee an unlimited hosted API SLA. Public demonstration servers are not production dependencies. Do not infer country entitlements from hosting location or assume the platform's source-code license grants terminology-content rights.

Approve clinical subsets, LOINC catalogue mappings, UCUM normalization, ConceptMap equivalence and upgrade policy. Record the FHIR profile packages, actual supported interactions, PACS conformance edition/SOP classes and receiving partner acceptance. Standards support is a tested scope statement, not an automatic certification or legal-compliance assertion.
