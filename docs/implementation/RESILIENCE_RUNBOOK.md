# Resilience runbook

Operational procedures for the scaling features described in [`SCALABILITY_AND_RESILIENCE.md`](SCALABILITY_AND_RESILIENCE.md). Use synthetic data for every drill. Never paste tokens, cookies, connection strings or record content into tickets or chat.

## 1. Staging provisioning and first release with Durable Objects and queues

Prerequisites: Wrangler logged in to account `6337ed24a5f8ff4ec3f74517a55a7e6b`, staging database credentials in `~/.config/medveris/staging/db.env`.

1. Create the queues (small usage-based cost):
   ```sh
   npx wrangler queues create medveris-staging-jobs
   npx wrangler queues create medveris-staging-jobs-dlq
   ```
2. Apply migration 030 to staging **before** deploying code. It is additive; the version currently live keeps working against it.
   ```sh
   node --env-file="$HOME/.config/medveris/staging/db.env" node_modules/.bin/tsx scripts/db-migrate.ts --confirm-database=medveris_staging
   ```
   Do not `source` the file: `&` in the URLs splits the assignments (see `docs/16_OPERATIONS_AND_DEPLOYMENT.md`).
3. `npm run deploy:staging:check`. Expect exactly one problem: the pending Durable Object migration `v1-scaling`.
4. `node scripts/staging-deploy.mjs --apply-durable-object-migrations`. This one release uses `wrangler deploy` (traffic moves at once), probes health, and restores the previous version if the probe fails. Later releases use the normal blue-green path.
5. Verify: `VERIFY_ORIGIN=https://medveris-staging.aidomexgroupltd.workers.dev node scripts/runtime-verify.mjs`. The cron-trigger step only works locally; on staging, wait for the 5-minute cron. The Worker-cache check reports `miss` on workers.dev, where the Cache API does nothing.
6. Load baseline: `LOAD_ORIGIN=https://medveris-staging.aidomexgroupltd.workers.dev LOAD_WRITE_SHARE=0 npm run load:test`.

Cleanup: `npx wrangler queues delete <name>`. Durable Object classes are removed only by a `deleted_classes` migration, which destroys their (non-clinical) state.

Production uses the same steps with `medveris-production-*` names and remains blocked by the items in `PRODUCTION_READINESS.md`. Do not promote without approval.

## 2. Read replica (BLOCKED)

1. Get approval for the cost of an Aiven plan with read replicas, then create the replica in the same project and region.
2. Create a Hyperdrive config for it with `--caching-disabled`, the `medveris_runtime` role and `verify-full` TLS.
3. Add `{ "binding": "HYPERDRIVE_REPLICA", "id": "<id>" }` to the environment and set `DB_REPLICA_ENABLED=true` (staging first). Startup refuses the flag without the binding.
4. Check `/api/v1/ops/status` (`database.replica.state` = `healthy`, `lagMs` small), then stop replication or load the primary to confirm that reports switch to `dataSource: "primary"` when lag exceeds `DB_REPLICA_MAX_LAG_MS`.
5. Promotion is provider-managed. Never point `HYPERDRIVE` at a promoted replica while the old primary may still accept writes. The application refuses to use a non-standby as a replica, but primary selection is an operator decision (see §3).

## 3. Database or region failure

Symptoms: `database_unavailable` 503s, `/health/ready` reports `unreachable`, breaker `database.primary` open in `/api/v1/ops/status`.

1. Confirm the scope in the Aiven console (service state, maintenance, failover events). Do not restart Workers; isolates retry automatically after the breaker's 5-second window.
2. If Aiven performs a managed failover, Hyperdrive reconnects to the same hostname. Watch the 503 rate fall and readiness recover. Record the start and end times (recovery duration).
3. If the service is lost: activate the clinical downtime procedure (`docs/16_OPERATIONS_AND_DEPLOYMENT.md`), restore to a new service from the most recent backup or point-in-time, update both Hyperdrive configs to the new origin, and run `npm run deploy:staging:check` / `deploy:production:check` to confirm the targets.
4. Before resuming writes, confirm exactly one primary accepts writes (`select pg_is_in_recovery()` is false on it only) and the old one is fenced.
5. After recovery: run `npm run jobs:dead-letters`, check the outbox backlog in ops status, and reconcile notifications that may have been sent twice (consumers deduplicate by event ID; external providers may not).
6. Clients retry idempotent commands with their `Idempotency-Key` to learn whether a write committed before the connection dropped. Non-idempotent clinical writes are not retried automatically.

