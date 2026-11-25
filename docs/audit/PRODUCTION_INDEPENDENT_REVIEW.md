# Production Independent Review

| Item | Value |
|---|---|
| Audit timestamp | `2026-11-23T09:49:39Z` (UTC) |
| Audit mode | Read-only independent review; no production writes, deployments, migrations, DNS changes, secret changes, or backup changes |
| Intended application commit | `7117f36813126010d03e20d975ce97437ecd3388` (`7117f36 fix(db): harden multi-tenant RLS policies`) |
| Deployed Worker | `medveris-production`, account `6337ed24a5f8ff4ec3f74517a55a7e6b` |
| Deployed Worker version | `13001954-5d14-48c3-9378-ca65c04c370c`, number `25`, tag `18f842a`, created `2026-11-13T13:20:37.83605Z`, traffic `100%` |
| Deployment ID | `14626db4-8fbc-4d06-b0c6-25c9ffa35bd7` |
| Production database | `medveris-prod`, user `medveris_migrator`, PostgreSQL `18.6`, `127.0.0.1:5432` via SSH tunnel, `pg_is_in_recovery=f` |
| Production endpoints | `https://medveris.online`, `https://www.medveris.online` |
| Final verdict | **B. DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA** |

## Scope

The review covered deployment provenance, production database and migration state, RLS/tenant isolation, backup and disaster recovery, server and Cloudflare infrastructure, operational observability, legal/privacy posture, payment and integration readiness, and local test evidence. No live patient data was created, read in detail, modified, or exported. Only aggregate counts and catalog metadata were queried.

## Evidence collected

### Source and deployment provenance

Commands and results:

- `git rev-parse HEAD` → `7117f36813126010d03e20d975ce97437ecd3388`
- `git log -1 --format='%h %s'` → `7117f36 fix(db): harden multi-tenant RLS policies`
- `git status --short` → `21` modified tracked files and `5` untracked files.
- Modified tracked files include workflow, API route, migration, rollback, script, test, and runbook files; the complete list is recorded in `docs/audit/PRODUCTION_GO_LIVE_ACCEPTANCE.md`.
- `npx --no-install wrangler --version` → `4.164.0`
- `npx --no-install wrangler deployments list --env production` → deployed version `13001954-5d14-48c3-9378-ca65c04c370c`, number `25`, tag `18f842a`, created `2026-11-13T13:20:37.83605Z`, `100%` traffic.
- Worker handlers observed: `fetch`, `scheduled`, `queue`.
- Durable Object classes observed: `RateLimiterObject`, `RealtimeHub`.
- Bindings observed: `HYPERDRIVE`, `HYPERDRIVE_JOBS`, `UPLOADS=medveris-production-uploads`, `JOBS_QUEUE=medveris-production-jobs`, `JOBS_DLQ=medveris-production-jobs-dlq`.
- Compatibility date `2026-10-19`; flag `nodejs_compat`.

Finding: deployed source tag `18f842a` does not match the intended local commit `7117f36`; no evidence was found that the local RLS hardening commits and uncommitted fixes are present in the running Worker.

### Production database identity and aggregate state

A temporary read-only SSH tunnel was opened to `127.0.0.1:55432` and `MIGRATION_DATABASE_URL` was used without printing credentials.

Commands and results:

- `select current_database(), current_user, version(), inet_server_addr(), inet_server_port(), pg_is_in_recovery();`
  - `medveris-prod`, `medveris_migrator`, `PostgreSQL 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)`, `127.0.0.1`, `5432`, `f`.
- Aggregate counts:
  - `tenants=3`, `users=6`, `memberships=0`, `patients=0`, `patient_accounts=0`, `audit_events=0`, `exchange_grants=0`, `outbox_events=0`.
  - These are fresh count-only results; no PHI or row contents were inspected.
- RLS catalog counts:
  - `public_tables=280`, `rls_tables=270`, `force_rls_tables=270`.
  - `integrity_checkpoint_events`, `integrity_checkpoints`, and `ledger_anchors` remain without RLS.
- `select count(*) from public.schema_migrations` → `89`; `max(version)` lexicographically → `99_backfill_unit_type.sql`; latest numeric migration → `138_clinical_entry_attachments_rls.sql`.
- Pending repository migrations: `139` through `146` inclusive.
- Direct policy check confirmed production still has `integration_tokens_all` as `ALL ... USING true ... WITH CHECK true`, `patients_staff_read` without tenant restriction, and `patient_accounts_staff` with only `actor_kind='staff'`.

### Production host and services

Read-only SSH checks through `medveris-hapi` established:

