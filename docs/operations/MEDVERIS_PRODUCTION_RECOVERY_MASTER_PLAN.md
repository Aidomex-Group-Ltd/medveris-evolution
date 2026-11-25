# MedVeris Production Recovery Master Plan

Date: 2026-11-23  
Repo: `/home/aidomex/medveris`  
Authority: canonical active register for all production-readiness blockers. Historical IDs and preserved evidence are mapped in `docs/audit/BLOCKERS.md`.  
Verdict: **B — DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA**.

This reconciliation used existing evidence only. No production connection, migration, deployment, secret change, source change, test mutation, or patient-data action was performed for this task.

## 1. Evidence baseline

| Evidence | Time / result |
|---|---|
| Historical audit snapshot | `2026-11-23T09:49:39Z` |
| Latest read-only production evidence | `2026-11-23T16:21:56Z` |
| Latest local targeted test evidence | `2026-11-23T19:36:13Z` |
| Git HEAD | `7117f36813126010d03e20d975ce97437ecd3388` |
| Git working tree | `21` modified tracked entries, `17` untracked entries |
| Local verification DB | `medveris_test`, PostgreSQL `14.24`, ledger `97`, numeric latest `146` |
| Production DB | `medveris-prod`, PostgreSQL `18.6`, ledger `89`, numeric latest `138` |
| Production aggregates | `3` tenants, `6` users, `2` memberships, `4` patients, `4` sessions, `17` audit events |
| Production zero-baseline | `0` patient accounts, tenant-patient links, exchange grants, outbox events, integration clients, integration tokens |

No PHI values or secret values were printed.

## 2. Status vocabulary

| Status | Meaning |
|---|---|
| `SOURCE REVIEWED` | Reviewed file, catalog output, or report; no environment claim. |
| `SOURCE TESTED` | Local tests pass against the reviewed source. |
| `APPLIED TO LOCAL TEST DATABASE` | Migration or fix is present in `medveris_test`. |
| `VERIFIED IN LOCAL TEST DATABASE` | Targeted behavior verified in `medveris_test`; not production. |
| `APPLIED TO STAGING` | Applied in an isolated staging environment with evidence. |
| `VERIFIED IN STAGING` | Acceptance evidence passes in staging; not production. |
| `APPLICATION BLOCKED` | Source fix exists but is not applied in the target environment. |
| `OPERATOR ACTION REQUIRED` | Human/root/operator/legal/release action is required before evidence can pass. |
| `APPLIED TO PRODUCTION` | Reserved. No item in this register has this status. |
| `VERIFIED IN PRODUCTION` | Reserved. No item in this register has this status. |

## 3. Verification environment tags

- `[local]`: repository checkout and `medveris_test`.
- `[synthetic]`: disposable local or staging database containing synthetic data only.
- `[staging]`: isolated restore/PITR target with a separate data directory, socket, and port.
- `[production DB]`: read-only PostgreSQL catalog verification against `medveris-prod` after an approved migration window.
- `[production host]`: audited SSH command against `medveris-hapi`.
- `[Cloudflare production]`: Wrangler read-only deployment listing and production gate dry-run.
- `[repo]`: repository-local checks that do not require production access.

## 4. Current active register

Every item has an owner, exact closure criteria, and an environment-specific verification command.

