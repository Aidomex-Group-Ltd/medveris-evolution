# Consultation Professional Classification

**Date:** 2026-11-06
**Focus:** professional title / speciality classification in the
consultation and signing path.

## What exists

- `professional_designations` — an immutable snapshot table holding the
  practitioner's designation at the time a clinical document is signed
  (`designation_code`, `designation_name`, `category`,
  `specialty_codes`), keyed by `tenant_id`, `practitioner_staff_person_id`,
  `encounter_id`, `version`.
- `clinical_entry_versions.designation_code` — a nullable column that
  mirrors the designation at signing time so a signed document keeps the
  title/speciality it carried.

## Signing workflow

1. A clinician (the user carrying a role, e.g. `clinician`/`nurse`) opens
   an encounter that has been triaged to `in-progress`.
2. The clinician documents the note and submits it for signing.
3. At sign time the service inserts the professional designation snapshot
   for that signing event via `recordProfessionalDesignation`.
4. The signed version's `designation_code` is set to that snapshot, so the
   historical record is never rewritten later if a practitioner's
   catalogue assignment changes.

## Permission invariants

- Titles and specialities are **classification metadata only**.
- They do **not** grant permissions. Permission granting is done through
  roles assigned by the authorization layer, not by `professional_designations`.
- The snapshot table is tenant-scoped and RLS-protected for clinical reads
  plus system access for migrations and jobs.

## Open items before deployment

- Confirm migration `050_professional_designations.sql` is applied to the
  runtime database (see `production-recovery-deployment-checklist.md`).
- Confirm no permission grants reference the designation table or codes.
- Confirm the full global title/speciality catalogue tables and seed data
  (referenced by the earlier migration set) are present and consistent
  with the snapshot columns.
