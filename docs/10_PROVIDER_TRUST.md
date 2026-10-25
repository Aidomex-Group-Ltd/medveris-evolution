# Provider credentials and capability evidence

## Principles

Registration is free and credential submission is optional. Account registration, directory publication, credential verification, permission to perform a regulated action and demonstrated clinical competence are distinct decisions. Unverified facilities can manage onboarding and nonclinical account functions. Production clinical actions require the adopted role and jurisdiction policy; optional upload does not waive applicable licensing obligations.

## Credential lifecycle

Draft → submitted → quarantined → verification-pending → verified/rejected. Verified evidence can later become expired, revoked, suspended or superseded. A new upload creates a new document version. Capture subject, credential type, issuing authority, jurisdiction, number, permitted specialty/scope, issue/expiry dates, verification method, source reference, reviewer, decision time and reason. Keep evidence private; publish only approved verification facts.

Verify against an authoritative register or a documented direct issuing-authority process when available. Manual review must record what was actually checked. If an issuer is inaccessible, use pending/unverified, not verified. OCR can extract fields but cannot establish authenticity. Do not assume every country or profession has an accessible verification API.

## Facility capability model

Represent a service capability as a claim with evidence: clinical service, facility/site, available equipment, trained staff, operating hours, emergency referral arrangements, applicable facility authorization and last review. Distinguish reported availability from inspected/verified availability. A facility license alone does not establish CT scanner availability, NICU readiness or surgical outcomes. Link practitioner scope only to the relevant individual and active facility relationship.

Public labels may include “License verified as of [date]”, “License expired”, “Documents submitted” and “Capability self-reported”. Do not use “safe”, “competent” or “approved for all services” merely because a file was uploaded. Avoid a single opaque trust score; if a future score is adopted, publish inputs, limitations, freshness, appeals and anti-gaming controls.

## Workflow controls

Separate submitter and verifier for consequential verification decisions. Require review evidence, expiry recalculation, scheduled rechecks and change audit. At request time evaluate expiry, not just a nightly job. Notify account owners about missing or expiring credentials without publicizing private documents. Provide correction, appeal and revocation workflows. Suspend affected regulated permissions according to approved policy with a care-continuity handoff; do not delete clinical history or silently abandon active patients.

## Acceptance

An unverified signup cannot acquire a verified badge. A reviewer cannot verify their own submission. A verified practitioner does not automatically verify their facility. An expired credential changes public status and affected permissions even when a scheduler has failed. All decisions retain reviewer, evidence reference, dates and reason.

## Standard identity and verification API mapping

Map facilities, locations, practitioners and active roles to appropriate FHIR Organization, Location, Practitioner and PractitionerRole projections. Credential and qualification fields retain issuer, dates, jurisdiction and evidence scope; FHIR serialization does not itself verify them. Use supported authoritative licensing APIs only through a documented adapter and keep manual pending/review states where no verified API exists. SNOMED-coded specialties or services require approved mappings; coded labels are not proof of competence.