| ID | Historical IDs | Owner | Disposition | Finding / current evidence | Exact closure criteria | Verification command and expected result |
|---|---|---|---|---|---|---|
| `MIG-001` | `IND-01`, `DB-CRIT-01` | Release engineer | `SOURCE REVIEWED`; `SOURCE TESTED`; `APPLICATION BLOCKED` | Production ledger `89`, numeric latest `138`; migrations `139`–`146` absent. Local ledger `97`, latest `146`. | Production ledger contains all eight exact versions, no unknown pending versions, deployed release includes the reviewed migration set, and catalog parity matches the reviewed local tree. | `[production DB] psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from schema_migrations where version in ('139_memberships_rls_hardening.sql','140_integration_tokens_tenant_scope.sql','141_all_policy_delete_overgrant_split.sql','142_patient_scope_rls_hardening.sql','143_remaining_rls_overgrant_hardening.sql','144_global_catalogue_read_hardening.sql','145_platform_role_guc_hardening.sql','146_integrity_rls_and_guards.sql')"` → `8`; `[local] npx vitest run --config vitest.config.ts tests/unit/production-gate.test.ts` → `0`. |
| `MIG-002` | `DB-HIGH-01` | Database owner | `OPERATOR ACTION REQUIRED` | `schema_migrations` stores only `version` and `applied_at`; no checksum or source identity. Gate computes a migration-set digest but no production ledger checksum checker exists. | Add a reviewed checksum/source-identity mechanism or signed migration manifest, record the approved digest, and verify production ledger entries against it. The checker artifact does not exist yet; adding it is part of closure. | `[local + production DB] node scripts/check-migration-checksums.mjs --migration-url "$MIGRATION_DATABASE_URL"` → `0` after the checker is added; `[local] npm run deploy:production:check` → `0`. |
| `MIG-003` | `DB-MED-01` | Database engineer | `SOURCE REVIEWED` | Lexical `max(version)` was `99_backfill_unit_type.sql`; reviewed `scripts/migrations.ts` sorts by numeric prefix. | Loaded migration order resolves numeric latest to `146_integrity_rls_and_guards.sql`, with no misplaced migration directories. | `[local] node -e "import('./scripts/migrations.js').then(async m => console.log((await m.loadMigrations()).at(-1).version))"` → `146_integrity_rls_and_guards.sql`; `[local] npx vitest run --config vitest.config.ts tests/unit/migrations-walker.test.ts` → `0`. |
| `MIG-004` | `DB-MED-03` | Database engineer | `SOURCE REVIEWED` | Hyphenated database-name fix in `scripts/db-setup.ts` is uncommitted and not production-verified. | `db:setup` succeeds against a fresh disposable database whose name contains a hyphen, with no identifier parsing error. | `[synthetic] DATABASE_URL=postgres://postgres@localhost:5432/medveris-db-check MIGRATION_DATABASE_URL=postgres://postgres@localhost:5432/medveris-db-check npm run db:setup` → `0`. |
| `LOC-001` | `DB-MED-02` | QA owner | `VERIFIED IN LOCAL TEST DATABASE` | Earlier local drift is corrected: local ledger `97`, latest numeric `146`; targeted tests pass. | Local ledger remains at reviewed tree parity and all final local checks pass after any future source change. | `[local] psql "$MIGRATION_DATABASE_URL" -Atc "select count(*), max(version::text) from schema_migrations"` → `97` plus reviewed latest; `[local] npm test` → `0`. |
| `DR-001` | `IND-02`, `SEC-02`, `DR-CRIT-02`, `INF-HIGH-02` | SRE / infrastructure owner | `OPERATOR ACTION REQUIRED` | `pgbackrest.service` observed `activating (start-post)`, `NRestarts=17417`, exit `37`; `/usr/bin/pgbackrest server` fails with TLS server-auth error. | Service is active without restart growth, exit code is clean, and the unintended server-mode invocation is corrected or explicitly disabled with operator approval. | `[production host] ssh medveris-hapi 'systemctl is-active pgbackrest && systemctl show pgbackrest -p NRestarts -p ExecMainStatus'` → `active`, stable `NRestarts`, clean `ExecMainStatus`. |
| `DR-002` | `DR-CRIT-01`, `DR-CRIT-03` | SRE / release engineer | `OPERATOR ACTION REQUIRED` | `PRODUCTION_BACKUP_INVENTORY` absent; no valid `backup-inventory.json`; `backupLabel=""`. | Real `pgbackrest info --stanza=medveris --output=json` inventory is stored as the production secret, attestation has a real latest full-backup label, and production gate dry-run passes. | `[production host] ssh medveris-hapi 'sudo -n pgbackrest info --stanza=medveris --output=json'` → `0`; `[Cloudflare production] npm run deploy:production:check` → `0`. |
| `DR-003` | `DR-HIGH-01` | SRE / database owner | `OPERATOR ACTION REQUIRED` | No independently verified post-incident PITR drill; older attestation predates incident and has empty label. | Isolated staging PITR completed with matching full-backup label, target time, checksummed aggregate counts, migration/RLS parity, actor, timestamp, RTO, and RPO; no PHI used. | `[staging] SOURCE_PGURL="$SOURCE_PGURL" STAGING_PGURL="$STAGING_PGURL" BACKUP_LABEL="$BACKUP_LABEL" TARGET_TIME="$TARGET_TIME" /tmp/ready/verify-pitr-staging.sh` → `0`; `[repo] test -s /tmp/ready/pitr-drill-report.json` → `0`. |
| `DR-004` | `DR-HIGH-02`, `INF-MED-01` | SRE / host owner | `OPERATOR ACTION REQUIRED` | `sudo -n` diagnostics fail; pgBackRest config unreadable by `deploy`; no scoped audited path. | Narrow audited sudoers commands exist for approved pgBackRest/config diagnostics and succeed without interactive authentication. | `[production host] ssh medveris-hapi 'sudo -n pgbackrest info --stanza=medveris --output=json && sudo -n -l'` → `0` with only approved diagnostics. |
| `DR-005` | `DR-MED-01` | Release engineer | `OPERATOR ACTION REQUIRED` | `medveris-verify-pitr-fixed.sh` is untracked and unsafe: mutates pgBackRest config, installs wrapper/cron, runs `pg_switch_wal()`, writes attestation, and expects populated patient tables. | The unsafe script is excluded from the release tree and no evidence relies on it. A reviewed restore runbook uses the staging-only verifier. | `[repo] test ! -e medveris-verify-pitr-fixed.sh` → `0`; `[repo] test -s docs/runbooks/restore.md` → `0`. |
| `INF-001` | `IND-03`, `SEC-03`, `INF-HIGH-03` | Release engineer | `OPERATOR ACTION REQUIRED` | Deployed Worker tag `18f842a` does not match reviewed HEAD `7117f36`. | Reviewed immutable artifact from the approved commit is deployed and deployment listing shows the matching tag. | `[Cloudflare production] npx --no-install wrangler deployments list --env production` → tag `7117f36813126010d03e20d975ce97437ecd3388` or approved final commit. |
| `INF-002` | `IND-04` | Release engineer | `OPERATOR ACTION REQUIRED` | Current tree has `21` modified tracked and `17` untracked entries; non-dry-run deploy is blocked. Current task preserves all changes. | Reviewed release source is committed or released from an immutable artifact accepted by the gate; prohibited untracked artifacts are excluded. | `[repo] test -z "$(git status --porcelain)"` → `0`; `[Cloudflare production] npm run deploy:production:check` → `0`. |
| `INF-003` | `IND-06`, `SEC-07`, `INF-HIGH-01` | Host owner | `OPERATOR ACTION REQUIRED` | Root-run Cloudflared unit is `deploy:deploy 0644` with `User=root`. | Unit file is `root:root 0644`, tunnel service is healthy, and no unprivileged user can edit root-run unit configuration. | `[production host] ssh medveris-hapi 'stat -c "%U:%G %a" /etc/systemd/system/cloudflared-medveris.service && systemctl is-active cloudflared-medveris'` → `root:root 644` and `active`. |
| `INF-004` | `IND-09`, `SEC-11`, `INF-MED-04` | SRE / release engineer | `OPERATOR ACTION REQUIRED` | Backup alert webhook is empty, health monitor unit absent, integration labels/static truth not live-verified. | Webhook non-empty, health monitor active, test alert receipt stored, runtime audit passes, and integration availability labels reflect verified operational state. | `[production host] ssh medveris-hapi 'test -s /etc/medveris/backup-alert-webhook && systemctl is-active medveris-health-monitor'` → `0` and `active`; `[local] npm run audit:runtime` → `0`. |
| `INF-005` | `INF-MED-02`, `PERF-01` | Architecture owner | `OPERATOR ACTION REQUIRED` | No Worker/DB locality or data-residency benchmark and sign-off. | Placement document records Worker region, database region, backup region, legal residency rationale, and benchmark results. The document does not exist yet; adding it is part of closure. | `[repo] test -s docs/architecture/PLACEMENT.md` → `0`. |
| `INF-006` | `INF-MED-03`, `PERF-02` | Backend owner | `APPLICATION BLOCKED` | `apps/api/src/lib/storage.ts` buffers whole objects in Worker memory. | Object delivery streams or enforces a reviewed size limit with regression coverage. The dedicated test does not exist yet; adding it is part of closure. | `[local] npx vitest run --config vitest.config.ts tests/unit/storage.test.ts` → `0` after the test is added. |
| `INF-007` | `PERF-03` | SRE / database owner | `OPERATOR ACTION REQUIRED` | No slow-query or lock-contention diagnostics in repo evidence. | Approved diagnostics capture slow queries, lock waits, representative timings, and remediation sign-off without exposing PHI or secrets. | `[production DB] psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_stat_statements"` → `0` after approved extension setup; `[repo] test -s docs/operations/PRODUCTION_PERFORMANCE_EVIDENCE.md` → `0`. |
| `RLS-001` | `IND-05`, `SEC-01`, `RLS-CRIT-01` | Security / database owner | `SOURCE TESTED`; `APPLICATION BLOCKED` | Production `integration_tokens_all` is unconditional (`qual=true`, `with_check=true`). | Production has no unconditional token `ALL` policy and migration `140` scoped policies are present. | `[production DB] psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_policies where schemaname='public' and tablename='integration_tokens' and cmd='ALL' and qual='true' and with_check='true'"` → `0`. |
| `RLS-002` | `RLS-CRIT-02` | Security / database owner | `SOURCE TESTED`; `APPLICATION BLOCKED` | Production `patients_staff_read` lacks tenant linkage. | Patient reads require tenant ownership, active grant visibility, and tested cross-tenant denial. | `[local] npx vitest run --config vitest.config.ts tests/integration/rls.test.ts` → `0`; `[production DB] psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_policies where schemaname='public' and tablename='patients' and cmd='SELECT' and qual not like '%tenant%'" ` → `0` after migration `142`. |
| `RLS-003` | `SEC-05`, `RLS-CRIT-03` | Security / database owner | `SOURCE TESTED`; `APPLICATION BLOCKED` | `app.patient_enrollment_lookup(text,text,date)` absent in production. Local migration `142` adds tenant linkage, owner change, and grants. | Function exists in production with tenant linkage, reviewed owner/grants, and negative cross-tenant evidence; BYPASSRLS owner path is explicitly reviewed. | `[production DB] psql "$MIGRATION_DATABASE_URL" -Atc "select to_regprocedure('app.patient_enrollment_lookup(text,text,date)') is not null"` → `t`; `[local] npx vitest run --config vitest.config.ts tests/integration/patients.test.ts` → `0`. |
| `RLS-004` | `SEC-04`, `RLS-HIGH-01` | Security / database owner | `SOURCE TESTED`; `APPLICATION BLOCKED` | Expired exchange grant can be readable in production policy model. | Active-window enforcement exists in normal read path and expired-grant negative test returns no PHI. | `[local] npx vitest run --config vitest.config.ts tests/integration/rls.test.ts -t expired` → `0` with no PHI returned; `[production DB] catalog policy diff contains active-window predicates` → pass. |
| `RLS-005` | `RLS-HIGH-02`, `DB-HIGH-03` | Security / database owner | `SOURCE TESTED`; `APPLICATION BLOCKED` | `integrity_checkpoints`, `integrity_checkpoint_events`, `ledger_anchors` have RLS disabled in production. | All three tables have RLS enabled and tested audit-tenant restrictions. | `[production DB] psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('integrity_checkpoints','integrity_checkpoint_events','ledger_anchors') and not c.relrowsecurity"` → `0`; `[local] npx vitest run --config vitest.config.ts tests/integration/rls.test.ts` → `0`. |
| `RLS-006` | `SEC-06`, `DB-HIGH-02` | Security / database owner | `SOURCE REVIEWED`; `APPLICATION BLOCKED` | Production has `13` unconditional `ALL` policies and runtime DELETE on `163` tables. | No unexplained unconditional `ALL` policies; remaining DELETE grants match a signed reviewed baseline. | `[production DB] psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_policies where schemaname='public' and cmd='ALL' and qual='true' and with_check='true'"` → `0`; `[production DB] psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from information_schema.role_table_grants where grantee like 'medveris_%' and privilege_type='DELETE'"` → signed-off baseline. |
| `RLS-007` | `SEC-08`, `RLS-HIGH-03` | Security / database owner | `SOURCE TESTED`; `APPLICATION BLOCKED` | Production has `3` direct `current_setting` policies and legacy GUC helpers `app.platform_roles_bootstrap()` / `app.legacy_elevate_available()`. | No caller-controlled GUC is an authorization source; legacy helpers are DB-backed or migration-only; forged-GUC negative tests pass. | `[production DB] psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_policies where schemaname='public' and (qual like '%current_setting%' or with_check like '%current_setting%')"` → `0`; `[local] npx vitest run --config vitest.config.ts tests/integration/platform-role-guc.test.ts` → `0`. |
| `PRIV-001` | `IND-07`, `SEC-09` | Legal / product owner | `OPERATOR ACTION REQUIRED` | Privacy notice promises “Settings > Privacy”; self-service routes are incomplete. | Either implemented correction/deletion/export/preferences/withdrawal flows with tests, or the notice is amended before real patient data. | `[local] npx vitest run --config vitest.config.ts tests/integration/privacy-self-service.test.ts` → `0` after the test is added; if notice is amended instead, `[repo] ! grep -q 'Settings > Privacy' docs/privacy-policy-draft.md` → `0`. |
| `PAY-001` | `IND-08`, `SEC-10` | Payments owner | `APPLICATION BLOCKED` | Adapter/gate/config mismatch: config keeps `FEATURE_PAYMENTS=false` and `PAYMENT_PROVIDER=livepay`, LivePay secrets are declared, gate requires Yo secrets when payments are enabled. | One provider mode is chosen and adapter, checkout/webhook, gate, secrets, config, and tests all agree; payments remain disabled until live verification. | `[local] npx vitest run --config vitest.config.ts tests/integration/workflow-payments.test.ts tests/integration/livepay-checkout.test.ts` → `0`; `[Cloudflare production] npm run deploy:production:check` → `0`. |
| `TEST-001` | `RLS-MED-01`, `FUNC-01` | QA owner | `OPERATOR ACTION REQUIRED` | Older full suite: `8` failed files, `7` failed tests, `929` passed, `33` skipped. Targeted reruns pass but full suite remains open. | Full current suite passes with no failing file and no skipped required acceptance path. | `[local] npm test` → `0`. |
| `TEST-002` | `FUNC-02` | QA owner | `OPERATOR ACTION REQUIRED` | Radiology older failure: `TypeError: Cannot read properties of undefined (reading 'stage')`. | Radiology worklist pagination/data assumption fixed and full radiology suite passes. | `[local] npx vitest run --config vitest.config.ts tests/integration/radiology.test.ts` → `0`. |
| `TEST-003` | `FUNC-03` | QA owner | `OPERATOR ACTION REQUIRED` | Older directory failures: sponsored events, token scope, patient match/unlink, cross-tenant cases. | Directory suite passes with RLS and audit context fixes. | `[local] npx vitest run --config vitest.config.ts tests/integration/directory.test.ts` → `0`. |
| `TEST-004` | `FUNC-04` | QA owner | `VERIFIED IN LOCAL TEST DATABASE`; production verification pending | Targeted patients test now `9/9`; local linkage and facility-scoped lookup pass. Production cannot prove this until migration parity exists. | Patient linkage behavior passes in a production-equivalent synthetic environment after migrations `139`–`146`, and production catalog contains the enrollment helper. | `[synthetic] npx vitest run --config vitest.config.ts tests/integration/patients.test.ts` → `0`; `[production DB] psql "$MIGRATION_DATABASE_URL" -Atc "select to_regprocedure('app.patient_enrollment_lookup(text,text,date)') is not null"` → `t`. |
| `TEST-005` | `FUNC-05` | QA owner | `OPERATOR ACTION REQUIRED` | Older data-exchange facility-wide export scope failure. | Membership guard and export scope fixed; data-exchange suite passes. | `[local] npx vitest run --config vitest.config.ts tests/integration/data-exchange.test.ts` → `0`. |

