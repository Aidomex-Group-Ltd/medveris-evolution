# Roles and access policy

## Authorization rule

Permit an action only when authentication is valid, the session is current, the actor has an active membership and required privilege, resource scope matches, and clinical access has an approved care relationship, purpose and applicable legal basis. For cross-facility access also require an active exchange authorization, sensitivity filtering and a durable access audit. Deny by default. Consent is one possible legal basis; do not assume every treatment, emergency or public health activity uses consent. Jurisdiction policy determines exceptions.

| Actor | Permitted baseline | Excluded by default |
|---|---|---|
| Patient | Own identity, released records, appointments, consent, access history | Other patients, raw staff directories, unreleased results |
| Authorized guardian/proxy | Explicitly delegated patient scopes and valid dates | Automatic access to every dependent record |
| Receptionist | Minimal identity confirmation, registration, queues, appointments | Clinical narratives and sensitive diagnoses |
| Nurse/midwife | Assigned care observations, nursing records and authorized medication workflow | Unassigned patients and unrestricted prescribing |
| Clinician | Assigned encounters, clinical orders and signed notes within approved scope | Editing another facility's originals |
| Pharmacist | Valid medication orders, dispensing and relevant safety information | General access to unrelated clinical notes |
| Laboratory staff | Requests, specimen data and authorized results | General narrative histories |
| Radiology staff | Assigned imaging orders, relevant context and role-approved reports | Other patients' studies |
| Finance | Invoices, coverage, payments and minimum service coding | Full medical histories |
| Facility administrator | Staff, departments, facilities and policy administration | Clinical access by virtue of admin role alone |
| Credential verifier | Assigned verification evidence and decision history | Patient care records |
| Public health officer | Approved aggregate reports or scoped statutory disclosures | Routine unrestricted identifiable chart browsing |
| Auditor | Authorized audit metadata with protected-detail controls | Editing audit records |
| Platform operator | Infrastructure metrics and operational tools | Standing access to patient charts |
| Integration account | One adapter's scoped resources and tenant | Interactive staff privileges |

Users can hold multiple memberships, but each request has one explicit active context. Switching contexts re-evaluates permissions and clears client clinical state. Role changes and membership removal invalidate sessions or force current entitlement rechecks. Staff verification state and professional scope may restrict clinical actions independently from account creation.

## Patient identity and exchange

Issue an opaque cryptographically random public patient identifier, distinct from internal primary keys; optionally add a transcription checksum. The ID is not a password. QR codes contain only a locator and no reusable access secret. A patient can receive care without a phone or national ID through an assisted workflow. Record verification method and identity confidence; do not turn uncertain demographics into false certainty.

An authenticated staff lookup supplies exact ID plus identity confirmation through an approved process. Rate-limit and audit lookup. Show only minimum confirmation details allowed for that role and disclose clinical content only after authorization. Handle unconscious or unidentified patients with temporary identities and governed reconciliation. Never automatically merge likely duplicates. Require documented review and reversible linkage history, with dual review for merges.

An exchange grant records subject, recipient tenant, permitted resource categories, source scope, purpose, legal basis, policy version, authority/consent evidence, start, expiry, sensitivity restrictions and revocation. Patient delegation is separately versioned. Consent is not bundled into terms acceptance or used as blanket consent for research, marketing, AI training and all future care.

Revocation blocks subsequent requests and pending deliveries; recheck at query, asynchronous execution and object retrieval. Already lawfully received information cannot be technically recalled from a clinician's memory or arbitrary downloaded copies. Log disclosures and apply recipient retention obligations.

## Emergency override

Break-glass is a separate narrowly scoped authorization, not a global role. Require eligible staff, reauthentication, patient and encounter context, emergency reason and expiry. Proposed maximum is 60 minutes, configurable only through approved policy. Record use immediately, create a review task due within one working day, and notify the appropriate privacy/clinical team. Patient notification timing and restricted categories follow approved policy. Neither emergency access nor a grant allows amendment of another tenant's record.

## Implemented inventory permissions

Inventory uses explicit action permissions rather than a broad "inventory" role: `inventory.catalogue.read/manage`, `inventory.stock.read/receive/issue/adjust`, `inventory.transfer.manage`, `inventory.count.manage`, `inventory.recall.manage`, `inventory.asset.read/manage` and `inventory.report.read`. Clinical and nursing roles receive read access (nurses also receive/issue); pharmacists, CSSD and biomedical roles receive the operational commands appropriate to their service; finance, HR, records, quality and auditors receive read-only access. Central stock and organisation-wide reports additionally require an organisation-scope role and are enforced by the route, not only the navigation.

Separation of duties is enforced on requisitions (requester cannot approve), transfers (dispatcher cannot receive) and counts/adjustments (counter cannot approve their own variance). Stock is a projection of an append-only `stock_movements` ledger; runtime roles cannot update or delete posted movements or signed records.

## Implemented content and governance permissions

`content.read` gates the published feed; `content.draft`, `content.review`, `content.publish` and `content.archive` gate editorial commands. Authors cannot review or publish their own material, and a facility administrator cannot bypass independent approval. `role_grant.request` and `role_grant.approve` are separate; a requester cannot decide their own grant, and grants carry an expiry. `clinical.care_team.manage` scopes chart participation to a linked patient, while `care_team.read` and `audit.read` support access review.

Dashboard permissions are distinct from chart access: `dashboard.patient.read`, `dashboard.clinician.read`, `dashboard.specialist.read`, `dashboard.operations.read`, `dashboard.support.read`, `dashboard.finance.read` and `dashboard.administration.read`. A dashboard returns aggregates and assigned work only; opening a chart still requires an authorized record read.

## Decision evidence

Audit actor, active role, purpose, target reference, decision, reason code, policy version and grant/override reference. Sanitize denial messages to prevent identifier enumeration. Separate patient-readable access history from security-investigation details. Test permissions on lists, counts, filters, exports, notifications, search, file URLs and background jobs, not just detail pages.

## Standard endpoint authorization

FHIR scopes, patient references and DICOM study UIDs do not confer access independently. Apply the same permissions to FHIR read/search/history, included resources, terminology entitlements and DICOMweb metadata/frames/bulk data as to native screens. Distinguish a terminology-content entitlement from permission to read a patient's chart. Integration clients receive explicit resource/action/tenant scopes and current grant checks. Keep audit and consent resources more restrictive than ordinary clinical data. AT28 and AT33 test these boundaries.
