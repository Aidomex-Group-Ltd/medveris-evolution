# ADR 0002: Minimal global patient directory with facility links

- Status: accepted for M1
- Date: 25 October 2026

## Context

A patient needs one longitudinal identity across facilities, while clinical content and facility operations must remain tenant-isolated. Patient search must not become an open directory.

## Decision

Keep `patients` as a minimal global identity directory and `tenant_patient_links` as the care relationship. Chart, worklist, FHIR Patient and exchange access require a link in the active tenant, except patient self-access. Native resolution requires the exact public ID plus family name and date of birth, is rate-limited and audited. Cross-facility chart delivery uses grant-validated SECURITY DEFINER projections, not direct table reads.

## Consequences

- Duplicate detection and resolution can operate across the directory.
- Staff SELECT on the directory is broader than ideal; a future migration should move exact lookup and duplicate checks into narrow SECURITY DEFINER functions.
- Internal patient UUIDs and public IDs never by themselves grant chart access.