## 5. SECURITY DEFINER and BYPASSRLS acceptance gate

RLS alone is not the security boundary for functions owned by BYPASSRLS roles. Production catalog shows `32` SECURITY DEFINER functions, mostly owned by `medveris_exchange`, with `search_path=public, pg_temp`; `medveris_exchange` and `medveris_transfer_guard` have `rolbypassrls=true`, and `medveris_exchange` is a member of `medveris_migrator`.

Approval requires all of:

- owner and `GRANT EXECUTE` list reviewed for every SECURITY DEFINER function;
- explicit tenant checks inside every function that can read patient-linked data;
- stable `search_path` retained;
- no caller-controlled GUC used as an authorization source;
- no BYPASSRLS role used for routine application reads;
- negative cross-tenant test evidence stored and passing in a production-equivalent synthetic environment;
- human security sign-off recorded.

Verification command:

```bash
psql "$MIGRATION_DATABASE_URL" -Atc "select p.proname, pg_get_function_identity_arguments(p.oid), pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, r.rolbypassrls from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='app' and p.prosecdef order by 1,2"
```

Expected: reviewed owner/execute baseline, stable `search_path`, no caller-controlled GUC authorization, and recorded human sign-off. No such production sign-off exists in current evidence.

## 6. Current local passes

- `npm run lint` → `0`
- `npm run typecheck` → `0`
- `tests/unit/production-gate.test.ts` → `26/26`
- `tests/integration/platform-role-guc.test.ts` → `6/6`
- `tests/integration/rls.test.ts` → `6/6`
- `tests/integration/patients.test.ts` → `9/9`

These are source-verification and local-database results only.

## 7. Decision

**B — DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA.**

No item in this register is `APPLIED TO PRODUCTION` or `VERIFIED IN PRODUCTION`. Keep real patient data out of production until every blocker above has environment-specific, evidence-backed closure and human sign-off.
