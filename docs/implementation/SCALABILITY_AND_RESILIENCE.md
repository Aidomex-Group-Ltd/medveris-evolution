# Scalability, real-time and resilience — architecture, status and evidence

Recorded 2026-10-28. Scope: caching, read replicas, sharding, queues, WebSockets, distributed rate limiting, failover, observability and load testing for the MedVeris Worker (`apps/api`), jobs (`apps/jobs`) and web client. All testing used synthetic seed data only. Operational procedures are in [`RESILIENCE_RUNBOOK.md`](RESILIENCE_RUNBOOK.md).

Status words: **VERIFIED** means exercised by automated tests and, where marked, in a real Workers runtime (`wrangler dev`/workerd). **PARTIAL** means implemented and tested locally but not yet exercised on staging Cloudflare infrastructure. **BLOCKED** means it needs infrastructure or credentials that do not exist yet. Nothing here is claimed highly available: no failover has been exercised in staging.

## 1. Architecture audit (before this change)

| Area | Found | Classification before |
|---|---|---|
| Runtime | One Worker: Hono API, static assets, 5-minute cron for outbox and checkpoints; Node server for local development | Implemented |
| Database | Aiven PostgreSQL through two Hyperdrive configs (runtime and jobs roles, caching disabled), forced RLS, transaction-local tenant context via `withContext` | Implemented and verified |
| Caching | All `/api` responses `no-store`; no asset cache headers; no Worker cache | Missing |
| Read replicas | No read routing; no replica provisioned | Missing / blocked |
| Sharding | Single database, no directory | Missing |
| Async jobs | Transactional outbox with `SKIP LOCKED`, dedupe table, backoff, dead-letter after 6 attempts, drained by cron | Partial: rows left `processing` by a crash were never reclaimed; no queue |
| Real-time | None | Missing |
| Rate limiting | In-memory `Map` per isolate; integration token limiter keyed on spoofable `X-Forwarded-For` | Partial, flagged open in the security review |
| Resilience | Fixed fetch timeouts for Resend and terminology; no retries, breakers or database outage handling; `/health/ready` ran an unbounded query | Partial |
| Observability | Workers Logs enabled with redacted query strings; ad hoc `console` lines; client-supplied correlation IDs accepted unvalidated, set after auth | Partial |

Baseline: lint, typecheck and 293 tests in 36 files passed before any change.

## 2. Feature status

