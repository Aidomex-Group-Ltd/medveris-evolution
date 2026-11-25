# Production Infrastructure Review

| Item | Value |
|---|---|
| Audit timestamp | `2026-11-23T09:49:39Z` (UTC) |
| Scope | Read-only production server, service, network, Cloudflare Worker, and operational configuration review |
| Server | Ubuntu `26.04.1 LTS`, kernel `7.0.0-38-generic` |
| Cloudflare Worker | `medveris-production`, version `13001954-5d14-48c3-9378-ca65c04c370c` |
| Verdict | **B. DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA** |

## Evidence

### Host and network

Read-only SSH checks through `medveris-hapi` returned:

| Item | Value |
|---|---|
| OS | Ubuntu `26.04.1 LTS` |
| Kernel | `7.0.0-38-generic` |
| Uptime | `15d 22:24` |
| Load average | `0.16 0.05 0.07` |
| RAM | `7.3 GiB` total, `3.4 GiB` used, `3.9 GiB` available |
| Swap | `0 B` |
| Root filesystem | `148 G`, `35 G` used (`25%`) |
| Inode usage | `5%` |
| Public interface | `ens18`, `113.30.188.181/24` |
| Docker bridges | `172.17.0.1/16`, `172.18.0.1/16` |

Access facts:

- Direct passwordless SSH to `deploy@113.30.188.181` failed: `Permission denied (publickey,password).`
- SSH alias `medveris-hapi` works with `/home/aidomex/.ssh/medveris_kamatera`.
- Root SSH failed: `Permission denied (publickey,password).`
- `deploy` has groups `1000(deploy),27(sudo)`; not in `docker`.
- `sudo` requires interactive authentication.

### Services

- `pgbackrest.service`: `activating (start-post) (Result: exit-code)`, `NRestarts=16221`, `Restart=always`, `RestartUSec=1s`, `StartLimitIntervalUSec=0`, `StartLimitIntervalSec=0`.
- `/usr/bin/pgbackrest server` exits `status=37`.
- `/etc/systemd/system/cloudflared-medveris.service` is `-rw-r--r-- deploy deploy` but runs `User=root`.

### Cloudflare Worker

- Account ID: `6337ed24a5f8ff4ec3f74517a55a7e6b`.
- Worker: `medveris-production`, environment production.
- Deployment ID: `14626db4-8fbc-4d06-b0c6-25c9ffa35bd7`.
- Version: `13001954-5d14-48c3-9378-ca65c04c370c`, number `25`, tag `18f842a`, created `2026-11-13T13:20:37.83605Z`, `100%` traffic.
- Handlers: `fetch`, `scheduled`, `queue`.
- Durable Objects: `RateLimiterObject`, `RealtimeHub`.
- Bindings: `HYPERDRIVE`, `HYPERDRIVE_JOBS`, `UPLOADS=medveris-production-uploads`, `JOBS_QUEUE=medveris-production-jobs`, `JOBS_DLQ=medveris-production-jobs-dlq`.
- Compatibility date: `2026-10-19`; flag `nodejs_compat`.
- Worker source tag `18f842a` does not match reviewed commit `7117f36813126010d03e20d975ce97437ecd3388`.

### Observability and configuration

- Gate checks support-center URL reachability but not alert destination or Cloudflare alert token.
- Support center is pull-only; no evidence of proactive push alerts.
- Worker secrets were listed by name only where possible; values were not printed or verified.
- Placement/DB region relationship remains unresolved (`PERF-01`).
- Protected object delivery buffers whole objects in Worker memory (`PERF-02`).
- No repo evidence of slow-query or lock-contention diagnostics (`PERF-03`).

## Findings

### `INF-HIGH-01` — Root-run systemd unit is writable by deploy

Severity: High.

The Cloudflared unit runs as root but is owned by `deploy:deploy` with mode `0644`. A compromised `deploy` account can change root-executed service configuration.

Remediation: set owner `root:root`, mode `0644`, validate with `systemd-analyze verify`; restart only in approved window.

Retest: non-root write attempt fails; service health remains green.

### `INF-HIGH-02` — pgBackRest restart storm

Severity: High.

A crash-looping backup daemon affects availability and recovery readiness.

Remediation: fix configuration/permissions, add restart limits and alerting, monitor service state.

Retest: stable service state over agreed observation window.

### `INF-HIGH-03` — Deployed Worker is stale relative to reviewed commit

Severity: High.

Version `13001954...` has tag `18f842a`; reviewed local HEAD is `7117f36`. Production may not contain current hardening fixes.

Remediation: deploy from clean reviewed tree; record new version and tag.

Retest: Worker version/tag matches release manifest.

### `INF-MED-01` — Privileged operations are not auditable from current account

Severity: Medium.

Interactive sudo blocks read-only checks and incident response.

Remediation: define narrowly scoped audited sudoers commands for required diagnostics; avoid broad passwordless sudo.

Retest: authorized diagnostics run with command logging.

### `INF-MED-02` — No verified Worker/DB locality strategy

Severity: Medium.

No evidence was found that Worker placement and database/Hyperdrive region were chosen to minimize latency or meet data-residency expectations.

Remediation: document region choice, data-residency requirements, and latency benchmark.

Retest: benchmark and sign-off recorded.

### `INF-MED-03` — Storage delivery buffers full objects

Severity: Medium.

`apps/api/src/lib/storage.ts` buffers whole protected objects in Worker memory, risking memory pressure for large files.

Remediation: stream objects or enforce size limits with monitoring.

Retest: large-file transfer test stays within memory limits.

### `INF-MED-04` — Alerting is not end-to-end verified

Severity: Medium.

URL reachability does not prove alert delivery.

Remediation: trigger test alerts and verify destination/token.

Retest: alert received by on-call destination and logged.

## Infrastructure conclusion

Infrastructure approval is withheld due to root-unit writability, backup service instability, stale deployment provenance, and incomplete observability evidence.
