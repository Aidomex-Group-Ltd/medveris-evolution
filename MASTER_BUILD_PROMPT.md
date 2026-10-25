# Medveris master build prompt

You are the implementation engineer working in the actual Medveris application repository. Build the system described by the accompanying `docs/` and `specs/` documents. Implement working software and verify it; do not stop at a plan or create only a visual prototype.

## Inspect before changing

Read AGENTS.md, repository documentation, this kit, package manifests, existing authentication, backend services, database migrations, tests and Cloudflare configuration. Inspect git status and preserve unrelated changes. Identify whether an existing Phoenix, Node or other backend is already functional. Keep and integrate working functionality; do not rewrite or migrate a clinical database merely to match the proposed default stack. Record any architecture deviation and its migration implications.

If the repository is empty, scaffold a TypeScript workspace with `apps/web`, `apps/api`, `apps/jobs`, `packages/domain`, `packages/authz`, `packages/db`, `packages/contracts`, `packages/ui`, `tests` and `docs`. Use React and TypeScript for the web application, a Workers-compatible HTTP framework such as Hono for the API, PostgreSQL for clinical transactions, and a Workers-compatible PostgreSQL driver validated against the selected Hyperdrive configuration. Pin compatible supported versions after checking current official documentation. Do not assume this kit pins a current package version.

## Product and scope

Medveris provides free patient and provider registration, tenant-isolated facility operations, a unique patient identifier, and authorized cross-facility longitudinal records. Provider licenses may be submitted optionally. Submitted evidence is not verified evidence, and verified credentials are not proof of clinical competence. Facilities without verified credentials may onboard, while regulated actions remain subject to the adopted jurisdiction and role policies.

Cover reception, outpatient care, emergency and recovery, wards, pediatrics, adult male/female wards, surgery, NICU, ICU, maternity, theatre and anesthesia, primary and community care, diagnostics, pharmacy, administration, finance, public health, chronic care, hospice and palliative care. Build in milestones. Do not pretend that later modules are implemented by displaying fabricated metrics or functioning-looking buttons.

## Non-negotiable invariants

1. A patient ID locates an identity and never authorizes record access. Return no patient information to an anonymous lookup.
2. Derive actor and tenant context from an authenticated, current membership; never trust a browser-supplied tenant ID alone. Enforce resource-level authorization on the server and tenant isolation in the database.
3. Cross-facility record access uses a dedicated exchange policy path with purpose, care relationship, permitted legal basis or consent, scope, expiry, sensitivity filtering and durable audit. An ordinary tenant connection cannot read another tenant's tables.
4. Require MFA for staff clinical access and privileged functions; protect recovery, session revocation, role changes, impersonation and exports. A facility administrator has no automatic clinical access.
5. Preserve original signed clinical entries. Changes append a version with a mandatory reason, author, timestamps, prior version, and current-version concurrency check. Draft edits also receive audit notes. Use entered-in-error states and governed corrections rather than destructive deletion.
6. Clinical writes, amendment metadata, audit events and transactional outbox records commit together. A signed entry cannot succeed without its audit record. Protected reads are durably audited before returning data; define a fail-closed response when that audit cannot be persisted.
7. Keep clinical data, patient IDs, images and identifiable metadata off public blockchains. Implement signed audit checkpoints and a LedgerAdapter interface. Production anchoring requires an explicit ledger and governance decision. Never label unanchored events as blockchain-confirmed.
8. Disable shared caching for authenticated responses, clinical queries and permission decisions. Use `Cache-Control: no-store` and verify Cloudflare, Hyperdrive, browser service workers, analytics and logs do not expose protected content.
9. AI output is a reviewable suggestion with evidence references and model provenance. Never silently write AI diagnoses, prescriptions or monitoring actions into signed records. Keep predictive and image interpretation features disabled until their intended-use validation is approved.
10. Devices cannot directly control treatment. Cloud observations cannot replace bedside critical alarms. Display data freshness and unreliable readings. Do not ship invented clinical thresholds.
11. Use synthetic patients only for seeds, previews, tests and demonstrations. Never invent provider verification, source records, clinical results, model performance or compliance claims.
12. Return genuine error and integration states. No mocked production email delivery, payments, PACS, blockchain, AI or device connectivity.

## Execute in order

### M0 Repository and architectural foundation

Produce a concise repository audit and gap matrix, then implement missing local configuration, dependency pinning, strict typing, environment validation, health checks, reproducible PostgreSQL development services, migration scripts and CI. Create a status file listing supported, incomplete and unavailable workflows. Use `.env.example` with placeholders only. Do not expose secrets in logs.

### M1 First working clinical slice

Implement real patient signup and staff/facility onboarding with provider adapters and a local mail sink. Add unique random patient IDs, patient identity confirmation, verified membership switching, MFA, session revocation, a patient portal, reception and queues, encounters, structured observations with units, allergies with unknown/none/known distinctions, clinician-authored signed notes, amendments with mandatory reasons, and role-filtered records. Add scoped consent, revocation, cross-facility exchange of permitted records, and time-limited break-glass access with reason, MFA reauthentication and review tasks. Add credential upload quarantine, manual verification workflow and expiry handling. Add durable audit and an outbox with idempotent processing. Implement permission-safe empty, denied, loading and integration-failure UI states.