| Feature | Status | Evidence |
|---|---|---|
| Browser/CDN cache headers (allowlist, ETag, 304, immutable assets) | VERIFIED (local) | `tests/unit/cache.test.ts`, `tests/integration/scaling.test.ts` |
| Worker cache (Cache API) with stampede control and stale-if-error | VERIFIED in workerd; staging BLOCKED | `runtime-verify.mjs` "worker cache serves the second anonymous request". The Cache API does nothing on `*.workers.dev`, so staging cannot exercise it; it takes effect on the production custom domain |
| KV shared cache | Not adopted | No workload needs eventually consistent shared data beyond env vars; documented in §3 |
| Read/write routing, replica health, read-your-writes | VERIFIED (local, simulated replica) | `tests/unit/db-routing.test.ts`, scaling integration tests (fallback when the replica fails mid-query, read-only enforcement, read-your-writes cookie) |
| Physical read replica | **BLOCKED** | No standby exists. Requires an Aiven plan with read replicas (paid) and approval; see runbook §2 |
| Shard directory, single-shard routing, tenant freeze, move state machine, fingerprints | VERIFIED (single shard) | Migration 030; `db-routing.test.ts`; scaling integration tests (freeze → 503 for writes, reads continue, audited history, versioned routing) |
| Multi-shard serving / tenant copy | **BLOCKED by design** | Refused at startup until workload measurements, second database, backups and copy tooling exist |
| Queue relay, consumer, DLQ, replay, reclaim, fairness | VERIFIED in workerd (local queues); staging PARTIAL | `tests/integration/jobs-queue.test.ts`; `runtime-verify.mjs` "committed outbox event delivered live through the queue". Staging queues not created yet |
| WebSockets (tickets, origin check, channel authorization, limits, heartbeat, expiry, replay) | VERIFIED in workerd; staging PARTIAL | `tests/unit/realtime.test.ts`, scaling integration tests, `runtime-verify.mjs` (accept, refuse reuse, refuse cross-origin, forbidden channel, invalid fields, live delivery, replay after reconnect) |
| Distributed rate limiting (Durable Object) | VERIFIED in workerd; staging PARTIAL | `tests/unit/rate-limit.test.ts` (8 instances racing one counter admit exactly the limit), `runtime-verify.mjs` (30 concurrent sign-ins → exactly 12 admitted, 18 × 429) |
| Timeouts, retries, circuit breakers, bulkhead | VERIFIED (unit) | `tests/unit/resilience.test.ts`, `tests/unit/email.test.ts` |
| Database outage handling and primary breaker | VERIFIED (local, refused connections) | `tests/unit/worker-resilience.test.ts` (5 failures open the breaker, next 3 rejected without connecting), scaling integration "database outage" |
| Provider failover (Aiven) | **BLOCKED** | Not exercised. Needs approval to run a controlled failover on staging and an Aiven plan that supports it |
| Backup restore drill / RTO-RPO | **BLOCKED** | Unchanged from `PRODUCTION_READINESS.md`; targets are proposals only |
| Observability (structured, redacted logs, metrics, correlation IDs, ops status) | VERIFIED (local) | `resilience.test.ts` (redaction, correlation validation, route shapes), `/api/v1/ops/status` integration test |
| Dashboards and alerts in Cloudflare | **PARTIAL** | Queries and thresholds are defined in the runbook §6; they must be created in the Cloudflare dashboard after staging deploy |

## 3. Caching policy

Only `CACHE_RULES` in `apps/api/src/lib/cache-policy.ts` can make a response public. Every other `/api`, `/fhir` and `/terminology` response is forced to `no-store, private` after the handler runs, so a handler cannot opt a response into a shared cache.

| Data class | Routes | Browser | Worker cache | Stale policy |
|---|---|---|---|---|
| Public reference | `public/config`, `public/directory/map-config`, `public/integrations/products` | 60–300 s, ETag | 60–300 s | stale-if-error up to 1 h |
| Public directory | `public/facilities`, `public/directory/meta`, `public/directory/facilities[/:id]` | 30–120 s, ETag | 60–300 s | stale-if-error up to 10 min–1 h; sponsored placements rotate hourly, so 60 s is within policy |
| Hashed frontend assets | `/assets/*` | 1 year, `immutable` | Workers assets | URL changes with content |
| HTML shell | `/index.html`, SPA routes | `no-cache` / revalidate | — | Always revalidated |
| Authenticated, tenant, patient, clinical, credential | everything else | `no-store, private` | never | never stale |

Keys are `origin/__edge-cache/<deployment version>:<CACHE_KEY_EPOCH>/<rule>/<path>?<sorted parameters>`. Requests with a session cookie or `Authorization` header never read or write the shared cache. Parameters outside the rule's list, repeated parameters, oversized values and personal location (`lat`, `lng`, `radiusKm`) bypass it, so callers cannot fragment or poison entries. Tenant isolation was tested with deliberately identical URLs from two tenants' sessions: neither populated nor read the shared cache. Concurrent misses for one key in an isolate share one origin request.

Invalidation: entries expire by TTL; a new release changes the key version; `CACHE_KEY_EPOCH` invalidates all keys without a release; `invalidateLocal` removes an entry in one data center only. Clinical data is never cached outside the requesting browser's memory, and Hyperdrive query caching stays disabled (gate-enforced).

