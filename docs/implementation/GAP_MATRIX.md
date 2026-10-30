# Gap Matrix: BK01–BK20

Status date: 30 October 2026. Verified work packages cite tests that ran against the current code.

| ID | Milestone | Title | Status | Evidence | Remaining Work |
| :--- | :--- | :--- | :--- | :--- | :--- |
| BK01 | M0 | Repository assessment | Verified | `IMPLEMENTATION_LOG.md` | None. |
| BK02 | M0 | DB roles & CI | Verified | `packages/db/migrations/` | Hosted CI has not executed; local gates pass. |
| BK03 | M1 | Identity MFA/revocation | Verified | `apps/api/src/routes/auth.ts` | None. |
| BK04 | M1 | Patient registration | Verified | `apps/api/src/routes/reception.ts` | None. |
| BK05 | M1 | Encounters/Audit | Verified | `apps/jobs/src/outbox.ts`, `tests/integration/reliability.test.ts` (idempotent encounters) | None. |
| BK06 | M1 | Consent exchange | Verified | `apps/api/src/routes/exchange.ts` | None. |
| BK07 | M1 | Credential evidence | Verified | `apps/api/src/routes/credentials.ts`, `tests/integration/onboarding.test.ts` (AT25) | None. |
| BK08 | M1 | Outbox checkpoints | Verified | `apps/jobs/src/outbox.ts` (reclaim verified) | None. |
| BK09 | M2 | Inpatient/Emergency | Verified | `apps/web/src/pages/EmergencyPage.tsx`, `tests/integration/reliability.test.ts` (bed allocation) | Clinical sign-off. |
| BK10 | M2 | Diagnostics workflow | Verified | `tests/integration/departments.test.ts`, `apps/api/src/routes/diagnostics.ts` | External LIS/analyzer connection not requested. |
| BK11 | M3 | Finance/Inventory | Verified | `apps/api/src/routes/notifications.ts`, `packages/db/migrations/038_notifications.sql`, `tests/integration/notifications.test.ts` | None. |
| BK12 | M4 | Telemedicine/Devices | Partial | `apps/api/src/routes/devices.ts`, `tests/integration/terminology.test.ts` | Device metric LOINC/UCUM validation added; media adapter and verified device gateway remain unconfigured. |
| BK13 | M5 | AI/Radiology AI | Partial | `apps/api/src/routes/ai.ts` | No model provider or clinical validation. |
| BK14 | M5 | Ledger adapter | Not Started | — | External WORM/ledger provider and governance. |
| BK15 | M0 | Standards baseline | Verified | `specs/standards-traceability.csv` | None. |
| BK16 | M1 | FHIR Facade | Verified | `apps/api/src/fhir/`, `tests/integration/{fhir,terminology}.test.ts` (AT27–AT31) | External FHIR validator not run. |
| BK17 | M2 | DICOMweb PACS | Verified | `integrations/dicomweb.ts`, `tests/integration/pacs.test.ts` | Available only after a recorded passing conformance run against the configured PACS; STOW-RS not implemented. |
| BK18 | M4 | LOINC/UCUM | Verified | `apps/api/src/terminology/`, `apps/api/src/routes/{diagnostics,devices}.ts`, `tests/integration/terminology.test.ts` | Reviewed specimen/method/unit ConceptMaps, contextual LOINC/UCUM validation and Observation export mapping. |
| BK19 | M5 | AI version compat | Not Started | — | Code-aware AI mapping; requires an inference provider. |
| BK20 | M1+ | Operational resilience | Partial | `RESILIENCE_RUNBOOK.md` | Credential rotation drill. |
