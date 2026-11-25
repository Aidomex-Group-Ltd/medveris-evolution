# MedVeris Production Gap Closure Report

Date: 2026-11-23  
Repo: `/home/aidomex/medveris`  
Verdict: **B — DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA**.

## 1. Purpose

This report summarizes the reconciled state of the reviewed working tree and existing production evidence. The authoritative active register, with owner, closure criteria, and verification command for every blocker, is `docs/operations/MEDVERIS_PRODUCTION_RECOVERY_MASTER_PLAN.md`. Historical IDs and preserved audit findings are mapped in `docs/audit/BLOCKERS.md`.

This reconciliation used existing evidence only. No production connection, migration, deployment, secret change, source change, test mutation, or patient-data action was performed for this task.

## 2. Evidence snapshots

| Evidence | Time / result |
|---|---|
| Historical audit snapshot | `2026-11-23T09:49:39Z` |
| Latest read-only production evidence | `2026-11-23T16:21:56Z` |
| Latest local targeted test evidence | `2026-11-23T19:36:13Z` |
| Git HEAD | `7117f36813126010d03e20d975ce97437ecd3388` |
| Git working tree | `21` modified tracked entries, `17` untracked entries |

Stale counts from the historical snapshot are retained only in `docs/audit/`; current operational documents use `17` untracked entries and latest pgBackRest `NRestarts=17417`.

## 3. Production baseline

Production `medveris-prod` at `2026-11-23T16:21:56Z`, PostgreSQL `18.6`:

- Ledger rows `89`; numeric latest `138`; migrations `139`–`146` absent.
- `3` tenants, `6` users, `2` memberships, `4` patients, `4` sessions, `17` audit events.
- `0` patient accounts, tenant-patient links, exchange grants, outbox events, integration clients, and integration tokens.
- RLS disabled on `10` public tables, including `integrity_checkpoints`, `integrity_checkpoint_events`, and `ledger_anchors`.
- `13` unconditional `ALL` policies and runtime DELETE grants on `163` tables.
- `3` direct `current_setting` policies; legacy GUC helpers remain.
- `32` SECURITY DEFINER functions; `medveris_exchange` and `medveris_transfer_guard` have `BYPASSRLS`.

No PHI values or secret values were printed.

## 4. Local verification results

| Check | Result |
|---|---|
| `npm run lint` | `0` |
| `npm run typecheck` | `0` |
| `tests/unit/production-gate.test.ts` | `26/26` |
| `tests/integration/platform-role-guc.test.ts` | `6/6` |
| `tests/integration/rls.test.ts` | `6/6` |
| `tests/integration/patients.test.ts` | `9/9` |

Logs are in `/tmp/ready/phaseA/`. These results support `SOURCE TESTED` and targeted `VERIFIED IN LOCAL TEST DATABASE` claims only.

## 5. Reconciled gap status

| Category | Canonical IDs | Current status |
|---|---|---|
| Migrations and local parity | `MIG-001`–`MIG-004`, `LOC-001` | Source reviewed/tested; local DB at latest `146`; production application blocked. |
| Backup and recovery | `DR-001`–`DR-005` | Operator action required; service unstable, no valid inventory/label, no post-incident PITR. |
| Infrastructure and provenance | `INF-001`–`INF-007` | Worker stale, tree dirty, Cloudflared unit unsafe, alerting/perf/locality unresolved. |
| RLS and tenant isolation | `RLS-001`–`RLS-007` | Targeted local tests pass; production parity absent; SECURITY DEFINER sign-off absent. |
| Privacy and payments | `PRIV-001`, `PAY-001` | Legal/product decision and provider alignment required. |
| Functional readiness | `TEST-001`–`TEST-005` | Targeted patient/RLS/platform slices pass; full suite and older failing areas remain open. |

No canonical blocker has `APPLIED TO PRODUCTION` or `VERIFIED IN PRODUCTION` status.

## 6. Working tree boundary

The current tree contains the reviewed source, migration, test, runbook, workflow, and evidence changes listed by `git status`. Prohibited artifacts remain present and must not be committed or used as evidence:

- `sshpass_1.09-1_amd64.deb`
- `seed-drill-prod.sql`
- `tmp-*`
- `medveris-verify-pitr-fixed.sh`

The unsafe PITR helper mutates pgBackRest configuration, installs a wrapper/cron, switches WAL, writes attestation, and requires populated patient tables. It must not be executed.

## 7. Recommendation

Keep the verdict at **B — DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA**. Production approval requires the master plan’s exact closure commands to pass in their named environments, a clean reviewed release, migration parity, verified backup/PITR, verified RLS and role posture, green full test suite, truthful integrations, and human/legal sign-off.