KV was evaluated and not adopted: configuration is deploy-time env vars, and coordinated state (rate limits, presence) needs Durable Objects. PostgreSQL remains the system of record.

## 4. Database routing

`packages/db/src/routing.ts`. `DatabaseRouter.forRead` returns the primary for every read except call sites that ask for `bounded-staleness`, and then only when:

- a replica binding exists and `DB_REPLICA_ENABLED=true` (startup refuses the flag without the binding);
- the probe shows `pg_is_in_recovery()`, a streaming WAL receiver, and lag at or below both `DB_REPLICA_MAX_LAG_MS` and the caller's bound;
- the session has not written within `DB_READ_YOUR_WRITES_MS` (an HttpOnly, SameSite=Strict `mv_ryw` cookie set after successful writes).

A server that is not in recovery (for example a promoted former replica) is never used as a replica, which prevents reading from one primary while writing to another. Unknown or timed-out health means primary. Probes are cached per isolate for `DB_REPLICA_HEALTH_TTL_MS` and bounded by `DB_REPLICA_HEALTH_TIMEOUT_MS`. Replica-eligible reads run in `BEGIN READ ONLY` with the same RLS context as `withActor`; a replica error marks it unhealthy and the read is retried once on the primary (safe because it cannot write). On a physical standby the server rejects writes regardless of role.

Current adopter: facility reports (`/api/v1/reports/:id`, staleness bound 30 s). The report states `dataSource` and `maxStalenessSeconds`, and the access audit is written on the primary before any rows are returned. Authentication, authorization, consent, clinical reads and every write stay on the primary.

Every context transaction now sets `statement_timeout` 20 s and `idle_in_transaction_session_timeout` 30 s transaction-locally, so it is safe with Hyperdrive pooling. No external call runs inside a transaction (checked for email and storage).

## 5. Sharding

`packages/db/src/shards.ts`, migration `030_scaling_foundation.sql`, `scripts/shard-tenant.ts`.

- Directory-based: `tenant_shard_assignments` (tenant → shard, state `active|frozen|migrating`, `routing_version`). The runtime and jobs roles can only read it; only the migration role changes it; rows cannot be deleted; every insert and change is recorded in `tenant_shard_assignment_history` by trigger with the session user and reason, and bumps `routing_version`.
- New tenants are assigned to `primary` by trigger; existing tenants were backfilled (192 locally).
- Routing input is the tenant from the server-validated session; there is no client-controlled shard selection. The assignment is loaded in the same query as memberships, so there is no extra round trip. Shard selection is not authorization: RLS and policy checks still apply.
- Unknown tenants: single mode uses the only shard; directory mode refuses (503) rather than guessing.
- Frozen or migrating tenants: writes get `503 tenant_maintenance` with `Retry-After: 60`; reads continue; session and facility-switch routes are exempt.
- `SHARD_TOPOLOGY` is validated at startup; a multi-shard topology is refused because tenant data access is still single-database.
- Tenant move design: `planned → frozen → copied → verified → cut-over → completed`, with rollback before cut-over. Verification compares order-independent per-table digests (`tenantFingerprint`), which need identical schema versions on both shards. Workflows spanning shards use the outbox, not cross-shard transactions.

Known limitation: patient-portal writes (no active facility) are not covered by the freeze guard; a real move must also pause those for the affected tenant.

## 6. Durable queues

`apps/jobs/src/{contracts,queue,outbox,replay}.ts`.

