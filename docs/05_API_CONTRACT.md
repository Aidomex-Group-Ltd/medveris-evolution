# API contract

Version prefix `/api/v1`. This endpoint inventory is the target contract; `specs/openapi-foundation.json` covers a selected M1 subset. The coding agent must expand the machine-readable specification with implementation, not report every endpoint here as available.

## Common behavior

Authenticate browser requests with secure HttpOnly cookies and CSRF protection on state-changing requests, or an approved OIDC token architecture with documented storage and audience validation. Do not improvise a new password/MFA system. An active tenant header or path is a requested context checked against current membership, never independent authority. Patient portal requests use the verified patient-subject link. Integration tokens use a separate issuer/audience/scope profile.

JSON payloads use schema validation, bounded strings, strict identifier types and rejection of mass-assigned protected fields. Return generic errors as `{error:{code,message,correlationId,details?}}` without patient data, SQL or secrets. Use 401 unauthenticated, 403 unauthorized, 404 non-disclosing not-found where appropriate, 409 stale version/state conflict, 422 invalid domain values, 429 rate-limited and 503 required dependency unavailable. Do not turn a database failure into a false successful empty response.

All protected responses use no-store. Require `Idempotency-Key` for retryable creates and state-changing commands; bind to actor, tenant, route and request digest. Same key/different payload returns 409. Persist in the command transaction; proposed expiry is 24 hours, adjusted for longer external workflows. Versioned changes carry `expectedVersion` or an equivalent If-Match contract. Lists use opaque scoped cursor pagination and bounded page sizes; no unbounded chart exports.

| Area | Method and route | Behavior |
|---|---|---|
| Health | GET `/health/live`, `/health/ready` | Public liveness minimal; internal readiness details protected |
| Auth | Provider callbacks; POST `/auth/logout` | Use selected identity-provider flow and revoke current session |
| Sessions | GET `/me`; DELETE `/me/sessions/{id}` | Current context and session controls |
| Onboarding | POST `/tenants`; POST `/patients` | Register facility or patient without verified-credential claims |
| Membership | GET/POST `/tenants/{tenantId}/memberships` | Administrative scope and MFA required for assignment changes |
| Locator | POST `/patients/resolve` | Exact ID plus approved identity confirmation, rate-limited and audited |
| Patient portal | GET `/me/patient`; GET `/me/records` | Released records and verified subject linkage only |
| Consent | POST `/patients/{patientId}/consents` | Create versioned, scoped authorization evidence |
| Revocation | POST `/consents/{consentId}/revoke` | Revoke grants and pending deliveries in scope |
| Exchange | GET `/exchange/patients/{patientId}/records` | Grant-filtered projection with provenance |
| Override | POST `/patients/{patientId}/emergency-overrides` | Reason, encounter, reauthentication and expiry |
| Appointments | GET/POST `/appointments` | Tenant and role-filtered scheduling |
| Queue | GET/POST `/queues/{queueId}/entries` | Audited queue changes and limited clinical display |
| Encounters | POST `/encounters`; POST `/encounters/{id}/transitions` | Validated encounter transitions |
| Notes | POST `/encounters/{encounterId}/entries` | Draft with author and creation note |
| Signing | POST `/entries/{entryId}/sign` | Attest exact expected version |
| Amendments | POST `/entries/{entryId}/amendments` | New version with reason and concurrency enforcement |
| Observations | POST `/encounters/{id}/observations` | Typed measurement, units, source and clinical time |
| Orders | POST `/orders`; POST `/orders/{id}/transitions` | Scoped diagnostics/medication/service order transitions |
| Diagnostics | POST `/orders/{id}/results`; POST `/reports/{id}/sign` | Preliminary/final/corrected lineage and authorized sign-off |
| Admissions | POST `/admissions`; POST `/admissions/{id}/transfers` | Atomic patient and bed assignment |
| Theatre | POST `/theatre/cases`; POST `/theatre/cases/{id}/checklists` | Procedure-linked consent and safety checkpoints |
| Pharmacy | POST `/dispenses`; POST `/administrations` | Link order and patient; role and reconciliation checks |
| Credentials | POST `/credentials`; POST `/credentials/{id}/checks` | Quarantined upload references and verifier decisions |
| Files | POST `/uploads`; POST `/uploads/{id}/complete`; GET `/documents/{id}/content` | Private staged uploads, scan gate and policy-checked download |
| Finance | POST `/invoices`; POST `/payments`; POST `/payments/{id}/reversals` | Decimal amounts, idempotency and reconciliation |
| Inventory | GET/POST `/inventory/items`, `/inventory/locations`, `/inventory/policies`; GET `/inventory/stock`, `/inventory/lots`, `/inventory/movements` | Catalogue, scope-aware balances and immutable movement history |
| Inventory commands | POST `/inventory/receipts`, `/inventory/issues`, `/inventory/reservations`, `/inventory/requisitions`, `/inventory/transfers`, `/inventory/counts`, `/inventory/adjustments`, `/inventory/recalls` | Idempotent stock commands, FEFO issue and separation of duties |
| Assets | GET/POST `/inventory/assets`; POST `/inventory/assets/{id}/events` | Asset lifecycle state machine and technical service release |
| Inventory reports | GET `/inventory/reports/{report}` | Role-scoped operational reports; CSV export records `inventory_export_audit` |
| Content | GET `/content`, `/content/{id}`, `/content/bookmarks/mine`; POST/DELETE `/content/{id}/bookmark`; POST `/content/{id}/report`; GET/PUT `/content/preferences/mine` | Audience- and visibility-scoped published feed without draft leakage |
| Dashboards | GET `/dashboards/patient`, `/dashboards/clinician`, `/dashboards/specialist` | Permission-aware aggregates, assigned work and scoped content |
| Editorial | GET/POST `/content/editorial/items`; PATCH `/content/editorial/items/{id}`; POST `.../review`, `.../publish`, `.../archive` | Draft, independent review and publication with expected versions |
| Opportunities | GET `/opportunities`; POST `/opportunities`; POST `/opportunities/{id}/submit`, `/moderate` | Verified listings with independent moderation |
| Access governance | GET/POST `/admin/role-grants`; POST `/admin/role-grants/{id}/decision`; GET/POST `/admin/care-team`; POST `/admin/care-team/{id}/revoke`; GET `/admin/access-review` | Time-bound grants, independent approval and recertification evidence |
| Public health | POST `/public-health/reports` | Approved dataset and purpose, aggregate-first |
| Telehealth | POST `/consultations/{id}/join-token` | Short-lived participant-scoped token after eligibility check |
| Devices | POST `/integrations/devices/observations` | Signed adapter ingestion and device assignment validation |
| Alerts | POST `/alerts/{id}/acknowledgements` | Actor acknowledgement and escalation state, no therapy command |
| AI | POST `/ai/jobs`; GET `/ai/jobs/{id}` | Async evidence-scoped job with task-specific eligibility |
| Review | POST `/ai/jobs/{id}/reviews` | Accept/reject/edit decision; explicit separate chart commit |
| Audit | GET `/patients/{id}/access-history` | Patient-appropriate disclosure view |
| Export | POST `/exports`; GET `/exports/{id}` | Authorized job, recheck before delivery and short expiry |

