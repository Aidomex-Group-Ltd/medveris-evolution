# MedVeris — RLS and Database Security Review

- **Date:** 2026-11-25
- **Repo:** `/home/aidomex/medveris`

## Scope
Raw local staging inspection (`medveris_test`) via `docs/security/rls-phase1-report.md`; remediation migrations `139`–`146`.

## Key findings
- **FLAG A (fixed by migration 145):** invoker `app.*` GUC readers were used for authorization (`has_any_role`, identity readers, `is_content_editor`). Migration `145` replaces forgeable GUC gates with DB-backed `platform_roles` checks and migrator-only bootstrap.
- **FLAG B:** outbox/backlog and security summaries are DEFINER reads without tenant scope — reviewed as jobs/ops aggregation.
- **Item 1:** 31 broad membership policies replaced by narrow command-specific policies (`139`).
- **Item 2:** unconditional `integration_tokens_all` (`ALL true/true`) → tenant-scoped (`140`).
- **Item 4:** broad `patients_staff_read` → tenant-linked reads + enrollment helper (`142`).
- **Item 5:** open writes on metrics/payments/tokens; DELETE overgrants on 101 ALL policies (`141`, `143`).
- **Item 6:** GUC-based support-ticket/verification gates replaced (`145`); integrity/ledger RLS enabled (`146`).

## Local verification
- RLS suite: 6/6 pass. Patients suite: 9/9 pass. Platform-role GUC suite: 6/6 pass.
- Migration dry-runs (forward+rollback) passed; forged-GUC negatives all false; integrity checks pass.

## Production disposition
All remediated source is present locally; production catalog application/verification remains `AWAITING_OPERATOR_APPROVAL` (`RLS-001`…`RLS-007`).
