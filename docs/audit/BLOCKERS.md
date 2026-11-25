# Production Blockers and Remediation Register

## 1. Authority and scope

This file is the reconciliation layer for all production-readiness IDs. The current active register is in `docs/operations/MEDVERIS_PRODUCTION_RECOVERY_MASTER_PLAN.md`; this file preserves the historical audit findings and maps every historical ID to a canonical active ID.

- Historical audit snapshot: `2026-11-23T09:49:39Z`.
- Latest read-only production evidence: `2026-11-23T16:21:56Z`.
- Latest local targeted test evidence: `2026-11-23T19:36:13Z`.
- Current Git state: `21` modified tracked entries and `17` untracked entries.
- Required verdict: **B — DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA**.

No production connection, migration, deployment, secret change, source change, or test mutation was performed for this reconciliation.

## 2. Status vocabulary

| Status | Meaning |
|---|---|
| `SOURCE REVIEWED` | Reviewed file, catalog output, or historical report; no environment claim. |
| `SOURCE TESTED` | Local tests pass against the reviewed source. |
| `VERIFIED IN LOCAL TEST DATABASE` | Targeted behavior verified in `medveris_test`; not production. |
| `APPLIED TO PRODUCTION` | Reserved. No remediation item in this reconciliation has this status. |
| `VERIFIED IN PRODUCTION` | Production acceptance evidence exists. No remediation item in this reconciliation has this status. |
| `APPLICATION BLOCKED` | A source fix exists but is not applied in the target environment. |
| `OPERATOR ACTION REQUIRED` | Human/root/operator/legal/release action is required before evidence can pass. |

## 3. Canonical ID reconciliation

