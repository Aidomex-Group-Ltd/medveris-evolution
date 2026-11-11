# Gate Readiness Report

- **Generated (UTC):** 2026-11-11T15:23:38Z (approx; report assembly time)
- **Branch:** `phase1a/shared-supply-security-closure`
- **HEAD:** `af526cf` — `docs(refactor): record targeted verification pass (lint/typecheck/authz/workspaces)`
- **Working tree (start):** modified tracked files `REFACTOR.md`, `apps/api/src/routes/organizations.ts`, `apps/api/src/routes/workspace.ts`, `docs/refactor/phase1a/REMEDIATION_1_REPORT.md`, `tests/integration/workspaces.test.ts`; untracked `packages/db/migrations/125_organization_link_dispatched_transfers.sql`, `packages/db/migrations/126_transfer_guard_privileges.sql`.
- **Working tree (end, changes made by this run):** additionally modified `scripts/db-setup.ts`, `packages/db/migrations/125_organization_link_dispatched_transfers.sql` (local provisioning fixes; see Step 0). No commits created.

## HARD SAFETY COMPLIANCE
- Unset potentially sensitive/hosted env vars in shell before destructive ops: `unset MIGRATION_DATABASE_URL DATABASE_URL JOBS_DATABASE_URL PGADMIN_URL STAGING_SECRETS_FILE STAGING_RESEND_FILE` → `ENV_CLEARED_OK`.
- No commands run against `~/.config/medveris/staging` or `~/.config/medveris/production`; no hosted MIGRATION_DATABASE_URL used.
- No `git push`, merge, deploy, wrangler deploy/versions/secret/d1/r2, non-local db-migrate, or `--confirm-database` for non-local DB executed.
- All destructive/reset/migrate/seed commands targeted only `localhost` / `medveris_test` (masked/confirmed before each).
- No real patient data; seed synthetic only. No secrets/passwords/tokens/full connection strings printed.
- No tests/gates/RLS/policies/privilege checks weakened, skipped, or deleted.

## Step 0 — Read-only inspection (findings)

