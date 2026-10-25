# Medveris implementation kit

Version 1.1 • 25 October 2026 • Prepared for Omuut Tom

This kit turns the supplied Medveris vision into a staged engineering specification. Use Medveris as the canonical product name; “Mediverse Cloud” is treated as a descriptive name pending an explicit branding decision. This is a build specification, not a completed application, clinical validation, security certification, or legal approval.

## Implemented local MVP

This repository now contains an executable M0/M1 implementation with synthetic data: React web app, Hono API, PostgreSQL RLS, signed clinical versions, consent-scoped exchange, audit/outbox workers and a read-only FHIR facade.

```bash
npm install
npm run db:setup && npm run db:migrate && npm run db:seed
npm run dev
```

Then open <http://localhost:5173> and use `clinician@medveris.local` / `Medveris!2026` with the local development MFA code.

See `docs/LOCAL_DEVELOPMENT.md`, `docs/MVP_STATUS.md`, `docs/IMPLEMENTATION_GAPS.md` and `docs/TEST_EVIDENCE.md`. This remains synthetic development software, not a validated or certified clinical system.

## Start here

1. Copy this directory into the actual application repository as `planning/medveris/`.
2. Read `MASTER_BUILD_PROMPT.md` and give its entire contents to OpenCode or your coding agent.
3. Start with milestone M0, then deliver M1 as an end-to-end outpatient foundation using synthetic data.
4. Use `docs/15_ACCEPTANCE_TESTS.md` to assess each milestone. Later modules remain explicitly unavailable until implemented and accepted.
5. Keep architecture decisions, implementation status, and test evidence in the repository. Replace assumptions with documented decisions as partners and infrastructure are selected.

## Contents

| File | Purpose |
|---|---|
| MASTER_BUILD_PROMPT.md | Copy-ready coding-agent instruction |
| docs/01_PRODUCT_REQUIREMENTS.md | Vision, scope, requirements, priorities |
| docs/02_ROLES_AND_ACCESS.md | Roles, authorization, consent and exchange |
| docs/03_ARCHITECTURE.md | Workers deployment, services, isolation and flows |
| docs/04_DATA_MODEL.md | Entities, relationships, invariants and migration plan |
| docs/05_API_CONTRACT.md | Endpoint inventory and behavior |
| docs/06_CLINICAL_WORKFLOWS.md | Departmental workflows and state transitions |
| docs/07_UX_SPECIFICATION.md | Screens, navigation and interaction requirements |
| docs/08_SECURITY_AND_THREAT_MODEL.md | Threats, controls and verification |
| docs/09_AUDIT_AND_LEDGER.md | Amendment history, audit and blockchain boundary |
| docs/10_PROVIDER_TRUST.md | Credential evidence, verification and capability claims |
| docs/11_AI_AND_RADIOLOGY.md | AI boundaries, validation and imaging architecture |
| docs/12_TELEMEDICINE_AND_IOT.md | Remote care, device ingestion and alerts |
| docs/13_INTEROPERABILITY.md | FHIR, terminology, DICOM and public health exchange |
| docs/14_DELIVERY_BACKLOG.md | Staged implementation and dependency order |
| docs/15_ACCEPTANCE_TESTS.md | Testable release criteria and traceability |
| docs/16_OPERATIONS_AND_DEPLOYMENT.md | Environments, CI, backups and incident response |
| docs/17_GOVERNANCE_AND_DECISIONS.md | Clinical safety, privacy review and open decisions |
| docs/18_SOURCES.md | Primary technical and healthcare references |
| docs/19_STANDARDS_IMPLEMENTATION.md | Required FHIR, DICOM, SNOMED CT, LOINC and UCUM implementation |
| docs/20_API_INTEGRATION_REGISTRY.md | Standard and operational APIs and external adapters |
| specs/integration-config.example.json | Non-secret integration configuration template |
| specs/standards-traceability.csv | Standards requirements and acceptance mapping |
| specs/openapi-standards.json | Starter standards endpoint discovery contract |
| specs/clinical-coding.schema.json | Versioned coding representation |
| specs/clinical-entry.schema.json | Example immutable clinical entry contract |
| specs/device-observation.schema.json | Example device ingestion contract |
| specs/openapi-foundation.json | Starter OpenAPI contract for an M1 subset |
| specs/hazards.csv | Initial clinical and privacy hazard register |
| specs/backlog.csv | Importable milestone backlog |

The machine-readable contracts are starting contracts for defined slices, not complete implementations of FHIR, DICOM, or all hospital workflows. Version 1.1 makes these standards required staged capabilities; actual conformance still requires implementation and validation. Markdown is authoritative for product intent; the implemented API and tests must evolve together with the contracts.

## Proposed defaults

React and TypeScript UI; TypeScript API on Cloudflare Workers; PostgreSQL clinical system of record through Hyperdrive with query caching disabled for protected data; private object storage; asynchronous queues; separate PACS, device gateway, video media, and model inference services. Preserve a working existing backend where migration would add risk. No real patient data in development, examples, or previews.

The documents contain proposed engineering targets and policy defaults. Named clinical, security and governance owners must approve applicable production decisions. No claim is made that all required local forms, country integrations, clinical protocols or jurisdiction-specific legal documents are included.

## Version 1.1 changes

FHIR R4, DICOM/DICOMweb, SNOMED CT and LOINC are now explicit staged implementation requirements throughout the prompt, architecture, data model, workflows, security, operations and tests. New documents 19 and 20 define service contracts and the operational API registry. Acceptance now includes 36 scenarios. Supporting examples remain design artifacts, not evidence of running services or clinical/standards certification.