| Historical ID | Canonical ID | Reconciliation note |
|---|---|---|
| `IND-01` | `MIG-001` | Migration parity; duplicate of `DB-CRIT-01`. |
| `IND-02` | `DR-001` | pgBackRest service/inventory/PITR cluster; split into service, inventory, PITR, and diagnostics items. |
| `IND-03` | `INF-001` | Worker provenance; duplicate of `SEC-03`/`INF-HIGH-03`. |
| `IND-04` | `INF-002` | Working-tree cleanliness; current count corrected to `21` modified and `17` untracked. |
| `IND-05` | `RLS-001` | Broad production RLS cluster; split into token, patient-read, helper, grant-window, integrity, and broad-grant items. |
| `IND-06` | `INF-003` | Cloudflared unit; duplicate of `SEC-07`/`INF-HIGH-01`. |
| `IND-07` | `PRIV-001` | Privacy self-service; duplicate of `SEC-09`. |
| `IND-08` | `PAY-001` | Payment adapter/gate/config mismatch; duplicate of `SEC-10`. |
| `IND-09` | `INF-004` | Alerting/integration truth; duplicate of `SEC-11`/`INF-MED-04`. |
| `SEC-01` | `RLS-001` | Production RLS hardening absent; duplicate of `IND-05`. |
| `SEC-02` | `DR-001` | pgBackRest crash loop; duplicate of `IND-02`/`DR-CRIT-02`. |
| `SEC-03` | `INF-001` | Stale deployed Worker; duplicate of `IND-03`. |
| `SEC-04` | `RLS-004` | Active exchange-grant window defect. |
| `SEC-05` | `RLS-003` | Patient enrollment helper tenant linkage and BYPASSRLS owner. |
| `SEC-06` | `RLS-006` | Broad `ALL` policies and runtime DELETE grants. |
| `SEC-07` | `INF-003` | Cloudflared unit; duplicate of `IND-06`. |
| `SEC-08` | `RLS-007` | GUC platform-role gates; duplicate of `RLS-HIGH-03`. |
| `SEC-09` | `PRIV-001` | Privacy self-service; duplicate of `IND-07`. |
| `SEC-10` | `PAY-001` | Payment mismatch; duplicate of `IND-08`. |
| `SEC-11` | `INF-004` | Alerting; duplicate of `IND-09`. |
| `RLS-CRIT-01` | `RLS-001` | Unconditional token policy. |
| `RLS-CRIT-02` | `RLS-002` | Broad staff patient reads. |
| `RLS-CRIT-03` | `RLS-003` | Enrollment helper; duplicate of `SEC-05`. |
| `RLS-HIGH-01` | `RLS-004` | Expired grant readability; duplicate of `SEC-04`. |
| `RLS-HIGH-02` | `RLS-005` | Integrity/ledger RLS; duplicate of `DB-HIGH-03`. |
| `RLS-HIGH-03` | `RLS-007` | GUC gates; duplicate of `SEC-08`. |
| `RLS-MED-01` | `TEST-001` | Test evidence incomplete; full suite still open. |
| `DB-CRIT-01` | `MIG-001` | Migration parity; duplicate of `IND-01`. |
| `DB-HIGH-01` | `MIG-002` | Migration ledger has no checksums/source identity. |
| `DB-HIGH-02` | `RLS-006` | Broad policies and grants. |
| `DB-HIGH-03` | `RLS-005` | Integrity/ledger RLS; duplicate of `RLS-HIGH-02`. |
| `DB-MED-01` | `MIG-003` | Migration version ordering. |
| `DB-MED-02` | `LOC-001` | Historical local drift; latest local ledger is `97` and targeted tests pass. |
| `DB-MED-03` | `MIG-004` | Hyphenated DB-name fix; source-reviewed. |
| `DR-CRIT-01` | `DR-002` | Missing backup inventory. |
| `DR-CRIT-02` | `DR-001` | pgBackRest crash loop. |
| `DR-CRIT-03` | `DR-002` | Invalid attestation/empty backup label. |
| `DR-HIGH-01` | `DR-003` | No post-incident PITR drill. |
| `DR-HIGH-02` | `DR-004` | Privileged diagnostics blocked; overlaps `INF-MED-01`. |
| `DR-MED-01` | `DR-005` | Unsafe PITR helper script. |
| `INF-HIGH-01` | `INF-003` | Cloudflared unit; duplicate of `IND-06`. |
| `INF-HIGH-02` | `DR-001` | pgBackRest restart storm. |
| `INF-HIGH-03` | `INF-001` | Stale Worker. |
| `INF-MED-01` | `DR-004` | Audited sudo path; duplicate of `DR-HIGH-02`. |
| `INF-MED-02` | `INF-005` | Locality/residency; duplicate of `PERF-01`. |
| `INF-MED-03` | `INF-006` | Storage buffering; duplicate of `PERF-02`. |
| `INF-MED-04` | `INF-004` | Alert delivery; duplicate of `IND-09`/`SEC-11`. |
| `FUNC-01` | `TEST-001` | Full suite; remains open. |
| `FUNC-02` | `TEST-002` | Radiology failure. |
| `FUNC-03` | `TEST-003` | Directory failure. |
| `FUNC-04` | `TEST-004` | Patient enrollment/link; locally resolved, production verification pending. |
| `FUNC-05` | `TEST-005` | Data-exchange failure. |
| `PERF-01` | `INF-005` | Locality from infrastructure audit; duplicate of `INF-MED-02`. |
| `PERF-02` | `INF-006` | Object buffering from infrastructure audit; duplicate of `INF-MED-03`. |
| `PERF-03` | `INF-007` | Slow-query/lock diagnostics from infrastructure audit. |

## 4. Corrections applied to current status

| Stale statement | Corrected current statement |
|---|---|
| `IND-04`: `5` untracked files | `17` untracked entries |
| Earlier summary: `10` untracked entries | `17` untracked entries |
| Earlier reconciliation pass: `16` untracked entries | `17` untracked entries after adding `PRODUCTION_ACTIVE_REMEDIATION_SUMMARY.md` |
| `NRestarts=16221` | Historical snapshot; latest observed `17417` |
| Conflicting patient counts (`0`, `4`, `5`) | Authoritative production count `4` at `2026-11-23T16:21:56Z` |
| “Production is not reachable” | Production was reachable read-only; no production mutation |
| “Local test DB behind `139`–`146`” | Local ledger `97`, latest numeric `146`; targeted tests pass |
| “Migration `145` applied” in old status fields | Production ledger `89`; no `139`–`146` applied; source/test only |
| `SEC-04`/`SEC-05` worded as already fixed | Source-level fixes verified locally; production application/verification absent |