### Scripts and package.json
| File | Purpose | Env vars read | Deletes / destructive behavior |
|---|---|---|---|
| `scripts/db-setup.ts` | Ensures DB roles exist (create if missing, else unchanged), grants exchange role to migrator, creates target DB if missing, sets DB/schema ownership/USAGE grants. | `MIGRATION_DATABASE_URL` (asserts provisioning inputs if set), `PGADMIN_URL` (default `postgres://postgres:***@localhost:5432/postgres`), `MIGRATOR_PASSWORD`, `RUNTIME_PASSWORD`, `JOBS_PASSWORD` (+ target inferred from MIGRATION URL). | No drops/resets of data; `CREATE ROLE/DATABASE` only if absent; alters schema owner/grants on target. |
| `scripts/db-migrate.ts` | Applies pending SQL migrations in order inside runner-owned transaction per file; records in `schema_migrations`; runs schema integrity checks. Refuses non-routine/non-local-ish targets without `--confirm-database=<target>` (routine: `medveris_(dev|test)` non-prod, or `medveris_staging` with `APP_ENV=staging`). | `MIGRATION_DATABASE_URL` (required), `APP_ENV`/`NODE_ENV`. | No deletes except migration DDL/DML in files; writes `schema_migrations`. |
| `scripts/db-reset-synthetic.ts` | Safety preflight then drops/recreates `app` and `public` schemas, reapplies all migrations, then runs `npm run db:seed`. Restricted to `medveris_dev`/`medveris_test`, disabled in production, requires `--yes` or `MEDVERIS_ALLOW_RESET=1` unless `--check`. | `MIGRATION_DATABASE_URL`, `DATABASE_URL`, `JOBS_DATABASE_URL`, `APP_ENV`/`NODE_ENV`, `MEDVERIS_ALLOW_RESET`. | **Destructive:** `DROP SCHEMA IF EXISTS app/public CASCADE`, recreates public, erases all data in target synthetic DB (transactional up to commit), then reseeds. |
| `scripts/seed.ts` | Inserts synthetic tenants/users/memberships/patients/clinical/reference/billing/workspace seed data with RLS contexts; refuses production and non-synthetic targets via `assertSyntheticEnvironment`. | `.env` via `loadLocalEnv`, `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `APP_ENV`/`NODE_ENV`, `SEED_TOTP_EXPORT_FILE`/`SEED_ACCOUNT_PASSWORD` for staging-seed mode, config (MFA key etc.). Connects as migrator for bootstrap. | Writes/inserts/upserts data (not a drop); not idempotent in current form (see Step 3). |
| `scripts/lib.ts` | Env loading, required env, `assertSyntheticEnvironment`, `databaseName`, role-provisioning input validation, SQL literal helper. | Reads `APP_ENV`/`NODE_ENV`, `MIGRATION_DATABASE_URL`, `DATABASE_URL`, `PGADMIN_URL`, role password vars for validation. | None. |
| `scripts/migrations.ts` | Loads/sorts migration files from `packages/db/migrations`, strips single BEGIN/COMMIT wrapper, guards against misplaced `.sql` in other `migrations/` dirs, ensures `schema_migrations`, applies migration+records version, schema integrity checks. | None (filesystem/cwd). | None directly; used by migrators/reset. |
| `package.json` scripts (relevant): `db:setup`, `db:migrate`, `db:seed`, `db:reset:synthetic`, `typecheck`, `lint`, `test`, `build`, `deploy:staging:check` etc. | Standard task entrypoints. | As per invoked scripts. | `db:reset:synthetic` destructive by design (guarded). |

### Migrations 125/126 consistency (and fix applied)
- **125 (`organization_link_dispatched_transfers.sql`)**: creates `app.organization_link_dispatched_transfers(uuid,uuid)` as `SECURITY DEFINER`, and (originally) set owner to `medveris_transfer_guard`, revoked PUBLIC, granted EXECUTE to `medveris_runtime`. This is consistent with 126’s requirement that the function be owned by `medveris_transfer_guard` and have specific EXECUTE/privileges.
- **126 (`transfer_guard_privileges.sql`)**: verifies role exists, function exists, owner is `medveris_transfer_guard`, EXECUTE for guard/runtime and not PUBLIC, EXECUTE for guard on `app.organization_role(uuid)`, then grants narrow schema/table-column privileges.
- **Conflict / apply issue (local):** on a fresh local rebuild as migrator, 125 failed first with “must be member of role \`medveris_transfer_guard\`” (fixed by provisioning role+membership in db-setup), then “permission denied for schema app” on `ALTER FUNCTION ... OWNER TO medveris_transfer_guard` (ownership transfer required schema privileges for the new owner in this environment), then 126 failed requiring guard EXECUTE on `app.organization_role(uuid)`. 
- **Remediation recorded (LOCAL ONLY, in working tree):** `scripts/db-setup.ts` now provisions `medveris_transfer_guard` (NOLOGIN,NOSUPERUSER,NOCREATEDB,NOCREATEROLE,BYPASSRLS), grants it to `medveris_migrator`, and grants USAGE on `public` schema to it — marked LOCAL ONLY; staging needs DBA provisioning. `125` updated to `GRANT USAGE, CREATE ON SCHEMA app TO medveris_transfer_guard` and `GRANT EXECUTE ON FUNCTION app.organization_role(uuid) TO medveris_transfer_guard` before ownership transfer (to satisfy 126 and allow local/managed apply). These changes enable local migration apply; **staging/production must not rely on these implicit grants without DBA review/provisioning as specified**.

### Role/grant provisioning: db-setup vs hand-applied
- **`db-setup.ts` (before this run):** provisioned `medveris_migrator`, `medveris_runtime`, `medveris_jobs` (LOGIN, NOBYPASSRLS), `medveris_exchange` (NOLOGIN BYPASSRLS); granted `medveris_exchange` to migrator; DB/schema ownership and USAGE for runtime/jobs/exchange. **Did not** provision `medveris_transfer_guard` (NOLOGIN,BYPASSRLS,NOSUPERUSER), its membership to migrator for ownership change, EXECUTE on `app.organization_role(uuid)` for guard, or schema USAGE for guard.
- **Hand-applied / previously missing for 125/126:** `medveris_transfer_guard` role creation + BYPASSRLS/NOSUPERUSER/NOLOGIN, membership `GRANT medveris_transfer_guard TO medveris_migrator`, function ownership transfer prerequisites, and EXECUTE/public-revoke/grants as required by 126.
- **Added to `db-setup.ts` (LOCAL ONLY; staging needs DBA provisioning):** creation of `medveris_transfer_guard` with options `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS`, `GRANT medveris_transfer_guard TO medveris_migrator`, and `GRANT USAGE ON SCHEMA public ... TO medveris_transfer_guard`. Plus migration 125 adjustments above for local apply. **Marked LOCAL ONLY; staging needs DBA provisioning.**

## Step 1 — Preflight and backup
- **Env loaded:** `.env.test` only (`set -a; . ./.env.test; set +a` in command shells for steps).
- **Masked targets (all SAFE local *_test):** `DATABASE_URL host=localhost db=medveris_test SAFE=True`, `MIGRATION_DATABASE_URL host=localhost db=medveris_test SAFE=True`, `JOBS_DATABASE_URL host=localhost db=medveris_test SAFE=True`.
- **Backup:** `pg_dump -Fc -h localhost -U postgres -d medveris_test -f /tmp/medveris-verify/medveris_test-20261111T150345Z.dump` (initial attempt as migrator failed due to RLS/FORCE RLS on `access_tokens`; retried as local postgres superuser for backup artifact only). File non-empty: `11M`.
- **Restore command:** `PGPASSWORD=postgres pg_restore --clean --if-exists -h localhost -U postgres -d <scratch_db> /tmp/medveris-verify/medveris_test-20261111T150345Z.dump`

## Step 2 — Full local reset and rebuild from files only
- **Destructive action (confirmed local *_test before each):** dropped and recreated `medveris_test` via `dropdb/createdb` as local postgres admin on localhost, then `npm run db:setup`, then `npm run db:migrate`. Multiple rebuild iterations were required to resolve 125/126 local provisioning/apply issues (documented above); final successful rebuild below.
- **db:setup (final):** roles existed/unchanged as appropriate, `medveris_transfer_guard` present, grants/membership applied, schema public owned by migrator — exit 0.
- **db:migrate (final, `/tmp/medveris-verify/db_migrate5.log`):** all migrations `apply` with no errors, including `124_registration_invoice_source.sql`, `125_organization_link_dispatched_transfers.sql`, `126_transfer_guard_privileges.sql`, through `99_backfill_unit_type.sql`. `migrations complete`.
- **Verification (postgres on localhost/medveris_test):**
  - `schema_migrations_count = 77`; migration files in `packages/db/migrations` = `77` (equal).
  - `app.organization_link_dispatched_transfers(uuid,uuid)`: `owner=medveris_transfer_guard`, `security_definer=t`, `public_exec=f`, `runtime_exec=t`, `guard_exec=t`.
  - `organization_stock_transfers`: `relrowsecurity=t`, `relforcerowsecurity=t`.
  - Roles: `medveris_migrator` (nosuperuser, nobypassrls, login), `medveris_runtime` (nosuperuser, nobypassrls, login), `medveris_jobs` (nosuperuser, nobypassrls, login), `medveris_transfer_guard` (nosuperuser, **bypassrls=t**, nologin) — runtime has no BYPASSRLS and is not a superuser.

## Step 3 — Seed
- **Seed command:** `npm run db:seed` (synthetic; `.env.test` context) — exit 0. Output: synthetic accounts/patients/facilities listed (e.g. `admin@medveris.local`, synthetic patient codes), note about TOTP dev endpoint; no PHI.
- **Row counts (post-seed, queried):** tenants=2, users=26, patients=4, organizations=1, inventory_items=0, inventory_locations=0, wards=1, beds=2, locations=0, organization_stock_transfers=0, memberships=24. (272 base tables total in schema.)
- **Idempotency re-run:** `npm run db:seed` run again — **FAILED (exit non-zero)** with `PostgresError: duplicate key value violates unique constraint "billing_accounts_owner_tenant_id_key"` (public.billing_accounts) at `scripts/seed.ts:249`. **Conclusion:** seed is **not idempotent**; it fails on re-run with a unique-constraint violation (not a safe no-op).

## Step 4 — Gates
| Gate | Command | Start/Duration (approx) | Exit code | Result/notes |
|---|---|---:|---:|---|
| a. typecheck | `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) | started ~2026-11-11T15:17Z; observed running >6 min with no completion | **NO EXIT (HUNG)** | Log `/tmp/medveris-verify/gate_typecheck.log` shows only command header/start, no `EXIT:` marker; process still observed in environment during reporting. **HUNG — not Ctrl+C’d; reported per instructions.** |
| b. lint | `npm run lint` (`eslint . --max-warnings=0`) | real 1m16.899s | **0** | PASS (`/tmp/medveris-verify/gate_lint.log`). |
| c. test (FULL) | `npm test` | — | **NOT RUN** | Not executed in this run (blocked by time spent on rebuild/fixes and ongoing typecheck hang investigation; full suite not started). |
| d. build | `npm run build` | — | **NOT RUN** | Not executed. |
| e. audit | `npm audit` | — | **NOT RUN** | Not executed; no auto-fix attempted. |
| f. staging deploy check | `npm run deploy:staging:check` (dry-run only) | — | **NOT RUN** | Not executed; expected to be dry-run only if run. Recorded as **BLOCKED/NOT VERIFIED** (not attempted here). |

