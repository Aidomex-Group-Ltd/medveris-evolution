# Delivery milestones and dependency plan

Milestones define capability and acceptance gates, not guaranteed dates. Estimate after the repository audit, pilot partner selection and staffing. A solo developer can build a foundation, but clinical acceptance, security review, device validation and operational coverage require relevant qualified owners.

| Milestone | Deliverables | Dependency and exit gate |
|---|---|---|
| M0 Foundation | Repository assessment, ADRs, local PostgreSQL, configuration, CI, test fixtures and health checks | Reproducible clean setup and baseline test report |
| M1 Outpatient foundation | Identity, memberships, patient locator, reception, encounters, notes, observations, consent exchange, credential workflow, audit/outbox, patient portal | AT01–AT07 and applicable AT18–AT23 pass; two-tenant demonstration |
| M2 Clinical departments | Inpatient and emergency, specialist wards, maternity/NICU/ICU documentation, theatre, lab/radiology workflow, pharmacy | AT08–AT10; clinical workflow acceptance and safe correction/notification paths |
| M3 Operations and continuing care | Finance, claims, supplies, administration, chronic/primary/hospice programmes, authorized public health | AT11–AT13; reconciliations and disclosure review |
| M4 Remote care and devices | Telemedicine, one selected noncritical device adapter, quality states and staffed alerts | AT14–AT15; adapter-specific acceptance and fallback drill |
| M5 Validated intelligence and anchors | Reviewed summaries, selected diagnostic support, one defined predictive use case, one eligible imaging task, approved ledger adapter | AT16–AT18; model validation, clinical ownership and ledger governance |
| M6 Expansion | Partner FHIR exchange, additional regions, devices and models | Partner conformance and jurisdiction-specific review |

## M1 work packages

1. Auth and organizations: identity adapter, MFA, recovery, tenant creation, membership and context switching. Tests: actual runtime-role isolation and revocation.
2. Patient identity: signup, locator, identity evidence, assisted registration, proxy design and duplicate-review queue. Tests: ID-only access denied and identity conflicts handled.
3. Clinical record: encounter, observations, allergy state, notes, signing, append-only amendments and source attribution. Tests: atomic audit and stale-write conflict.
4. Consent and exchange: scoped grants, category filtering, revocation and reviewed emergency overrides. Tests: two facilities and queued delivery after revocation.
5. Trust: optional quarantine uploads, verifier role, evidence decisions and expiry. Tests: self-verification denial and expired badge behavior.
6. Operations: transactional outbox, retries, monitoring, backups and deployment setup. Tests: duplicate delivery, unavailable dependencies and restore.
7. UI completion: patient portal, reception and clinical workspaces with all error states. Tests: browser journeys and accessible keyboard operation.

## Definition of done

A feature has implemented API, database migration, authorization rules, UI where required, contract updates, meaningful tests and documentation. No dead buttons, invented results, false successful adapters or unreviewed medical algorithms. Evidence records commands, release commit and environment. New dependencies receive license and security review. Later-stage features show explicit unavailable status or remain hidden.

## Delivery discipline

Use small reviewable changes grouped by coherent user journey. Update requirement-to-test mapping and gap matrix after each milestone. Avoid a broad rewrite of existing functional services. Use feature flags for incomplete integrations and safe staged rollout. No production patient migration until identity matching, data provenance, rollback and reconciliation are rehearsed with representative synthetic data.

## Standards work packages and gates

M0 adds baseline/profile selection, terminology rights review, API registry and dedicated service boundaries. M1 adds Coding/CodeableConcept persistence, field-specific SNOMED CT/LOINC search/validation, FHIR facade and profiles, plus AT27–AT31 and applicable AT36. M2 adds LOINC lab catalogue reconciliation, PACS QIDO/WADO/STOW and ImagingStudy/DiagnosticReport links with AT32–AT33. M3 adds reviewed claims/public-health ConceptMaps and API adapters. M4 adds LOINC/UCUM telemetry and AT34. M5 adds code-aware AI compatibility/validation and AT35. Partner-specific FHIR integration can expand in M6, but the foundation FHIR API is now an M1 deliverable rather than deferred entirely to expansion.
