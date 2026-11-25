# Production Security and RLS Evidence

Date: 2026-11-23
Repo: `/home/aidomex/medveris`
Safety: read-only production evidence; no grants, policies, roles, or data changed.

## 1. Evidence

| Evidence | Path |
|---|---|
| Production migrator catalog | `/tmp/ready/phaseA/production-catalog.out` |
| Production admin catalog | `/tmp/ready/phaseA/production-admin-medveris-prod.out` |
| Local DB catalog | `/tmp/ready/phaseA/local-db-verification.out` |
| RLS test | `/tmp/ready/phaseA/rls-test.out` |
| Platform-role test | `/tmp/ready/phaseA/platform-role-guc-test.out` |
| Patients test | `/tmp/ready/phaseA/patients-test.out` |

## 2. Production posture

| Check | Current production result | Disposition |
|---|---|---|
| Public tables | `280` | Observed |
| RLS-enabled tables | `270` | `APPLICATION BLOCKED` for the remaining `10` |
| FORCE RLS tables | `270` | `APPLICATION BLOCKED` for the remaining `10` |
| RLS-disabled tables | `auth_challenges`, `email_tokens`, `integrity_checkpoint_events`, `integrity_checkpoints`, `ledger_anchors`, `schema_migrations`, `sessions`, `tenants`, `usage_resources`, `users` | Critical where integrity/ledger included |
| Unconditional `ALL` policies | `13` | Critical; migration `141` pending |
| Runtime DELETE grants | `163` tables | Needs reviewed sign-off after `141`/`143`/`146` |
| `medveris_exchange` | `rolbypassrls=true`, member of `medveris_migrator` | Requires explicit SECURITY DEFINER review |
| `medveris_transfer_guard` | `rolbypassrls=true` | Requires explicit SECURITY DEFINER review |
| SECURITY DEFINER functions | `32`, mostly owned by `medveris_exchange`, all with `search_path=public, pg_temp` | Source-reviewed; not production-hardened |
| Direct `current_setting` policies | `3`: `integration_verifications_record`, `support_ticket_events_operator_all`, `support_tickets_operator_all` | `APPLICATION BLOCKED`; migration `145` pending |
| Legacy GUC helpers | `app.platform_roles_bootstrap()` and `app.legacy_elevate_available()` still read `current_setting` | `APPLICATION BLOCKED` |

Production `app.is_platform_operator()` is already DB-backed, but that does not close `SEC-08`: legacy GUC helpers and direct policy gates remain, and production ledger `89` confirms migration `145` was not applied.

## 3. Key policy findings

| ID | Current evidence | Local source state | Production state |
|---|---|---|---|
| `RLS-CRIT-01` | `integration_tokens_all` has `qual=true`, `with_check=true` | Migration `140` scopes token access; local catalog has `integration_tokens_insert/read/update` | `APPLICATION BLOCKED` |
| `RLS-CRIT-02` | `patients_staff_read` uses only `actor_kind='staff'` and non-null user | Migration `142` adds tenant linkage and active grant window; RLS `6/6` and patients `9/9` pass locally | `APPLICATION BLOCKED` |
| `RLS-CRIT-03` | No `patient_enrollment_lookup` function found in production | Migration `142` defines tenant checks at `packages/db/migrations/142_patient_scope_rls_hardening.sql:97-145`, owner `:147`, grants `:148-153`; patients test `9/9` passes locally | Source-only; no production function to rely on |
| `RLS-HIGH-01` | Production `exchange_grants=0`; policy still lacks active-window enforcement | Active window is present in local `142`; expired-grant test passes locally | `APPLICATION BLOCKED` |
| `RLS-HIGH-02` | `integrity_checkpoints`, `integrity_checkpoint_events`, `ledger_anchors` have RLS disabled | Migration `146` enables RLS; local RLS test passes | `APPLICATION BLOCKED` |
| `RLS-HIGH-03` | Legacy GUC helpers and `3` direct `current_setting` policies remain | Migration `145` source-reviewed; platform-role test `6/6` passes locally | `APPLICATION BLOCKED` |
| `SEC-06` | `13` unconditional ALL policies; runtime DELETE on `163` tables | Migrations `141`, `143`, `146` reviewed | `APPLICATION BLOCKED` |

## 4. Security definer review requirement

Because production roles `medveris_exchange` and `medveris_transfer_guard` have `BYPASSRLS`, RLS alone is not the boundary for SECURITY DEFINER functions. Approval requires all of:

- owner and `GRANT EXECUTE` list reviewed for each function;
- explicit tenant checks inside each function that can read patient-linked data;
- stable `search_path` retained;
- no caller-controlled GUC used as an authorization source;
- negative cross-tenant test evidence stored and passing.

No such production sign-off exists in the current evidence.

## 5. Pass/fail commands

```bash
psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_policies where schemaname='public' and tablename='integration_tokens' and cmd='ALL' and qual='true' and with_check='true'"
psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('integrity_checkpoints','integrity_checkpoint_events','ledger_anchors') and not c.relrowsecurity"
psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_policies where schemaname='public' and (qual like '%current_setting%' or with_check like '%current_setting%')"
npx vitest run --config vitest.config.ts tests/integration/rls.test.ts
npx vitest run --config vitest.config.ts tests/integration/platform-role-guc.test.ts
npx vitest run --config vitest.config.ts tests/integration/patients.test.ts
```

Expected production results: first three queries `0`; all three test commands `0`. Local results this session: all test commands `0`; production database queries still fail the expected states.

## 6. Decision

- `VERIFIED IN LOCAL TEST DATABASE`: targeted RLS, patient, and platform-role behavior.
- `SOURCE REVIEWED`: migrations `139`–`146`.
- `APPLIED TO PRODUCTION` / `VERIFIED IN PRODUCTION`: none.
- Security approval is withheld until production parity and negative cross-tenant evidence exist.