M1 acceptance demonstration: synthetic patient registers once; facility A treats the patient and signs a note; facility B is denied until an authorized exchange grant exists; B then sees only permitted source-labelled entries; A amends its note with a reason and prior-version preservation; revoke the grant and B's next request and document fetch fail. Neither facility can edit the other's source record. A receptionist and finance user cannot retrieve clinical notes. Evidence includes real integration and browser tests, not only screenshots.

### M2 through M5

Follow `14_DELIVERY_BACKLOG.md` in order: departmental workflows; operations and public health; telemedicine and bounded device pilots; then validated clinical AI, task-specific radiology interpretation and approved ledger anchoring. Implement only the next explicitly selected milestone after passing the previous gate. In this initial run complete M0 and M1 as far as the actual environment supports; do not attempt every hospital module in one pass. Record blocked external setup precisely and continue all independent local work.

## Required engineering behavior

Use schema-validated inputs, parameterized SQL, database constraints, transactional domain operations, authorization middleware plus resource checks, least-privilege database roles and RLS tests under the real runtime role. Transaction-local request context must not leak across pooled connections. Do not use a broad privileged database role in the general API. The exchange service needs a separate narrow role and explicit projections; request context alone is not proof of authorization.

Add cursor pagination, idempotency for retryable commands, optimistic concurrency, safe file processing, queue deduplication, error correlation IDs, consent rechecking at execution/delivery, and redacted structured logs. Implement two tenants and a patient portal in the integration fixtures. Tests must run against PostgreSQL for PostgreSQL behavior. Contract tests must exercise the actual HTTP handlers.

Use no-store clinical responses and private authenticated object delivery. Do not put identifiers in public URLs, QR access tokens, analytics events or generic error messages. For real integrations, validate vendor security, regions, contractual restrictions and intended use before sending patient data. Develop behind disabled feature flags when accounts or approval are absent.

## Verification and completion report

Run formatter/linter, type checks, unit tests for domain transitions, PostgreSQL isolation and concurrency tests, API contract tests, required Playwright flows, production builds, and a Workers runtime smoke test using the repository's actual commands. Test logout, membership removal, revoked consent, direct object access, stale versions, duplicated queue delivery and audit persistence failure. Inspect browser UI at desktop and mobile sizes. Fix failures caused by your changes.

At completion report: changed files, implemented user journeys, commands and results, migration instructions, exact remaining integrations, feature flag states, known limitations, and the next milestone. Maintain requirement-to-test evidence. Do not describe an unexecuted check as passed. Do not mark this system clinically validated or production-ready because it compiles. Prepare deployment configuration and a reviewable release; deploy only within the user's actual authorization and never reset a production database.

## Required standards and integration implementation

Apply documents 19 and 20 as part of the core build, not as an optional future appendix. Implement HL7 FHIR R4 4.0.1 profiles and a restricted `/fhir/r4` facade, production-configurable SNOMED CT/LOINC terminology services, UCUM quantitative units and DICOM/DICOMweb imaging integration by the stated milestones. Read the standards acceptance scenarios AT27–AT36. Preserve prior invariants on consent, source ownership, signed-record amendments and audit across every standard endpoint.

In M0 choose the FHIR engine/facade, pin implementation-guide packages, define coded data types and terminology/PACS adapter contracts, and record content rights and supported versions. In M1 implement field-specific coded entry with reviewed SNOMED CT/LOINC value sets, lookup/expansion/code validation, release-aware storage, and a minimal FHIR resource projection with a truthful CapabilityStatement. Use synthetic fixtures and a clearly labelled test terminology adapter locally. Configure a genuine licensed production terminology service before standardized clinical use. Do not connect production entry to public training/demo services.

In M2 implement PACS QIDO-RS, WADO-RS and STOW-RS with patient/study reconciliation, private object/frame/metadata access, DICOM conformance checks, LOINC laboratory mappings, ImagingStudy and DiagnosticReport linkage. Hospital DIMSE/worklist adapters require actual device/site testing. Do not implement heavy terminology indexing or a PACS inside a lightweight Worker.

Use Coding/CodeableConcept semantics with system, version, code as string, display and original text; validate contextual bindings server-side. Never invent concept identifiers or treat fuzzy text matching as an approved code mapping. Preserve historical signed codes on terminology upgrades. Define local/text draft behavior during terminology outages without exporting unvalidated codes as standards-compliant.

Expose standard FHIR responses/media types, OperationOutcome, resource versioning and scoped paging/search; never reuse a native generic error wrapper at the FHIR boundary. Disable unimplemented transaction, bulk export and external update capabilities. Future writes must invoke domain commands and mandatory reasoned amendments. Apply source/tenant/consent checks to search, includes, history, images, frames, metadata and downloads. Update profile validation reports, mapping evidence, adapter contract tests and all machine-readable specifications before declaring a standards capability complete.