- Ubuntu `26.04.1 LTS`, kernel `7.0.0-38-generic`, uptime `15d 22:24`, load `0.16 0.05 0.07`.
- RAM `7.3 GiB` total, `3.4 GiB` used, `3.9 GiB` available; swap `0 B`.
- Root filesystem `148 G`, `35 G` used (`25%`); inode usage `5%`.
- Public address `113.30.188.181/24` on `ens18`; Docker bridges `172.17.0.1/16`, `172.18.0.1/16`.
- `pgbackrest.service` is in `activating (start-post) (Result: exit-code)`, `NRestarts=16221`, `Restart=always`, `RestartUSec=1s`, `StartLimitIntervalUSec=0`, `StartLimitIntervalSec=0`.
- `/usr/bin/pgbackrest server` exits with `status=37`.
- `/etc/systemd/system/cloudflared-medveris.service` is `-rw-r--r-- deploy deploy` but runs `User=root`.

### Authentication, secrets, and backup gate

- `gh auth status --hostname github.com` OK as `aidomexgroup-commits`.
- Wrangler auth OK with scopes including `account (read)`, `workers (write)`, `workers_scripts (write)`, `zone (read)`, `queues (write)`, `secrets_store (write)`, `connectivity (admin)`.
- `gh secret list --env production` does not include `PRODUCTION_BACKUP_INVENTORY`.
- `docs/../production/backup-verification.json` contains `result="pass"` but `backupLabel=""`; the production gate treats the attestation as failed.
- `checkBackupAttestation(...)` fails with messages requiring a pgBackRest inventory and a named full backup label.
- Provider in attestation is `Kamatera`; older documentation still references Aiven, so docs must be reconciled rather than silently changing provider identity.

### Quality gates and tests

- `npm run lint` → passed.
- `npm run typecheck` → passed.
- `npx vitest run --config vitest.config.ts tests/unit/production-gate.test.ts` → `26` tests passed.
- Full suite in `/tmp/medveris-npm-test.log` → `RC=1`, `Test Files 8 failed | 99 passed (107)`, `Tests 7 failed | 929 passed | 33 skipped (969)`.
- Targeted rerun in `/tmp/medveris-targeted2.log` → `RC=1`, `Test Files 3 failed | 5 passed (8)`, `Tests 6 failed | 99 passed (105)`.
- Observed failure classes: `new row violates row-level security policy for table "sponsored_daily_metrics"`, `permission denied for table integration_clients`, and a radiology worklist `TypeError: Cannot read properties of undefined (reading 'stage')`.
- Local follow-up fixes for audit context, integration client grants, and sponsored metric policy were made after those logs, but the full suite was not rerun after those fixes.

## Consolidated findings

| ID | Severity | Finding |
|---|---|---|
| `IND-01` | Critical | Production is 8 migrations behind; RLS hardening `139`–`146` is not applied. |
| `IND-02` | Critical | Backup/PITR recovery is unverified; pgBackRest service is crash-looping and no valid inventory/label exists. |
| `IND-03` | High | Deployed Worker tag `18f842a` does not match intended commit `7117f36`. |
| `IND-04` | High | Working tree is dirty; `scripts/production-deploy.mjs` blocks non-dry-run deployment. |
| `IND-05` | High | Production still contains broad RLS policies and RLS-disabled integrity/ledger tables. |
| `IND-06` | High | `cloudflared-medveris.service` is writable by `deploy` but runs as root. |
| `IND-07` | High | Privacy notice promises self-service routes that are not implemented. |
| `IND-08` | Medium | Payment mode/adapters are inconsistent with production gate configuration. |
| `IND-09` | Medium | Observability, integration availability, and secrets/provider callback behavior are not fully verified. |

## Verdict rationale

The system is deployed and reachable, but unresolved Critical and High findings affect patient confidentiality, integrity, availability, and recovery. The acceptance criteria require those findings to be resolved before real patient data is allowed. Therefore the verdict is:

**B. DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA**

## Required retest before re-review

1. Commit or intentionally preserve all local fixes; clean the working tree or use an approved controlled release path that does not require a dirty tree.
2. Deploy the exact reviewed commit and record the resulting Worker version/tag.
3. Apply and verify migrations `139`–`146`, including RLS catalog diff and policy regression tests.
4. Repair pgBackRest service, capture real `pgbackrest info --output=json` inventory, perform a post-fix restore/PITR drill, and set a non-empty backup label.
5. Reconcile provider documentation, payment adapters, privacy self-service routes, observability destination/token checks, and integration availability semantics.
6. Rerun `npm test`, `npm run lint`, `npm run typecheck`, and the production gate dry-run; archive logs.

## Assumptions and blockers

- Assumed local HEAD is the intended application version; no production source artifact was available to prove otherwise.
- Privileged server checks were blocked because `sudo` requires an interactive TTY.
- pgBackRest inventory could not be read because `/etc/pgbackrest/pgbackrest.conf` is unreadable to `deploy` and `sudo -n` is unavailable.
- Live external integrations and payments were not exercised to avoid side effects and credential exposure.
