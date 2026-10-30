# Gap Matrix: BK01–BK20

| ID | Milestone | Title | Status | Evidence | Remaining Work |
| :--- | :--- | :--- | :--- | :--- | :--- |
| BK01 | M0 | Repository assessment | Verified | `IMPLEMENTATION_LOG.md` | None. |
| BK02 | M0 | DB roles & CI | Verified | `packages/db/migrations/` | None. |
| BK03 | M1 | Identity MFA/revocation | Verified | `apps/api/src/routes/auth.ts` | None. |
| BK04 | M1 | Patient registration | Verified | `apps/api/src/routes/reception.ts` | None. |
| BK05 | M1 | Encounters/Audit | Verified | `apps/jobs/src/outbox.ts` | None. |
| BK06 | M1 | Consent exchange | Verified | `apps/api/src/routes/exchange.ts` | None. |
| BK07 | M1 | Credential evidence | Partial | `apps/api/src/routes/credentials.ts` | Expiry edge cases. |
| BK08 | M1 | Outbox checkpoints | Verified | `apps/jobs/src/outbox.ts` (reclaim verified) | None. |
| BK09 | M2 | Inpatient/Emergency | Verified | `apps/web/src/pages/EmergencyPage.tsx` | Clinical sign-off. |
| BK10 | M2 | Diagnostics workflow | Verified | `integrations/dicomweb.ts` | PACS labs mapping. |
| BK11 | M3 | Finance/Inventory | Partial | `apps/web/src/pages/FinancePage.tsx` | Implement notification delivery. |
| BK12 | M4 | Telemedicine/Devices | Partial | `apps/api/src/routes/devices.ts` | Integration registry update. |
| BK13 | M5 | AI/Radiology AI | Partial | `apps/api/src/routes/ai.ts` | Model validation. |
| BK14 | M5 | Ledger adapter | Not Started | — | Governance and anchoring. |
| BK15 | M0 | Standards baseline | Verified | `specs/standards-traceability.csv` | None. |
| BK16 | M1 | FHIR Facade | Partial | `apps/api/src/routes/fhir.ts` | AT27–AT31 validation. |
| BK17 | M2 | DICOMweb PACS | Verified | `integrations/dicomweb.ts` | None. |
| BK18 | M4 | LOINC/UCUM | Not Started | — | Observation export mapping. |
| BK19 | M5 | AI version compat | Not Started | — | Code-aware AI mapping. |
| BK20 | M1+ | Operational resilience | Partial | `RESILIENCE_RUNBOOK.md` | Credential rotation drill. |