Proposed objectives (not yet demonstrated): RPO ≤ 15 minutes, RTO ≤ 4 hours. Record actual values after every drill.

## 4. Queue backlog, failures and replay

- Backlog: `/api/v1/ops/status` → `outbox` (`pending`, `queued` counts and oldest age). Rows stuck in `processing` for over 10 minutes or `queued` for over 30 minutes are reclaimed automatically each cron cycle.
- Dead letters: `npm run jobs:dead-letters` (IDs, types, error class only). Fix the cause first, then:
  ```sh
  npm run jobs:replay -- --ids=<id,id> --operator="<name>" --reason="<why>"
  ```
  Replay is recorded in `outbox_replays` and is idempotent.
- Poison messages (`job_poison_message` logs) mean a producer/consumer contract mismatch or tampering. Investigate before replaying.

## 5. Rate limiting

- Spike in `ratelimit.rejected` for sign-in: check whether it comes from one address or many (credential stuffing). Account-target limits apply to failed attempts only.
- `ratelimit.coordination_failure`: Durable Objects unavailable. Sensitive policies, including invitation registration, are limited per instance at a quarter of quota. Escalate if it lasts more than 10 minutes.
- Emergency override (for example a mass re-enrolment day): add to `RATE_LIMIT_OVERRIDES`, e.g. `[{"policy":"auth.login","factor":2,"expiresAt":"<≤7 days>","reason":"<why>"}]`, and deploy. The change is recorded in version history and expires by itself.

## 6. Dashboards and alerts

Create these as Workers Observability saved queries on `medveris-staging` (then production). "Human" marks alerts that need someone to act.

| Signal | Query (Workers Logs) | Alert | Human |
|---|---|---|---|
| API error rate | `event = "http_request"` grouped by `status >= 500` | > 2% for 5 min | Yes |
| Latency | `event = "http_request"` p95 of `ms` by `route` | p95 > 2 s for 10 min | Yes |
| Database unavailable | `event = "database_unavailable"` count | > 20 in 5 min | Yes |
| Queue backlog | `metric = "jobs.backlog"` with `status = "pending"`, `oldestSeconds` | oldest > 900 s | Yes |
| Dead letters | `metric = "jobs.dead_letter"` or `jobs.poison` | any | Yes |
| Relay failures | `metric = "jobs.relay"` with `outcome = "failed"` | 3 consecutive cycles | Yes |
| Checkpoint failure | `event = "checkpoint_failed"` | any | Yes |
| Rate-limit coordination | `metric = "ratelimit.coordination_failure"` | > 10 in 5 min | Yes |
| Rejections | `metric = "ratelimit.rejected"` by `policy` | 10× baseline | Review |
| Cache effectiveness | `metric = "cache.lookup"` by `outcome` | hit rate < 50% for an hour (production) | No |
| Real-time | `metric = "realtime.connect"` by `outcome`, `realtime.publish_failed` | refused > 20% | Review |
| Replica lag | `/api/v1/ops/status` `database.replica.lagMs` (external monitor) | > `DB_REPLICA_MAX_LAG_MS` for 5 min | Yes, once a replica exists |
| Readiness | external uptime check on `/api/v1/health/ready` | 2 consecutive failures | Yes |

## 7. Failure-injection drills (staging, synthetic data)

| Drill | How | Expected |
|---|---|---|
| Database interruption | Aiven maintenance or a controlled service restart on staging | 503 + Retry-After, breaker opens, recovery within the breaker window after the service is back, no lost committed writes |
| Queue consumer failure | Temporarily set `REALTIME_EVENT_TYPES` to a type whose handler throws (or deploy a version whose dispatcher fails) | Retries with backoff, dead-letter after 6 attempts, replay succeeds |
| Durable Object unavailability | Not injectable on Cloudflare; covered by unit tests | — |
| Worker restart | Deploy a new version while WebSocket clients are connected | Clients reconnect and resume or resync; no duplicate events shown |
| External dependency timeout | Point `TERMINOLOGY_PROVIDER_URL` at a slow synthetic endpoint on staging | 503 after the timeout, breaker opens after 5 failures |
| Backup restore | Restore staging into an isolated service | Counts, referential integrity, signed versions and audit chain verified; record actual RTO/RPO |