- The transactional outbox stays the source of truth. The cron relays due rows to `JOBS_QUEUE` and marks them `queued`; a failed publish returns them to `pending` with backoff. A database write is never assumed to have produced a message. Without a queue binding (Node, tests) events are handled in-process as before.
- Messages (schema v1, strict) carry identifiers only: job ID, kind, event type, tenant, aggregate, claim count, correlation ID, time. Payloads never leave PostgreSQL. The consumer loads the authoritative row with the jobs role and refuses messages whose tenant or type does not match it.
- Delivery is at least once. Consumers deduplicate on `processed_outbox_events(event_id)`. Each message is acknowledged or retried individually with full-jitter backoff (10 s up to 15 min); after 6 attempts the row is dead-lettered and a reference is sent to the DLQ.
- Poison messages (schema failures, mismatches) are acknowledged, dead-lettered and recorded without content.
- The DLQ consumer only records; replay is an operator action (`npm run jobs:replay`) that writes `outbox_replays` (operator, reason, previous state) and is idempotent.
- Rows left `processing` for over 10 minutes, or `queued` for over 30 minutes without being consumed, are reclaimed each cycle.
- Fairness: a relay batch takes at most `JOBS_PER_TENANT_BATCH_LIMIT` events per tenant. Concurrency is bounded by `max_concurrency` (2) and sequential processing within a batch.
- Job kinds: notification, search-index, analytics, audit, file-processing, interoperability, maintenance, record. No external adapters exist yet, so handlers record locally exactly as before; adding one does not change producers. Authorization, critical clinical writes and audit writes remain synchronous.

## 7. Real-time

`apps/api/src/realtime/*`, `apps/api/src/durable/realtime-hub.ts`, `apps/web/src/lib/realtime.ts`.

- Handshake: `POST /api/v1/realtime/tickets` (session cookie, CSRF header, staff MFA, rate limited) returns a 30-second, single-use, HMAC-signed ticket bound to the user, session hash, facility and server-chosen channels. The browser presents it in `Sec-WebSocket-Protocol`, never in a URL. At the upgrade the Worker checks the Origin allowlist, re-validates the session cookie and MFA, verifies the ticket against that session, and builds the hub context itself, discarding any client copy.
- One hub per facility (staff) or per user (patients). Channels: `user:<self>`, `tenant`, and `operations` for administrative roles. A subscription outside the authorized set is refused.
- Limits: 5 connections per user, 2,000 per hub, 4 KiB text messages, 20 messages per 10 s, strict schemas (unexpected fields rejected). Connections close at the earlier of session expiry and 15 minutes (`4001`, reconnect with a new ticket), on sign-out, or after 90 s without heartbeat. Heartbeats are answered by the runtime without waking the object (hibernation API).
- Events carry type, opaque reference and sequence number, never record content. Clients refetch through the authenticated API. The hub keeps 200 events / 15 minutes per channel for resume; older gaps get `resync`. The client reconnects with jittered backoff, deduplicates by sequence, and resyncs on gaps. A deployment disconnects sockets; clients resume.
- Only allowlisted event types are fanned out (`REALTIME_EVENT_TYPES`, default `content.published,job.progress`). Clinical event types need governance approval. Enabled on staging and disabled in production by gate. The client library is in place; wiring it into individual pages is product work.

## 8. Rate limiting

`apps/api/src/lib/rate-limit.ts`, `apps/api/src/durable/rate-limiter.ts`. Every endpoint policy is in `RATE_LIMIT_POLICIES`. Distributed policies are counted in one Durable Object per (policy, SHA-256 of identity), using a sliding-window counter. Each object stores a single record and deletes itself by alarm, so attacker-chosen keys cannot grow storage.

| Policy group | Limit | Identity | On coordination failure |
|---|---|---|---|
| Sign-in | 12/min per address, with progressive cooldown 60 s → 15 min; 10 failures / 15 min per submitted account (counted for existing and unknown addresses alike) | connecting IP; hashed address | local-strict (¼ quota per instance) |
| MFA, emailed codes, recovery, reset, signup, verification resend | 3–15 per window | IP or user | local-strict |
| Invitation token guessing | 5 / 15 min per token hash | token hash | **closed** |
| Patient search and resolve, uploads, report exports | per user | user ID | local-strict |
| Reports, devices, integrations, invitation status/accept | per user/client | user/client | local |
| Real-time connect | 10/min per user | user ID | local-strict |
| General authenticated / public volume | 600 / 300 per minute | user / IP | per instance by design; edge WAF rules are the global control |

