# Interoperability & identity posture (Phase 3 verification, 2026-11-12)

Truthful status of the interoperability and patient-identity capabilities required by the
authentication/interoperability/security/observability refactoring program (Phase 3).
"Implemented" means code exists in this repository with the stated scope; "not implemented"
is stated plainly — nothing here claims capabilities that do not exist.

## Patient identity (MPI / reconciliation)

| Capability | Status | Evidence |
|---|---|---|
| Facility-scoped patient identity with `merged_into` redirect | implemented (synthetic data) | `apps/api/src/routes/patient-merge.ts`; two-person approval (approver ≠ requester); blockers via `app.patient_merge_blockers()` (cross-facility link, portal account, active exchange grant, active proxy); source demographics snapshot; reversal supported; audited (`patient.merge.*`) |
| Write-time duplicate detection at registration | implemented | `apps/api/src/routes/reception.ts` (exact family-name + DOB same-facility match → `patient_duplicate_candidates`) |
| Staff duplicate review workflow | implemented | `apps/api/src/routes/admin.ts` (`/admin/duplicate-candidates`) |
| Partner/machine patient match (never auto-links) | implemented | `apps/api/src/routes/integrations.ts` (score: public_id=100, name+dob=90, name=60, else 40; human/manual link only) |
| Tenant-scoped global identity directory with facility care links | implemented | `packages/db/migrations/001_foundation.sql` (`tenant_patient_links`); ADR `docs/decisions/0002-global-directory-and-tenant-links.md` |
| Exact-match resolution with merged-identity awareness | implemented | reception `POST /patients/resolve` (exact public ID + family name + DOB) |
| Cross-facility/system-of-record merge | **not implemented (by design)** | tenant silos are absolute; no cross-tenant merge path exists or is planned |
| Probabilistic/demographic scoring (e.g. Fellegi–Sunter) | **not implemented** | only exact/substring heuristics; no scoring engine |
| Automated MPI reconciliation job | **not implemented** | no background matcher exists |
| MEDITECH (or any external system-of-record) integration | **not present anywhere in the codebase** | zero references; `REFACTOR.md` requirements name it — it must be specified and contracted before implementation |
| Production identity proofing of patients | **not implemented** | email verification only; see `docs/IMPLEMENTATION_GAPS.md` (item 12) |

## Consent management and exchange

| Capability | Status | Evidence |
|---|---|---|
| Patient-granted, tenant-scoped exchange consent (`exchange_grants`) | implemented | `apps/api/src/routes/consent.ts`; validated recipient tenant, per-source `release_signed_records` links, `expires_at > starts_at > now`; immediate effect of revocation (read-time denial); audited (`consent.grant.create|revoke`); outbox events |
| Recipient-side grant list and grant-validated record projection | implemented | `GET /exchange/grants`, `GET /exchange/patients/:publicId/records?grantId=`; projection via `app.exchange_project()` SECURITY DEFINER with sensitivity exclusions; every read audited with allow/deny + `reasonCode` |
| Clinician-initiated referral-scoped sharing | implemented | `POST /care/referrals/:id/share[/revoke]` → `app.create_referral_share()` / `app.revoke_referral_share()` |
| Consent expiry sweep/notification job | **not implemented** | expired grants are denied at read time; no sweep or patient notification exists |
| Post-revocation propagation to recipients | **not implemented** | revocation takes effect for new reads; no push/recall mechanism (none exists for any consent state) |
| `consent_grants` single-use hashed-token table (Phase 11 design) | **migrated, unused dead schema** | `packages/db/migrations/128_patient_access_privacy.sql`; enforcement pending Phase 11.3/11.4 |
| Automated tests for grant/revoke flows | **none** | highest-risk flow in this document; needs a prepared test DB or harness |

## Emergency break-glass access

| Capability | Status | Evidence |
|---|---|---|
| Justification + reauthentication (password + TOTP) | implemented | `POST /patients/:patientId/emergency-overrides` in `apps/api/src/routes/consent.ts` |
| Time limitation (default 60 min; `EMERGENCY_OVERRIDE_MINUTES`) | implemented | `apps/api/src/config.ts` (`emergencyOverrideMinutes` default 60; `emergencyReviewDueHours` default 24) |
| Role restriction (clinician/nurse + enrolled & verified MFA) | implemented | `canUseEmergencyOverride()` in `packages/authz/src/index.ts` |
| Mandatory justification, high-severity audit trail | implemented | audit `emergency.override.create` + outbox; hash-chained audit (`lib/audit.ts`) |
| Post-access review workflow (acceptable/escalated, ≥5-char note, review-due window) | implemented | `GET /emergency-overrides`, `POST /emergency-overrides/:id/review` (facility_admin/auditor only, pending-only) |
| **Override revocation route** | **implemented 2026-11-12 (Phase 3)** | `POST /emergency-overrides/:id/revoke` (requester or facility_admin/auditor; mandatory reason; audit `emergency.override.revoke`; outbox `emergency.override.revoked`); migration `129_emergency_override_revocation.sql` (`revoked_by`, `revoked_reason`; dry-run validated) |
| Emergency projection excludes sensitive categories | implemented | `app.emergency_project()` excludes mental-health, reproductive-health, genetic, HIV |
| Patient notification after emergency access | **not implemented** | `docs/02_ROLES_AND_ACCESS.md` policy requires it; no sender exists (policy gap) |
| Review-due escalation/sweep | **not implemented** | no scheduler references `emergency_overrides`; reviews only surface via the governance list endpoint |
| Automated tests for the override flow | **partial (2026-11-12)** | predicate/schema/matrix unit coverage added (`tests/unit/emergency-override.test.ts`); full request-flow coverage needs a prepared test DB |

