# Patient record self-access and consent-gated sharing — privacy architecture

Date: 2026-11-12 · Phase 11.1 (normative model). Companion to `REFACTOR.md` Phase 11.
This is an engineering design document, not legal advice. It must be reviewed by clinical governance and privacy officers before production use.

## 1. Regulatory anchors

| Instrument | Right | Engineering rule |
|---|---|---|
| Uganda Data Protection and Privacy Act, 2019 | Access; be informed of 3rd-party disclosures | Patient can list/read own finalized records; patient can see disclosure log |
| Uganda Patients' Charter | Patient information about own care | Patient-visible finalized documents, incl. imaging metadata and reports |
| GDPR Art. 15 | Access (incl. recipients/categories) | Same as right-of-access + disclosure log; exports machine-readable |
| HIPAA 45 CFR §164.524 / §164.528 | Access to PHI; accounting of disclosures | Same; accounting backed by hash-chained audit |

Patient = data subject. Provider = controller/custodian. Medveris must never implement "provider owns records" semantics.

## 2. Data classes and default visibility

| Class | Default visibility | Rule |
|---|---|---|
| Finalized/signed clinical resources (encounters, observations, diagnostics, reports, prescriptions, allergy records, immunizations, imaging metadata + signed reports) | **Patient-visible on sign** | `clinical_entries.status='signed'` ⇒ visible; `draft`/`entered-in-error` ⇒ not releasable until final |
| Unsigned/unverified drafts | Clinician-only | `unverified_draft` restriction reason; released on sign |
| Psychotherapy process notes | Never in record export | `psychotherapy_process_notes`; separate from `clinical_entry_versions` |
| Peer review / QA / litigation prep | Never in export | `peer_review_qa`, `litigation_prep` |
| Third-party confidential content | Excluded unless 3rd party consents | `third_party_confidentiality` |
| Therapeutic privilege restrictions | Excluded temporarily with mandatory reason + clinician sign-off + review | `therapeutic_privilege` |

## 3. restriction mechanics (`clinical_entries`, migration 128)

- `restricted_access boolean NOT NULL DEFAULT false`
- `restricted_reason_code text NULL` constrained to the frozen vocabulary
- CHECK constraint ties them: reason required iff restricted
- Restriction is **record-level**, applied at the service/query layer for patient-facing reads; never a client-supplied flag; auditable
- redaction output to patient shows "withheld by clinician" — reason never leaks to non-owners (auditors/privacy officer see full reason via audit log)
- Staff/clinician roles retain clinical visibility per existing policy; restriction affects **patient-facing** release only

## 4. Consent grants (migration 128)

```
consent_grants(id, tenant_id, patient_id, granted_to_tenant_id, granted_to_user_id,
               scope jsonb, purpose, starts_at, expires_at, revoked_at,
               token_hash char(64) [sha256 hex — raw token never stored],
               created_by, created_at)
```

- One-time redemption pattern: token presented once by receiving provider → hash matched → grant activated; stored hash enables revocation & expiry sweep
- Scope: resource kinds (`observations`, `reports`, `documents`…), purpose string, mandatory expiry (`expires_at`), optional `granted_to_user_id`
- Receiving side gets **read-only**, bounded, revocable access; never identity bulk export
- Patient may revoke any time; scheduled job revokes expired grants
- Every access via grant is written to the audit/disclosure log (scope, actor, tenant, timestamp, action class)

## 5. Emergency "break-the-glass"

- Endpoint requires clinician/nurse role + explicit emergency justification (mandatory text) + MFA
- Writes a high-severity audit event immediately (hash-chained) and enqueues **post-facto patient notification** (e.g. in-app + email/SMS per patient channel preferences)
- Facility admin/auditor review flag created automatically; all break-the-glass accesses are reviewable in a facility-scoped report
- Denied when actor unauthenticated/unverified; never silent

## 6. Patient disclosure log ("who accessed my record")

Served from existing hash-chained audit (`apps/api/src/lib/audit.ts`). Mapping (to be implemented in 11.3):

- Filter audit events where `patient_id = app.current_patient()` (or resolved via TenantPatientLink for app; restricted to own rows)
- Present: action class, service (ERPNext/HAPI/Medveris), approximate actor group (own care team vs facility vs external), timestamp, purpose
- Staff identifiers shown per existing directory policy; third parties listed by category only; never expose other patients/staff not already visible to the requester

## 7. Export

- Server-side FHIR JSON bundle (or PDF summary) generated on demand
- Delivered via short-lived authenticated token (single use, expiry ≤ 15 minutes), link never logged raw
- Export event audited (issuance + download); export contains only own data; restrictions applied

## 8. Verification plan (11.5)

- Unit: restriction vocabulary; reason required iff restricted
- Integration (needs prepared test DB): patient reads own finalized record; restricted note withheld with opaque reason; other tenant/patient 4xx; grant expiry/revocation denies; break-the-glass writes audit + notification task
- Property: token hash format enforced; no raw token persisted (schema CHECK); grant cannot outlive `expires_at` (job test)
- Regression: existing clinical flows unchanged when `restricted_access=false` (default)

## 9. Outstanding

- 11.3 implementation (API routes, FHIR release filter, disclosure-log endpoint, export)
- 11.4 implementation (grant issuance, receiving-side redemption, sweep job, break-the-glass)
- 11.5 identity assurance step-up (OTP/NIN/MFA) for export/release
- Governance sign-off + DPIA before any production exposure