Client addresses come from `CF-Connecting-IP`. `X-Forwarded-For` is used only in development/test or with `TRUST_FORWARDED_FOR=true` (this fixes the integration-token limiter that keyed on a spoofable header). Rejections return `429` with `Retry-After`. Recovery responses stay identical whether or not an account exists. Emergency overrides go in `RATE_LIMIT_OVERRIDES`: factor 0.1–10, at most 7 days, a reason is required, and they are audited through Worker version history. Staging and production refuse to start without the `RATE_LIMITER` binding, so they never silently degrade to per-instance limiting.

## 9. Failover and resilience

- External calls: Resend (10 s timeout, 3 attempts with the provider's `Idempotency-Key`, breaker), terminology (configured timeout, 2 attempts for read-only operations, breaker), R2 (15–30 s timeouts, breaker, no retries because a timed-out put may have succeeded), feeds (existing per-source timeout). A failure is reported as failure (email `delivered: false`, 503 for terminology and storage), never as success.
- Database: connection loss, shutdown, too-many-connections and read-only-transaction (a demoted primary during failover) errors map to `503 database_unavailable` with `Retry-After: 5` and no internals. A per-isolate breaker opens after 5 consecutive failures and fails fast for 5 s, then lets one trial through, which prevents connection storms against a recovering database. Connect timeout is 10 s. Clients retry idempotent mutations with their `Idempotency-Key` to learn the outcome of a request whose connection dropped.
- Writes go only to the binding configured as primary; there is no automatic promotion and no client-side primary election, so the application cannot create split-brain writes. Failover is provider-managed (Aiven), and Hyperdrive reconnects to the same hostname.
- Health: `/api/v1/health/live` touches no dependency; `/api/v1/health/ready` checks the primary within 2 s and reports replica and breaker states by name only.
- Deployment: workerd treats every named export of the entry module as an entrypoint, so non-handler exports moved to `worker-support.ts`. Before this fix the Worker failed to start once Durable Objects were added; it was caught in local `wrangler dev`.

## 10. Observability

- One `http_request` line per request: correlation ID, method, route shape (identifiers collapsed), status, duration, plus bounded annotations (database route, rate-limit policy). Errors, 429s and slow requests (>1 s) are always logged; others are sampled (`REQUEST_LOG_SAMPLE_RATE`, 1 on staging, 0.1 in production).
- `metric` lines: `cache.lookup`, `cache.invalidate`, `http.conditional`, `db.read_route`, `ratelimit.rejected`, `ratelimit.coordination_failure`, `jobs.relay`, `jobs.backlog`, `jobs.retry`, `jobs.dead_letter`, `jobs.poison`, `jobs.reclaimed`, `realtime.connect`, `realtime.publish_failed`, `dependency.call`.
- `safeFields` drops keys naming credentials, tokens, tickets, cookies, payloads, contact details, names, birth dates, MRNs and clinical content, and keeps only truncated primitives. Correlation IDs from clients are accepted only when they match `[A-Za-z0-9._:-]{8,64}`.
- `/api/v1/ops/status` (platform operators): global outbox backlog by status, with age and maximum attempts (`app.outbox_backlog()` returns aggregates only), replica state and lag, shard topology, breakers, and the answering instance's latency percentiles.

## 11. Performance measurements (synthetic, this workstation)

`npm run load:test`: 20 concurrent clients, 30 s, the reception account, a mix of cached public reads, authenticated tenant reads, the replica-eligible report and 5% synthetic patient registrations. WSL2 laptop with local PostgreSQL 14 shared with other containers. These are baselines for comparison, not capacity claims.

| Target | Aggregate | Cached public p50/p95 | Authenticated read p50/p95 | Report p50/p95 | Write p50/p95 | Errors |
|---|---|---|---|---|---|---|
| Node server (pooled connections) | 62.5 req/s | 13 / 43 ms | 154–236 / 594–711 ms | 415 / 1439 ms | 1614 / 3688 ms | 0 |
| Local workerd (`wrangler dev`, new DB connection per request, no Hyperdrive) | ≈10 req/s | 272–283 ms p50, 86–99% Worker cache hits | 1.8–2.4 / 3.3–3.7 s | 2.9 / 4.4 s | 3.8 / 6.7 s | 0 |

Local workerd latency is dominated by opening a fresh PostgreSQL connection with SCRAM authentication on every request in a single isolate; Hyperdrive pools these in staging and production. Proposed staging targets to confirm with the same script: p95 < 300 ms for cached public routes, p95 < 800 ms for authenticated reads, p95 < 2 s for reports, error rate < 0.5% (excluding 429s), and a queue delay (commit to consumption) under the 5-minute cron interval plus 30 s.

## 12. Resources and cost

| Resource | Needed for | Plan / cost | State |
|---|---|---|---|
| Durable Objects `RateLimiterObject`, `RealtimeHub` (SQLite) | Rate limiting, real-time | Workers Free includes SQLite-backed DOs within daily limits; Paid bills per request and duration | Created by the first deploy with `--apply-durable-object-migrations` |
| Queues `medveris-staging-jobs`, `medveris-staging-jobs-dlq` | Job delivery | Available on this account; usage-based, small at staging volume | **Not created** — `npx wrangler queues create <name>` |
| Queues `medveris-production-jobs`, `-dlq` | Production | as above | Not created; production is blocked |
| Aiven read replica | Replica reads | Paid Aiven plan (not free) | **BLOCKED — needs approval** |
| Second shard database | Physical sharding | Paid | Not planned until measurements justify it |
| Cloudflare WAF rate-limiting rule | Global request volume on the custom domain | Free plan includes one rule | Not configured |

Every deploy gate (`deploy:staging:check`, `deploy:production:check`) now verifies the Durable Object bindings and migrations, environment-prefixed queues with a dead-letter queue and bounded retries and concurrency, and the queues' remote existence. Production additionally requires `REALTIME_ENABLED` and `DB_REPLICA_ENABLED` to stay false.

## 13. Tests run

| Suite | Result |
|---|---|
| `npm run lint` / `npm run typecheck` | Pass |
| `npm test` | 390 tests, 44 files, all pass (293 before; 97 new across resilience, cache, routing/sharding, rate limit, real-time, worker resilience, gates, scaling and queue integration) |
| `npm run build`, `wrangler deploy --env staging --dry-run` | Pass; 2,157 KiB / 384 KiB gzip with all bindings |
| `npm run smoke:workers` | Pass |
| `npm run verify:runtime` against local `wrangler dev` | 16/16 pass |
| `npm run test:e2e` | 32 of 33 passed in the full run. "Clinician tracks a follow-up and referral" failed once (the list loaded without the follow-up just created, though it was saved) and then passed 3 of 3 in isolation; it also passed in two earlier runs on this code. Treated as an intermittent UI timing issue, not a regression; watch it in CI |

## 14. Outstanding risks

1. No staging verification on Cloudflare yet: Durable Object latency, queue delivery, WebSockets on workers.dev and Hyperdrive behaviour under load are unmeasured there.
2. No provider failover, replica or restore drill has been exercised, so RTO/RPO remain proposals.
3. `wrangler versions upload` cannot apply Durable Object migrations; the first release with them is an all-at-once `wrangler deploy` (scripted, health-checked, previous version restored on failure).
4. The per-instance volume guards are not global. Global volume protection needs the edge WAF rule on the custom domain.
5. Tenant-freeze coverage excludes patient-portal writes (see §5).
6. Rate-limit Durable Object calls add a round trip (bounded by a 750 ms timeout) to sign-in and other sensitive endpoints.
