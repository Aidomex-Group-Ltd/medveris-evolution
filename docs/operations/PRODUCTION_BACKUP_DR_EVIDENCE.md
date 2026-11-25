# Production Backup and Recovery Evidence

Date: 2026-11-23
Repo: `/home/aidomex/medveris`
Safety: read-only evidence; no backup, pgBackRest, systemd, secret, or database change was made.

## 1. Evidence

| Evidence | Path |
|---|---|
| Read-only host/unit capture | `/tmp/ready/recovery-readonly.out` |
| Read-only DB/WAL capture | `/tmp/ready/recovery-readonly-db.out` |
| Archiver capture | `/tmp/ready/recovery-archiver.out` |
| Root diagnostic attempt | `/tmp/ready/change1.out` |
| Proposed changes | `/tmp/ready/STEP2_PROPOSED_CHANGES.md` |
| Staging-only PITR plan | `/tmp/ready/STEP2_STAGING_PITR_PLAN.md` |
| Aggregate-only PITR verifier | `/tmp/ready/verify-pitr-staging.sh` |
| Audit report | `docs/audit/PRODUCTION_BACKUP_DISASTER_RECOVERY_REVIEW.md` |

## 2. Current production archive facts

| Check | Evidence |
|---|---|
| `archive_mode` | `on` |
| `archive_command` | `pgbackrest --stanza=medveris archive-push %p` |
| `archive_timeout` | `1min` |
| `last_archived_wal` | `000000010000000300000079` |
| `last_archived_time` | `2026-11-23 10:51:20.900253+00` |
| `last_failed_wal` | `00000001000000010000007D` |
| `last_failed_time` | `2026-11-22 15:01:23.032371+00` |
| `archived_count` | `896` |
| `failed_count` | `141` |
| Recent failure check | `PASS` |
| Archive lag at capture | `00:03:15.769834` |
| Repository free space | `107G` free, `25%` used |
| Repository path | `/var/lib/pgbackrest`, owner `postgres:pgbackrest`, mode `750` |

WAL archiving is currently recent, but this is not proof of recoverability.

## 3. Blocking facts

| ID | Evidence | Disposition |
|---|---|---|
| `DR-CRIT-01` | `PRODUCTION_BACKUP_INVENTORY` absent; no valid `backup-inventory.json`; `backupLabel=""` | `APPLICATION BLOCKED` |
| `DR-CRIT-02` | `pgbackrest.service` observed `activating (start-post)`, `NRestarts=17417` in latest capture; earlier audit snapshot `16221`; exit `37`; `/usr/bin/pgbackrest server` fails with `ERROR: [037]: server command requires option: tls-server-auth` | Critical, operator blocked |
| `DR-CRIT-03` | Existing attestation has `result="pass"` but empty `backupLabel`; provider text mismatch exists in older docs | Not acceptable evidence |
| `DR-HIGH-01` | No post-incident isolated restore/PITR drill accepted | Critical, operator blocked |
| `DR-HIGH-02` | `sudo -n` diagnostics fail with `sudo: interactive authentication is required`; `/etc/pgbackrest/pgbackrest.conf` unreadable by `deploy`; config `stat` blocked by permissions | Operator blocked |
| `INF-MED-01` | No scoped audited sudo diagnostic path | Should-fix |
| `DR-MED-01` | `medveris-verify-pitr-fixed.sh` is untracked and unsafe as-is | Must not execute as evidence |

## 4. Alerting gaps

- `/etc/medveris/backup-alert-webhook` exists but is empty (`0` bytes).
- `/etc/medveris/healthchecks-ping-url` is non-empty but was not printed.
- No `medveris-health-monitor` unit was found.
- URL reachability is not proof of alert delivery.

## 5. Required operator sequence

No command below was executed in this session.

1. Review and correct the root-run pgBackRest server invocation or disable the unintended server mode with operator approval.
2. Provide a narrowly scoped audited sudo path for `pgbackrest info/check` and config stat.
3. Stop the restart storm and confirm `NRestarts` is stable over a watch window.
4. Capture real inventory: `pgbackrest info --stanza=medveris --output=json`.
5. Store inventory as production secret `PRODUCTION_BACKUP_INVENTORY`.
6. Run an isolated restore/PITR drill using a separate data directory, socket, and port; production remains on `/var/lib/postgresql/18/main`, port `5432`.
7. Record a new attestation with a real full-backup label, target time, checksums, actor, timestamp, RTO, and RPO.
8. Verify `npm run deploy:production:check` passes with the real inventory.

## 6. PITR safety boundary

`medveris-verify-pitr-fixed.sh` must not be used as evidence. It mutates production pgBackRest config, installs a wrapper/cron, runs `pg_switch_wal()`, writes an attestation, and requires non-empty patient/organization tables.

The reviewed staging plan is `/tmp/ready/STEP2_STAGING_PITR_PLAN.md`; the verifier `/tmp/ready/verify-pitr-staging.sh` compares aggregate counts and catalog state only, and does not read or write PHI.

## 7. Decision

- Observed in production: archival recency only.
- `VERIFIED IN PRODUCTION` for backup/PITR: none.
- Recovery approval is withheld until inventory, service stability, named full-backup label, and isolated PITR evidence pass.