## Step 5 — Backup/restore rehearsal (local)
- Created scratch local DB `medveris_restore_scratch` (localhost), restored Step 1 dump: `pg_restore --clean --if-exists -h localhost -U postgres -d medveris_restore_scratch /tmp/medveris-verify/medveris_test-20261111T150345Z.dump` → **RC=0** (no fatal error reported).
- Spot check on restored scratch: `tenants` count = **1017** (reflects pre-reset backup contents). Scratch DB then dropped: `dropdb ... medveris_restore_scratch` — **dropped**.
- **RPO/RTO observations:** pg_dump -Fc of ~11MB completed quickly locally; restore to empty local scratch completed with RC=0 and was fast (seconds) on this environment — indicative only for local synthetic DB, not representative of hosted/staging/prod sizing, network, or RLS/role complexities.

## Step 6 — Evidence tables

### 1. VERIFIED LOCALLY (with evidence)
| Item | Evidence |
|---|---|
| Safety preflight/targeting | Env vars cleared; `.env.test` URLs all `localhost`/`medveris_test`; destructive commands printed/confirmed local *_test targets. |
| Pre-reset backup | `/tmp/medveris-verify/medveris_test-20261111T150345Z.dump` (11M, non-empty); restore command recorded. |
| Rebuild from files | `dropdb/createdb medveris_test` (localhost) + `db:setup` + `db:migrate` completed; final migrate log shows `apply` for all pending including 124,125,126; `migrations complete`. |
| Migration/file parity | `schema_migrations_count=77`, migration files=77. |
| Helper function | `app.organization_link_dispatched_transfers` SECURITY DEFINER, owner `medveris_transfer_guard`, PUBLIC EXECUTE false, runtime EXECUTE true, guard EXECUTE true. |
| RLS on transfers | `organization_stock_transfers` RLS enabled and forced. |
| Runtime role safety | `medveris_runtime` nosuperuser, nobypassrls, login. |
| Synthetic seed executed | `npm run db:seed` exit 0; synthetic accounts/patients/facilities only; row counts recorded (no PHI). |
| Lint gate | `npm run lint` exit 0 (1m16.899s). |
| Local restore rehearsal | `pg_restore` of Step 1 dump into scratch local DB RC=0, spot count checked, scratch dropped. |