## 5. Historical audit register — preserved, not current status

The table below is the original `2026-11-23T09:49:39Z` audit snapshot. It is retained for historical evidence. Use sections 3 and 4 and `MEDVERIS_PRODUCTION_RECOVERY_MASTER_PLAN.md` for current status.

| ID | Severity | Exact evidence | Fix | Owner | Pass/fail test command |
|---|---|---|---|---|---|
| `IND-01` | blocker | `schema_migrations` has `89` rows; latest numeric `138_clinical_entry_attachments_rls.sql`; `139`–`146` pending. | Apply reviewed migrations `139`–`146` and verify catalog. | human | `psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from schema_migrations where version in ('139_memberships_rls_hardening.sql','140_integration_tokens_tenant_scope.sql','141_all_policy_delete_overgrant_split.sql','142_patient_scope_rls_hardening.sql','143_remaining_rls_overgrant_hardening.sql','144_global_catalogue_read_hardening.sql','145_platform_role_guc_hardening.sql','146_integrity_rls_and_guards.sql')"` → `8` |
| `IND-02` | blocker | `backupLabel=""`; `PRODUCTION_BACKUP_INVENTORY` absent; `pgbackrest.service` `NRestarts=16221`, exit `37`. | Repair pgBackRest, capture inventory, perform PITR drill, set label. | human | `npm run deploy:production:check` → `0` with real inventory and non-empty label |
| `IND-03` | blocker | Deployed Worker tag `18f842a` vs reviewed HEAD `7117f36813126010d03e20d975ce97437ecd3388`. | Deploy reviewed immutable artifact and record version. | human | `npx --no-install wrangler deployments list --env production` → tag matches reviewed commit |
| `IND-04` | blocker | `git status --short`: `21` modified tracked files, `5` untracked files; `scripts/production-deploy.mjs` blocks dirty tree. | Commit or intentionally stage reviewed changes; preserve untracked artifacts outside release. | human | `test -z "$(git status --porcelain)"` → `0` |
| `IND-05` | blocker | Production `integration_tokens_all` `ALL true/true`; `patients_staff_read` untethered; integrity tables RLS-off. | Apply `139`–`146`; remove broad policies; enable integrity RLS. | agent | `psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_policies where schemaname='public' and ((tablename='integration_tokens' and cmd='ALL' and qual='true' and with_check='true') or (tablename in ('integrity_checkpoints','integrity_checkpoint_events','ledger_anchors')))"` → `0` |
| `IND-06` | blocker | `/etc/systemd/system/cloudflared-medveris.service` is `-rw-r--r-- deploy deploy` but `User=root`. | Set owner root and mode 0644; validate unit. | human | `ssh medveris-hapi 'stat -c "%U %a" /etc/systemd/system/cloudflared-medveris.service'` → `root 644` |
| `IND-07` | blocker | `docs/privacy-policy-draft.md:99,109` promise “Settings > Privacy”; `apps/api/src/routes/me.ts:14-244` has no correction/deletion/export/preferences routes. | Implement privacy self-service routes or amend notice before go-live. | legal | `npx vitest run --config vitest.config.ts tests/integration/privacy-self-service.test.ts` → `0` |
| `IND-08` | should-fix | Adapter is Yo-only while checkout/webhook handle LivePay; gate requires Yo; `LIVEPAY_ACCOUNT_NUMBER` missing. | Choose one payment mode and align adapter, gate, config, and tests. | agent | `npx vitest run --config vitest.config.ts tests/integration/payments.test.ts` → `0` |
| `IND-09` | should-fix | Gate checks support-center URL but not alert destination/token; integration availability is static; secret values unverified. | Add live alert and provider checks; verify secrets by name and controlled probe. | agent | `npm run audit:runtime` → `0` plus `docs/audit/OBSERVABILITY_EVIDENCE.md` exists |
| `SEC-01` | blocker | Production RLS hardening absent; `integration_tokens_all` unconditional; staff patient reads lack tenant link. | Apply `139`–`146`; verify `pg_policies` diff. | human | `psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_policies where schemaname='public' and tablename='integration_tokens' and cmd='ALL' and qual='true'"` → `0` |
| `SEC-02` | blocker | `pgbackrest.service` crash loop; `pgbackrest info` `rc=41` permission denied; no valid attestation. | Repair service, capture inventory, restore/PITR drill, update attestation. | human | `npm run deploy:production:check` → `0` |
| `SEC-03` | blocker | Deployed tag `18f842a` not equal reviewed commit `7117f36`. | Deploy from clean reviewed tree. | human | `npx --no-install wrangler deployments list --env production` → reviewed tag |
| `SEC-04` | blocker | Migration `142` reintroduction of active-window filters on recipient-tenant `exchange_grants` reads (also `patient_enrollment_lookup` tenant linkage added). Expired-grant negative test added to `tests/integration/rls.test.ts` — asserts no PHI returned. | Reintroduce active-window checks or separate audited non-PHI view. | agent | `npx vitest run --config vitest.config.ts tests/integration/rls.test.ts -t expired` → `0` with no PHI read |
| `SEC-05` | blocker | `app.patient_enrollment_lookup(text,text,date)` has no tenant linkage; owner `medveris_exchange` BYPASSRLS. | Add tenant link and cross-tenant regression test. | agent | `test -s /tmp/ready/rls-cross-tenant-loop.out` and `grep -c FAIL /tmp/ready/rls-cross-tenant-loop.out` → `0` |
| `SEC-06` | blocker | `229` `ALL` policies; `101` with mismatched/NULL `WITH CHECK`; runtime DELETE on `163` tables. | Apply `141`, `143`, `146`; audit grants. | agent | `psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from information_schema.role_table_grants where grantee like 'medveris_%' and privilege_type='DELETE'"` → reviewed baseline only |
| `SEC-07` | blocker | Root-run Cloudflared unit writable by `deploy`. | Chown root, chmod 0644. | human | `ssh medveris-hapi 'stat -c "%U %a" /etc/systemd/system/cloudflared-medveris.service'` → `root 644` |
| `SEC-08` | blocker | Migration `145` applied; forgeable platform-role GUC gates replaced with DB-backed checks (migration `145_platform_role_guc_hardening.sql`). Negative tests verify `app.is_content_editor()`, `app.platform_roles_bootstrap()`, `app.legacy_elevate_available()` are not forgeable via GUC for runtime sessions, and `support_tickets` policy uses DB-backed operator check. | Apply `145` and add forged-GUC negative tests. | agent | `npx vitest run --config vitest.config.ts tests/integration/platform-role-guc.test.ts` → `0` |
| `SEC-09` | blocker | Privacy notice promises “Settings > Privacy”; no implementation. | Implement or amend notice. | legal | `npx vitest run --config vitest.config.ts tests/integration/privacy-self-service.test.ts` → `0` |
| `SEC-10` | should-fix | `apps/api/src/routes/finance.ts:1170-1177,1241-1245` Yo-only; `wrangler.jsonc:407-416` lacks `LIVEPAY_ACCOUNT_NUMBER`. | Align adapter/gate/config. | agent | `npx vitest run --config vitest.config.ts tests/integration/payments.test.ts` → `0` |
| `SEC-11` | should-fix | Alert destination/token not verified; integration labels static. | Add live probes and accurate labels. | agent | `npm run audit:runtime` → `0` |
| `RLS-CRIT-01` | blocker | Production `integration_tokens_all` `ALL` with `qual=true`, `with_check=true`. | Apply `140`; verify no unconditional token policy. | agent | `psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_policies where tablename='integration_tokens' and cmd='ALL' and qual='true' and with_check='true'"` → `0` |
| `RLS-CRIT-02` | blocker | `patients_staff_read` qual `(app.actor_kind()='staff' AND app.current_user() IS NOT NULL)`; no tenant link. | Apply `142`; require tenant link. | agent | `npx vitest run --config vitest.config.ts tests/integration/rls.test.ts` → `0` |
| `RLS-CRIT-03` | blocker | `app.patient_enrollment_lookup(text,text,date)` now requires tenant linkage via `created_tenant_id`, `tenant_patient_links`, or active `exchange_grants`. Cross-tenant regression test added. | Add tenant linkage and test. | agent | `test -s /tmp/ready/rls-cross-tenant-loop.out` and `grep -c FAIL /tmp/ready/rls-cross-tenant-loop.out` → `0` |
| `RLS-HIGH-01` | blocker | Expired `exchange_grants` readable under recipient tenant in reviewed policy. | Enforce active window in normal read path. | agent | `npx vitest run --config vitest.config.ts tests/integration/rls.test.ts -t expired` → no PHI returned |
| `RLS-HIGH-02` | blocker | `integrity_checkpoints`, `integrity_checkpoint_events`, `ledger_anchors` lack RLS. | Apply `146`. | agent | `psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('integrity_checkpoints','integrity_checkpoint_events','ledger_anchors') and not c.relrowsecurity"` → `0` |
| `RLS-HIGH-03` | blocker | Migration `145_platform_role_guc_hardening.sql` applied; forgeable GUC gates replaced with DB-backed checks. Verified by `tests/integration/platform-role-guc.test.ts` (6/6 pass). | Apply `145`. | agent | `npx vitest run --config vitest.config.ts tests/integration/platform-role-guc.test.ts` → `0` |
| `RLS-MED-01` | should-fix | Targeted logs show red tests; follow-up fixes not rerun. | Rebuild `medveris_test` from reviewed tree and rerun. | agent | `npm test` → `0` failures |
| `DB-CRIT-01` | blocker | `139`–`146` pending in production. | Apply via controlled release. | human | `psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from schema_migrations where version like '14%_%' or version like '139_%'" ` → `8` |
| `DB-HIGH-01` | blocker | `schema_migrations` stores only `version`, `applied_at`; no checksums. | Add checksum/source identity to ledger or signed manifest. | agent | `node scripts/check-migration-checksums.mjs` → `0` |
| `DB-HIGH-02` | blocker | Runtime DELETE on `163` tables; `101` ALL-policy mismatches. | Apply `141`, `143`, `146`; prune grants. | agent | `psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from information_schema.role_table_grants where grantee='medveris_runtime' and privilege_type='DELETE'"` → approved count with sign-off |
| `DB-HIGH-03` | blocker | Integrity/ledger tables RLS-off. | Apply `146`. | agent | `psql "$MIGRATION_DATABASE_URL" -Atc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('integrity_checkpoints','integrity_checkpoint_events','ledger_anchors') and not c.relrowsecurity"` → `0` |
| `DB-MED-01` | should-fix | Lexical `max(version)` is `99_backfill_unit_type.sql`; numeric latest is `138_...`. | Use numeric-prefix parsing. | agent | `npm test -- tests/unit/migration-order.test.ts` → `0` |
| `DB-MED-02` | should-fix | `medveris_test` partially synchronized; `143` not applied; targeted tests red. | Rebuild test DB from reviewed tree. | agent | `npm test` → `0` failures |
| `DB-MED-03` | should-fix | `scripts/db-setup.ts` hyphenated DB-name fix uncommitted. | Review and commit or drop with rationale. | agent | `npm run db:setup` on fresh synthetic DB → `0` |
| `DR-CRIT-01` | blocker | No `backup-inventory.json`; `PRODUCTION_BACKUP_INVENTORY` absent. | Capture real `pgbackrest info --output=json`, store as secret. | human | `gh secret list --env production` contains `PRODUCTION_BACKUP_INVENTORY` |
| `DR-CRIT-02` | blocker | `pgbackrest.service` `NRestarts=16221`, exit `37`; `Restart=always`. | Fix config/permissions; add restart alerting. | human | `ssh medveris-hapi 'systemctl is-active pgbackrest'` → `active` with `NRestarts` stable |
| `DR-CRIT-03` | blocker | `result="pass"` but `backupLabel=""`; gate errors require inventory and label. | New post-fix restore/PITR drill with named label. | human | `npm run deploy:production:check` → `0` |
| `DR-HIGH-01` | blocker | No independently verified post-incident PITR drill; attestation predates incident. | Perform full restore and PITR into isolated staging. | human | `test -s /tmp/ready/pitr-drill-report.json` with non-empty label, RTO, RPO, signatures |
| `DR-HIGH-02` | blocker | `sudo -n pgbackrest info` denied; config unreadable by `deploy`. | Add narrowly scoped audited sudoers command. | human | `ssh medveris-hapi 'sudo -n pgbackrest info --stanza=medveris --output=json'` → `0` |
| `DR-MED-01` | note | `medveris-verify-pitr-fixed.sh` has side effects and is untracked. | Review, version, or remove; do not execute blindly. | human | `test -f docs/runbooks/restore.md` and script reviewed |
| `INF-HIGH-01` | blocker | Cloudflared unit owned by `deploy`, `User=root`. | Root ownership and mode 0644. | human | `ssh medveris-hapi 'stat -c "%U %a" /etc/systemd/system/cloudflared-medveris.service'` → `root 644` |
| `INF-HIGH-02` | blocker | pgBackRest restart storm. | Fix and monitor. | human | `ssh medveris-hapi 'systemctl show pgbackrest -p NRestarts'` → no growth over watch window |
| `INF-HIGH-03` | blocker | Worker version `13001954...` tag `18f842a` stale. | Deploy reviewed artifact. | human | `npx --no-install wrangler deployments list --env production` → reviewed tag |
| `INF-MED-01` | should-fix | `sudo` interactive; no audited diagnostic path. | Define scoped sudoers commands. | human | `ssh medveris-hapi 'sudo -n -l'` → only approved diagnostics |
| `INF-MED-02` | should-fix | No Worker/DB locality or residency evidence. | Document region choice and benchmark. | agent | `test -s docs/architecture/PLACEMENT.md` |
| `INF-MED-03` | should-fix | `apps/api/src/lib/storage.ts` buffers whole objects. | Stream objects or enforce limits. | agent | `npm test -- tests/unit/storage.test.ts` → `0` |
| `INF-MED-04` | should-fix | Alert URL reachable but delivery/token unverified. | Trigger test alert and verify destination. | agent | `test -s /tmp/ready/alert-delivery-proof.txt` |
| `FUNC-01` | blocker | Full suite `8` failed files, `7` failed tests, `929` passed, `33` skipped. | Fix all failures and rerun. | agent | `npm test` → `0` failures |
| `FUNC-02` | blocker | Radiology test `TypeError: Cannot read properties of undefined (reading 'stage')`. | Fix worklist pagination/data assumption. | agent | `npx vitest run --config vitest.config.ts tests/integration/radiology.test.ts` → `0` |
| `FUNC-03` | blocker | Directory: sponsored events, token scope, patient match/unlink, cross-tenant tests failed. | Fix RLS/audit context and rerun. | agent | `npx vitest run --config vitest.config.ts tests/integration/directory.test.ts` → `0` |
| `FUNC-04` | blocker | Patients: `links a patient registered elsewhere without creating a second identity` failed. | Fix enrollment lookup tenant linkage and rerun. | agent | `npx vitest run --config vitest.config.ts tests/integration/patients.test.ts` → `0` |
| `FUNC-05` | blocker | Data exchange facility-wide export scope test failed. | Fix membership guard/test context. | agent | `npx vitest run --config vitest.config.ts tests/integration/data-exchange.test.ts` → `0` |

## 6. Additional historical findings from audit reports

| Historical ID | Evidence in historical report | Current canonical ID |
|---|---|---|
| `PERF-01` | Worker/DB region and residency relationship unresolved (`docs/audit/PRODUCTION_INFRASTRUCTURE_REVIEW.md:61`). | `INF-005` |
| `PERF-02` | Protected object delivery buffers whole objects in Worker memory (`docs/audit/PRODUCTION_INFRASTRUCTURE_REVIEW.md:62`). | `INF-006` |
| `PERF-03` | No slow-query or lock-contention diagnostics in repo evidence (`docs/audit/PRODUCTION_INFRASTRUCTURE_REVIEW.md:63`). | `INF-007` |

## 7. Notes

- Historical rows are intentionally preserved even where a status was later corrected.
- No pass criterion accepts weakened gate logic, fabricated inventory, or synthetic data in production.
- `sshpass_1.09-1_amd64.deb`, `seed-drill-prod.sql`, `tmp-*`, and `medveris-verify-pitr-fixed.sh` must not be committed or used as production evidence.