## Event envelopes

Internal events include `eventId`, `schemaVersion`, `eventType`, `tenantId`, restricted `patientRef` where necessary, `aggregateId`, `aggregateVersion`, `occurredAt` and `correlationId`. Keep PHI out of queue payloads when a scoped opaque pointer suffices. Consumers retrieve authorized content at execution time. Authenticate webhooks, verify timestamp/signature, reject replay outside a defined window and record delivery IDs. Notifications use generic text and route recipients to an authenticated portal.

## Contract examples

An amendment command contains `expectedVersion: 3`, a meaningful `changeNote`, the corrected content, and the clinical occurrence time if corrected. Server derives author, source tenant, recorded time, version and audit metadata. A read request cannot override any of those fields. Example JSON schemas are illustrative contracts and require domain-specific clinical fields before production use.

## Standard and adapter API families

Keep `/api/v1` for native operations, `/fhir/r4` for selected FHIR resource interactions, `/terminology/fhir/r4` for supported terminology operations, and an authorized `/dicomweb` gateway or approved private PACS base for imaging. Exact standard semantics belong to documents 19 and 20 and current pinned specifications. Native idempotency/error conventions do not automatically replace FHIR or DICOM conventions.

Require `/fhir/r4/metadata`; restricted resource read/search; tested version/history where enabled; CodeSystem lookup/code validation; ValueSet expansion/member validation; reviewed ConceptMap translation; and M2 QIDO/WADO/STOW. Standard writes must never bypass signed-record amendment notes or audit. `specs/openapi-standards.json` is a starter discovery/terminology path contract, not a full replacement for FHIR profiles or a DICOM conformance statement.
