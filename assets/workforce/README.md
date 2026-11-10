# Medveris Workforce Reference Data

This directory contains centrally governed workforce reference datasets used throughout Medveris for staff onboarding, professional classification, clinical capability assignment, credential verification, HR management, and payroll integration.

## Datasets

| File | Description | Records |
|------|-------------|---------|
| `professional-cadres.json` | Professional cadres (Medical Officer, Nurse, Pharmacist, etc.) | 69 |
| `clinical-specialties.json` | Clinical specialties linked to cadres | 32 |
| `clinical-capabilities.json` | Clinical capabilities and privileges | 35 |
| `governance-reference.json` | Regulatory bodies and verification rules | 9 |
| `departments.json` | Department classifications | 35 |

## Governance

These are **reference sources**, not authorization authorities. The backend must validate all selections against approved reference records in the database.

- **Global canonical data** — Managed by platform administrators
- **Facility extensions** — Facilities can add local titles/cadres where permitted
- **Versioning** — All changes are versioned and auditable
- **Effective dating** — Changes can be future-dated

## Integration

All modules must consume the shared reference data service, not duplicate lists locally.

## Validation

Before using in production:
- Verify regulatory body mappings with competent authorities
- Confirm specialty-cadre relationships
- Review cadre categories and ISCO-08 mappings
- Validate payroll grade structures with facility HR
- Confirm clinical capability assignments with clinical governance

## License

These datasets are engineering seeds for demonstration. They do not claim to be exhaustive or legally authoritative registers.
