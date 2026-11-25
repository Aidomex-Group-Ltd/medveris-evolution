# Production Backup and Disaster Recovery Review

| Item | Value |
|---|---|
| Audit timestamp | `2026-11-23T09:49:39Z` (UTC) |
| Scope | Read-only backup configuration, attestation, gate, service state, and restore-drill evidence review |
| Database | `medveris-prod` |
| pgBackRest version observed historically | `2.58.0` |
| Stanza | `medveris` |
| Verdict | **B. DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA** |

## Evidence

### Current attestation

`production/backup-verification.json` contains:

```json
{
  "provider": "Kamatera",
  "targetDatabase": "medveris-prod",
  "pointInTimeRecovery": true,
  "encryptedBackups": true,
  "restoreDrillBy": "deploy",
  "restoreDrillAt": "2026-11-21T21:17:08Z",
  "result": "pass",
  "backupLabel": "",
  "targetTime": "2026-11-21 21:16:59+00"
}
```

The file asserts success but has an empty `backupLabel`.

### Gate behavior

`checkBackupAttestation(attestation, now, inventory)` fails with:

- `pgBackRest inventory is missing; supply the production stanza inventory captured with \`pgbackrest info --output=json\``
- `backup verification must name the pgBackRest full backup label that was restored`

`gh secret list --env production` does not contain `PRODUCTION_BACKUP_INVENTORY`.

`docs/deployment-runbook.md` and `scripts/production-deploy.mjs` expect a `backup-inventory.json`; no valid production inventory was found.

### pgBackRest service

Read-only service checks:

- `pgbackrest.service`: `activating (start-post) (Result: exit-code)`
- `NRestarts=16221`
- `Restart=always`, `RestartUSec=1s`
- `StartLimitIntervalUSec=0`, `StartLimitIntervalSec=0`
- `/usr/bin/pgbackrest server` exits `status=37`

Inventory read attempts:

- `ssh medveris-hapi 'pgbackrest info --stanza=medveris --output=json'` → `rc=41`
- Error: `P00 ERROR: [041]: unable to open file '/etc/pgbackrest/pgbackrest.conf' for read: [13] Permission denied`
- `ssh medveris-hapi 'sudo -n pgbackrest info --stanza=medveris --output=json'` → `rc=1`
- Error: `sudo: interactive authentication is required`

Directory permissions from prior evidence:

- `/var/lib/pgbackrest` is `drwxr-x--- postgres pgbackrest`
- `deploy` is not in group `pgbackrest` (`pgbackrest:x:1001:postgres`)

### Historical backup evidence

Prior evidence recorded:

- pgBackRest `2.58.0`, stanza `medveris`, repository `/var/lib/pgbackrest`, encryption `aes-256-cbc`.
- Historical full backups included `20261122-052803F` and `20261122-150349F`.
- Latest reported WAL segment: `000000010000000200000006`.
- A WAL archiving incident is tracked in untracked `docs/incident-2026-11-22-wal-archiving.md`.
- Current attestation claims PITR to `2026-11-21 21:16:59+00`, before the later historical backup labels and incident evidence.

### Provider mismatch

Current attestation/gate uses `Kamatera`. Older documentation refers to Aiven. The provider identity must be reconciled in documentation and evidence; it must not be changed merely to satisfy the gate.

## Findings

### `DR-CRIT-01` — No valid backup inventory

Severity: Critical.

The gate requires a real pgBackRest JSON inventory, but none is present and the GitHub environment secret is absent. A generic or fabricated inventory would defeat the control.

Remediation: capture `pgbackrest info --stanza=medveris --output=json` through an approved privileged process, store as production environment secret `PRODUCTION_BACKUP_INVENTORY`, and update runbook path.

Retest: deployment gate dry-run passes using real inventory.

### `DR-CRIT-02` — pgBackRest daemon is crash-looping

Severity: Critical.

A service with `NRestarts=16221` and repeated exit `status=37` cannot be considered a dependable backup control plane.

Remediation: diagnose and fix configuration/permission failure, stop restart storm, validate daemon health, monitor restarts.

Retest: service active for sustained observation window with zero recent restarts; `pgbackrest check --stanza=medveris` succeeds.

### `DR-CRIT-03` — Attestation is not credible

Severity: Critical.

`result="pass"` conflicts with empty `backupLabel`, missing inventory, inaccessible config, provider mismatch, and absent post-incident restore evidence.

Remediation: mark DR unverified until a new post-fix full restore and PITR drill is performed with named label, target time, checksums, actor, and timestamp.

Retest: attestation contains non-empty label, real inventory reference, provider consistency, and passing gate result.

### `DR-HIGH-01` — No independently verified post-incident PITR drill

Severity: High.

The recorded drill predates later backup labels and the WAL archiving incident; no evidence proves recovery after the incident fix.

Remediation: perform full restore to isolated location and PITR to a controlled target; compare schema/data signatures; archive evidence.

Retest: restore signatures match source signatures for the selected target; PITR lands within acceptance window.

### `DR-HIGH-02` — Privileged evidence collection blocked

Severity: High.

`sudo` requires interactive TTY and config/repository permissions deny `deploy`. This prevents routine read-only inventory checks.

Remediation: add a narrowly scoped, audited role or sudoers command for `pgbackrest info` and `pgbackrest check`; avoid blanket privileges.

Retest: authorized operator can collect inventory without interactive shell and without exposing secrets.

### `DR-MED-01` — Untracked helper has side effects

Severity: Medium.

`medveris-verify-pitr-fixed.sh` can modify retention, install wrappers, create cron, initiate backups, create scratch restores, and overwrite the attestation. It must not be executed as audit evidence.

Remediation: review, rewrite as idempotent documented runbook steps, and keep under version control with change approval.

Retest: runbook execution is approved, logged, and reproducible.

## DR acceptance criteria

1. pgBackRest service healthy with no restart storm.
2. Real inventory captured and stored as `PRODUCTION_BACKUP_INVENTORY`.
3. Full backup label recorded and non-empty.
4. Post-fix full restore and PITR drill pass with signatures and target time.
5. Gate dry-run passes without weakening checks.
6. Provider documentation reconciled to actual infrastructure.

## Conclusion

Disaster recovery approval is withheld. Current backup evidence fails the configured gate and cannot demonstrate recoverability.