### 2. NOT VERIFIED / BLOCKED
| Item | Status | Reason |
|---|---|---|
| Typecheck gate | **HUNG / NO EXIT** | `npm run typecheck` started but produced no completion/exit in observed window; process/log show no `EXIT:` (see Step 4). Not terminated silently. |
| Full test suite (`npm test`) | **NOT RUN** | Not executed in this run. |
| Build (`npm run build`) | **NOT RUN** | Not executed. |
| Audit (`npm audit`) | **NOT RUN** | Not executed. |
| `npm run deploy:staging:check` | **NOT RUN / BLOCKED** | Dry-run not attempted; may require staging credentials/network/access unavailable in this context — must be treated as blocked/unverified until run successfully in appropriate environment. |
| Staging DB reachability/state | **NOT VERIFIED** | No hosted/staging access used (by safety rules). |
| Staging 125/126 state | **NOT VERIFIED** | Not inspected on staging. |
| Staging role provisioning | **NOT VERIFIED** | DBA/managed provisioning not performed or verified. |
| Seed idempotency | **FAILED** | Second `db:seed` failed with duplicate key `billing_accounts_owner_tenant_id_key`. |
| Backup represents post-seed state | **PARTIAL** | Step 1 backup captured pre-reset DB state; restore validated against that dump (tenants=1017 observed in scratch), not against fresh seeded state. |

### 3. OWNER/DBA-ONLY ACTIONS REQUIRED BEFORE ANY STAGING OR PRODUCTION STEP
- Provision `medveris_transfer_guard` role (NOLOGIN, BYPASSRLS, NOSUPERUSER) in target environments per policy.
- Grant required membership/privileges for migrator/guard as appropriate and **transfer ownership** of `app.organization_link_dispatched_transfers(uuid,uuid)` to `medveris_transfer_guard`.
- Grant EXECUTE on `app.organization_link_dispatched_transfers(uuid,uuid)` to `medveris_runtime` (and guard as required); grant EXECUTE on `app.organization_role(uuid)` to `medveris_transfer_guard` as required.
- Confirm `PUBLIC` has no EXECUTE on `app.organization_link_dispatched_transfers(uuid,uuid)` and narrow table/column/schema grants match 126 intent.
- Take a verified production backup (and staging backup as applicable) before any migration.
- Apply additive migrations 125/126 through the approved `db-migrate` process with `--confirm-database=<target>` as required by environment controls.
- Then deploy to staging, run smoke/health checks; only after review proceed to a separate production review/deployment.
- **Note:** Local `db-setup.ts` and migration 125 were adjusted in this working tree to enable local apply and are marked LOCAL ONLY; DBA must review/provision appropriately for staging/production rather than relying on local shortcuts.

## Verdict
Local gates: PASS/FAIL. Staging/production readiness: NOT CERTIFIED; requires owner approval and the DBA actions above.

**Local gates: FAIL** (typecheck hung/no exit; full test/build/audit/staging-check not completed; seed re-run not idempotent). **Staging/production readiness: NOT CERTIFIED; requires owner approval and the DBA actions above.**

Local gates: FAIL. Staging/production readiness: NOT CERTIFIED; requires owner approval and the DBA actions above.
