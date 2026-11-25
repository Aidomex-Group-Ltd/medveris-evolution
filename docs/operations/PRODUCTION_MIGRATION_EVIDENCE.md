# Production Migration Evidence

Date: 2026-11-23
Repo: `/home/aidomex/medveris`
Safety: read-only production evidence; no migration, deployment, secret, or patient-data change was made.

## 1. Scope

This report covers migrations `139`–`146`, the local verification database, the production ledger, and the exact disposition states required for the patient-data readiness effort.

Disposition states used below: `SOURCE REVIEWED`, `SOURCE TESTED`, `APPLICATION BLOCKED`, `APPLIED TO LOCAL TEST DATABASE`, `VERIFIED IN LOCAL TEST DATABASE`, `APPLIED TO STAGING`, `VERIFIED IN STAGING`, `APPLIED TO PRODUCTION`, `VERIFIED IN PRODUCTION`.

## 2. Evidence snapshots

| Evidence | Path | Time |
|---|---|---|
| Local DB catalog | `/tmp/ready/phaseA/local-db-verification.out` | `2026-11-23T16:17:13Z` |
| Production catalog, migrator | `/tmp/ready/phaseA/production-catalog.out` | `2026-11-23T16:20:01Z` |
| Production aggregate counts, admin | `/tmp/ready/phaseA/production-admin-medveris-prod.out` | `2026-11-23T16:21:56Z` |
| Lint | `/tmp/ready/phaseA/lint.out` | `rc=0` |
| Typecheck | `/tmp/ready/phaseA/typecheck.out` | `rc=0` |
| Gate unit test | `/tmp/ready/phaseA/production-gate-test.out` | `26/26` |
| Platform-role test | `/tmp/ready/phaseA/platform-role-guc-test.out` | `6/6` |
| RLS test | `/tmp/ready/phaseA/rls-test.out` | `6/6` |
| Patients test | `/tmp/ready/phaseA/patients-test.out` | `9/9` |

## 3. Ledger and environment comparison

| Environment | Database | PostgreSQL | Ledger rows | Numeric latest | `139`–`146` present |
|---|---|---:|---:|---:|---:|
| Local verification | `medveris_test` | `14.24` | `97` | `146` | Yes |
| Production | `medveris-prod` | `18.6` | `89` | `138` | No |

Production aggregate counts at `2026-11-23T16:21:56Z` resolve earlier conflicting counts:

| Table | Count |
|---|---:|
| tenants | `3` |
| users | `6` |
| memberships | `2` |
| patients | `4` |
| sessions | `4` |
| audit_events | `17` |
| patient_accounts | `0` |
| tenant_patient_links | `0` |
| exchange_grants | `0` |
| outbox_events | `0` |
| integration_clients | `0` |
| integration_tokens | `0` |

No patient values, secret values, or row contents were exported.

## 4. Migration disposition table

| Migration | Purpose | Source / local state | Production state | Production closure command and expected result |
|---|---|---|---|---|
| `139_memberships_rls_hardening.sql` | Membership RLS hardening, invitation re-activation policy | `SOURCE REVIEWED`; ledger present in local test DB; no separate full migration replay done this session | `APPLICATION BLOCKED`; not in production ledger | `psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from schema_migrations where version='139_memberships_rls_hardening.sql'"` → `1` |
| `140_integration_tokens_tenant_scope.sql` | Replace unconditional token policy; grant `SELECT` on `integration_clients` to `medveris_exchange` | `SOURCE REVIEWED`; local policy catalog shows scoped `INSERT/SELECT/UPDATE` policies and no unconditional token `ALL` | `APPLICATION BLOCKED`; production still has `integration_tokens_all` with `qual=true`, `with_check=true` | `psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_policies where schemaname='public' and tablename='integration_tokens' and cmd='ALL' and qual='true' and with_check='true'"` → `0` |
| `141_all_policy_delete_overgrant_split.sql` | Split broad `ALL` policies | `SOURCE REVIEWED`; ledger present locally; no isolated replay this session | `APPLICATION BLOCKED`; production has `13` unconditional `ALL` policies | `psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_policies where schemaname='public' and cmd='ALL' and qual='true' and with_check='true'"` → `0` |
| `142_patient_scope_rls_hardening.sql` | Tenant-linked patient reads, active exchange grants, enrollment helper | `SOURCE REVIEWED`; `SOURCE TESTED`; `VERIFIED IN LOCAL TEST DATABASE` for RLS `6/6` and patients `9/9`; helper source at `packages/db/migrations/142_patient_scope_rls_hardening.sql:97`, owner change `:147`, grants `:148-153` | `APPLICATION BLOCKED`; production has broad `patients_staff_read`; no patient-enrollment helper found in production catalog | `npx vitest run --config vitest.config.ts tests/integration/rls.test.ts` → `0`; `npx vitest run --config vitest.config.ts tests/integration/patients.test.ts` → `0`; production catalog must show helper and tenant-linked policy |
| `143_remaining_rls_overgrant_hardening.sql` | Remaining write/audit/outbox/metrics policy hardening | `SOURCE REVIEWED`; local policy includes `sponsored_metrics_anonymous_read` at `packages/db/migrations/143_remaining_rls_overgrant_hardening.sql:87-88`; no isolated replay this session | `APPLICATION BLOCKED`; not in production ledger | Production catalog diff against reviewed local tree → no unexplained gaps |
| `144_global_catalogue_read_hardening.sql` | Global catalogue read hardening | `SOURCE REVIEWED`; ledger present locally; no isolated replay this session | `APPLICATION BLOCKED`; not in production ledger | Production catalog diff against reviewed local tree → no unexplained gaps |
| `145_platform_role_guc_hardening.sql` | DB-backed platform-role checks | `SOURCE REVIEWED`; `SOURCE TESTED`; `VERIFIED IN LOCAL TEST DATABASE` by `platform-role-guc.test.ts` `6/6` | `APPLICATION BLOCKED`; production has DB-backed `app.is_platform_operator()` but also legacy GUC functions and `3` direct `current_setting` policies | `npx vitest run --config vitest.config.ts tests/integration/platform-role-guc.test.ts` → `0`; production direct `current_setting` policy count → `0` |
| `146_integrity_rls_and_guards.sql` | RLS and guards for integrity/ledger tables | `SOURCE REVIEWED`; local RLS-disabled list excludes integrity tables; audit-read RLS test passes | `APPLICATION BLOCKED`; production `integrity_checkpoints`, `integrity_checkpoint_events`, `ledger_anchors` have RLS disabled | `psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('integrity_checkpoints','integrity_checkpoint_events','ledger_anchors') and not c.relrowsecurity"` → `0` |

## 5. Required production migration gate

All eight versions must be present before any real-patient approval:

```bash
psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from schema_migrations where version in ('139_memberships_rls_hardening.sql','140_integration_tokens_tenant_scope.sql','141_all_policy_delete_overgrant_split.sql','142_patient_scope_rls_hardening.sql','143_remaining_rls_overgrant_hardening.sql','144_global_catalogue_read_hardening.sql','145_platform_role_guc_hardening.sql','146_integrity_rls_and_guards.sql')"
```

Expected: `8`. Current production result: `0`.

## 6. Decision

- `APPLIED TO PRODUCTION`: none.
- `VERIFIED IN PRODUCTION`: none.
- `APPLICATION BLOCKED`: all eight pending migrations.
- Migration parity remains a critical go-live blocker (`IND-01`, `DB-CRIT-01`).
- No migration was applied in this session; manual ledger edits remain prohibited.
