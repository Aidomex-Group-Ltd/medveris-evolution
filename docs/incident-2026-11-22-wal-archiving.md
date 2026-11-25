# Incident: WAL archiving failure — 2026-11-22

## Summary
PostgreSQL WAL archiving via pgBackRest stanza `medveris` stalled for approximately 50 minutes on 2026-11-22. `archive-push` failed with pgBackRest error [041] ("permission denied"). `pg_stat_archiver.failed_count` reached 141. The last good archive was at 14:15 UTC; the configuration was restored at approximately 15:03 UTC. WAL segments from 7D onward remained in `pg_wal` and were archived after the fix, so no PITR gap is expected.

## Cause
`/etc/pgbackrest/pgbackrest.conf` and the repository directory ownership/group were changed to `pgbackrest` (a new group, gid 1001) while the running PostgreSQL postmaster process did not have membership in that group. Every `archive-push` run by the PostgreSQL server process therefore failed with permission denied. Ownership was restored to `root:postgres` with mode `640`, and `deploy` was removed from the `pgbackrest` group.

## Effect
- One diff backup failed (rc=82).
- The nightly `pgbackrest check` stalled during the outage.
- WAL accumulated in `pg_wal` until archiving resumed.

## Verification
`pgbackrest --stanza=medveris info` shows a contiguous WAL min/max range across segments 7C to 97, confirming no PITR gap.

## Prevention
- `/etc/pgbackrest/pgbackrest.conf` must remain `root:postgres` mode `640`.
- The `pgbackrest` group should be deleted if nothing uses it (`getent group pgbackrest` to confirm).
- `pg_stat_archiver` is monitored every 5 minutes by `medveris-health-monitor` (docs/MONITORING.md); an increase in `failed_count` triggers the Healthchecks failure ping.
- The restore drill (`/tmp/medveris-verify-pitr.sh`) runs without `--allow-empty` and writes an attestation to `/var/lib/medveris/backup-verification.json`; the production Cloudflare gate fails if the attestation is older than 30 days or names an empty label.

## sshd brute-force activity
Repeated failed SSH authentication attempts were observed against the VPS sshd. Full source IPs are not recorded here. Findings:
- `PasswordAuthentication no` is required (key-only auth).
- `PermitRootLogin no` is required.
- `KbdInteractiveAuthentication no` is required.
- fail2ban should be active and monitoring sshd.
See GATE 2 for the confirmation commands.

## Healthchecks exposure
A Healthchecks ping URL was previously exposed in chat. That check must be deleted and replaced with new checks created by the operator: one for backups (Period 1 day / Grace 3 hours) and one for the monitor (Period 5 minutes / Grace 10 minutes). New URLs are stored on the VPS in root-only files under `/etc/medveris/` and are never sent to chat.
