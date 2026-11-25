# MedVeris — Database Migration Reconciliation

- **Date:** 2026-11-25
- **Repo:** `/home/aidomex/medveris`

## Ledger comparison
| Environment | DB | PG | Ledger | Latest | `139`–`146` present |
|---|---|---:|---:|---:|---|
| Local | `medveris_test` | 14.24 | 97 | 146 | Yes |
| Production | `medveris-prod` | 18.6 | 89 | 138 | **No** |

## Reconciliation matrix (139–146)

| migration_id | local_status | production_status | checksum | dependencies | schema_effect | security_impact | remediation | verification |
|---|---|---|---|---|---|---|---|---|
| `139_memberships_rls_hardening` | SOURCE REVIEWED; applied local | **APPLICATION BLOCKED** | checker absent | `app.memberships_tenant_has_any` (SE DEF) | narrow membership writes | write narrowing | apply in approved window | prod ledger → 1 |
| `140_integration_tokens_tenant_scope` | SOURCE REVIEWED; applied local | unconditional ALL remains | absent | token sync trigger | tenant-scoped tokens | token blast radius | apply | unconditional ALL → 0 |
| `141_all_policy_delete_overgrant_split` | SOURCE REVIEWED; applied local | 13 unconditional ALL remain | absent | `app.rls_migration_3b_policy_backup` | ALL → cmd-specific | DELETE overgrant | apply | unconditional ALL → 0 |
| `142_patient_scope_rls_hardening` | SOURCE TESTED; verified local | broad staff reads; no helper | absent | exchange_grants/links | tenant-scoped patients | grant gating | apply | helper + policy |
| `143_remaining_rls_overgrant_hardening` | SOURCE REVIEWED; applied local | **APPLICATION BLOCKED** | absent | audit/outbox/metrics | write narrowing | audit integrity | apply | catalog parity |
| `144_global_catalogue_read_hardening` | SOURCE REVIEWED; applied local | **APPLICATION BLOCKED** | absent | reference tables | dead branches removed | catalogue exposure | apply | catalog parity |
| `145_platform_role_guc_hardening` | SOURCE TESTED; verified local | legacy GUC + direct current_setting | absent | platform_roles | DB-backed checks | GUC forgery | apply | direct GUC policies → 0 |
| `146_integrity_rls_and_guards` | SOURCE REVIEWED; applied local | integrity RLS disabled | absent | audit/ledger | integrity RLS + invariants | audit tamper | apply | RLS-disabled → 0 |

## Required execution (prepared, NOT executed)
```bash
psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from schema_migrations where version in ('139_memberships_rls_hardening.sql','140_integration_tokens_tenant_scope.sql','141_all_policy_delete_overgrant_split.sql','142_patient_scope_rls_hardening.sql','143_remaining_rls_overgrant_hardening.sql','144_global_catalogue_read_hardening.sql','145_platform_role_guc_hardening.sql','146_integrity_rls_and_guards.sql')"
```
Expected `8`; production currently `0`. Apply via `npm run db:migrate` with `--confirm-database=medveris_prod` under operator approval.

## Dispositions
- `MIG-001`: `AWAITING_OPERATOR_APPROVAL`. `MIG-002`: `OPEN` (checksum checker pending). `MIG-003`: `VERIFIED_LOCALLY`. `MIG-004`: `AWAITING_OPERATOR_APPROVAL` (commit pending).
- `LOC-001`: `VERIFIED_LOCALLY`.