## Clinical data synchronization

| Capability | Status | Evidence |
|---|---|---|
| Transactional outbox + relay (Cloudflare Queues) with backoff/DLQ/replay | implemented | `apps/api/src/lib/audit.ts` (`writeOutbox`), `apps/jobs/src/{outbox,queue,cycle,replay,exports,integrity}.ts`, `apps/api/src/worker.ts` |
| Identifier-only queue messages (no PHI/payload) | implemented | `apps/jobs/src/contracts.ts`; tested in `tests/integration/jobs-queue.test.ts` |
| Poison-message isolation, stale-claim reclaim, per-tenant fair claiming | implemented | `apps/jobs/src/outbox.ts`; integration tests exist |
| Realtime fan-out to web clients (event type + ref only) | implemented, best-effort/lossy by design | `apps/api/src/realtime/*`, `durable/realtime-hub.ts` |
| **Real-time clinical data synchronization** | **does not exist** | no inbound clinical feed, no FHIR client against partners/MEDITECH, no sync engine; only aggregate eHMIS/DHIS2 reporting outbound (`apps/api/src/routes/ehmis.ts`, `integrations/dhis2.ts`) and manual bulk import/export (`routes/data-exchange.ts`) |
| Sync failure/conflict handling | partial: retries, backoff, DLQ, dead-letter replay for events; HTTP 409 optimistic concurrency for records; signed-version immutability for amendments | `lib/http.ts` (409), ADR 0003, migration 001 triggers; there is nothing to reconcile because no live sync exists |
| Conflict detection/resolution for concurrent record edits | partial: `expectedVersion` 409s + immutable signed versions + amendment workflow | no automatic merge/three-way resolution (intentionally not attempted) |
| DICOM identity mismatch handling | implemented (refuse-to-link without recorded reason) | `apps/api/src/routes/radiology.ts` `compareIdentity()`; tested |

## Standards posture (HL7 FHIR, ICD-11, LOINC, SNOMED CT, DICOMweb, UCUM)

| Standard | Status | Notes |
|---|---|---|
| HL7 FHIR R4 4.0.1 | partial, read-only facade | `/fhir/r4` — Patient, Organization, Practitioner(Role), Encounter, Observation, Condition, AllergyIntolerance, DocumentReference, Consent, Provenance, AuditEvent; `read`/`search-type` only; no writes, no transactions, no `$everything`, no SMART-OAuth, no bulk; honest `CapabilityStatement` (`status: draft`, `experimental: true`); cross-tenant isolation via `tenant_patient_links`; tests AT27/AT28 |
| FHIR version pinning / CapabilityStatement truthfulness | implemented | metadata reflects exactly what is served |
| ICD-11 | **not implemented — zero code references** | blocked on external access/licensing and mapping-governance decisions; do not represent as supported |
| LOINC | implemented within non-licensed adapters | `terminology/local-reference.ts` (curated catalogue; "not a licensed LOINC distribution"; lab ConceptMap with specimen/method/unit context) and `terminology/synthetic.ts`; production path = generic FHIR terminology server adapter (`terminology/production.ts`) requiring a configured external server and licensed content; UCUM units carried on `observations` |
| SNOMED CT | implemented within non-licensed adapters | same adapters (`local-reference`/`synthetic`); pinned to local catalogue versions; **no SNOMED CT licence is configured**; territory/licensing decides production posture |
| DICOMweb | partial | QIDO-RS search (validated matching keys, UID regex, limit ≤ 100), WADO-RS rendered frames only (jpeg/png, size-capped, timeouts), **STOW-RS not implemented** ("Medveris does not upload or modify studies", `docs/22_PACS_DICOMWEB_RUNBOOK.md`); PACS-gated behind `requirePacs()` + `integrationStatus("dicomweb")` verification; identity-mismatch link refusal; frame relay not cached; tests `tests/integration/pacs.test.ts` |
| Terminology service architecture | implemented | `terminology/index.ts` factory (`unavailable` fail-closed / `local-reference` / `production` / `synthetic`); `terminology/router.ts` — `$lookup`, `$validate-code`, `$expand`, `$translate` over FHIR R4; all session-gated; tests AT29/AT30 |
| eHMIS / DHIS2 aggregate reporting | implemented (aggregate only, no patient-level data) | `routes/ehmis.ts`, `integrations/dhis2.ts`; validate→approve→export state machine, dry-run |

## What "done" would require for the full Phase 3 requirements (not claimed)

1. A specified and contracted MEDITECH bridge (scope, direction, auth, identity reconciliation rules) with synthetic-test evidence.
2. A real-time sync engine with durable conflict semantics, or an explicit decision to remain event-outbox + manual exchange (current architecture) with documentation updates.
3. Licensed/entitled ICD-11 and SNOMED CT content plus a versioned mapping governance process; LOINC licence where required by redistribution terms.
4. STOW-RS (or documented decision to never store imaging) and full QIDO/WADO conformance testing against a PACS.
5. Automated test harness for consent/break-glass request flows (prepared test DB), patient notification and review-due escalation for break-glass, consent expiry sweep.
6. Governance sign-off (DPIA) before any production exposure of patient-facing release (Phase 11 sequencing applies).

## Verification summary (2026-11-12)

- `npm run typecheck` — pass; targeted `eslint` on changed files — pass; full unit suite 828/828 pass (including 9 new break-glass tests and 7 aligned billing-enforcement characterization tests).
- Migration 129 dry-run inside BEGIN…ROLLBACK — pass (dev DB unchanged).
- No runtime chain behavior change beyond the additive revoke route, matrix binding and catalog grants.
