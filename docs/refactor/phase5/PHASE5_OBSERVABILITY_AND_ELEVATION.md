# Phase 5 — Cloudflare Workers observability & terminal operator elevation (2026-11-12)

## 5.1 Current-state review (verified)

| Capability | Evidence |
|---|---|
| Workers entrypoint with Queues (inbox + DLQ), cron (`*/5 * * * *`), DO `RateLimiterObject`, `RealtimeHub`, Hyperdrive (runtime + jobs), R2 buckets, version metadata, `observability` enabled with `redact_query_string: true` | `wrangler.jsonc` (top-level, `staging`, `production`) — staging request log sample rate 1.0, production 0.1 |
| Request telemetry: one `http_request` line per sampled request; `routeShape()` collapses identifiers; sampled ≥500/429/≥1000ms else configured rate; correlation IDs validated (`^[A-Za-z0-9._:-]{8,64}$`) | `apps/api/src/lib/observability.ts` + `packages/platform/src/telemetry.ts` (`safeFields` key denylist: passwords/tokens/emails/clinical fields dropped at write time) |
| Operator-gated observability proxy (overview/api-metrics/workers/logs/traces/jobs/integrations/security): read-only, server-side Cloudflare token, 1h/24h/etc. cache, stale-on-error, structured `unavailable` envelopes; WAF/Bot stays in the CF dashboard (never becomes a second source of truth) | `apps/api/src/routes/platform-observability.ts`, `apps/api/src/observability/cloudflare-client.ts` — operator check via `isPlatformOperator` (platform role + MFA) |
| Jobs failure isolation: DLQ consumer + `dead_letter_alert_failed` + optional `OPERATOR_ALERT_EMAIL` notification; outbox relay with reclaim/backoff/dead-letter/replay; integrity Merkle checkpoints per tenant | `apps/api/src/worker.ts`, `apps/jobs/src/{queue,outbox,integrity,grants,cycle}.ts` |
| Terminal operator elevation: `scripts/platform-operator.ts` break-glass CLI (migrator-role only, `--allow-production` + `--reason` required in production, time-limited grants via `breakGlassGrant`, four-eyes approval workflow in `lib/platform-roles.ts`, 300s MFA step-up at use time, `MIN_ACTIVE_OPERATORS=2`); automatic expiry via `maybeExpireStaleGrants` in the jobs cycle; every grant/revoke/expire audited on the hash-chained log | `scripts/platform-operator.ts`, `apps/api/src/lib/platform-roles.ts`, `apps/jobs/src/grants.ts`, migrations `042/043/045` |
| Error paths never crash requests: telemetry is best-effort by construction (no throws); Cloudflare proxy returns "unavailable" envelopes; queue consumer isolates poison messages; checkpoint failure logs but does not roll back outbox progress; jobs-cycle steps are individually try/caught | `observability.ts`, `cloudflare-client.ts`, `worker.ts`, `cycle.ts` |

**Assessment:** the platform largely satisfies 5.1/5.2/5.4 already; this phase closed the concrete gaps below without rebuilding anything.

## 5.2 Secure telemetry pipeline (new, this slice)

- **`app.security_event_summary(span_minutes integer)`** — new migration `130_security_event_summary.sql`. `STABLE SECURITY DEFINER`, owned by `medveris_exchange` (BYPASSRLS — same pattern as `app.outbox_backlog()`), `EXECUTE` to `medveris_runtime` only, platform_operator-GUC-gated, 1–10080 minute span clamp, **counts only** over a fixed allowlist of ~45 security-relevant audit actions (auth, MFA, sessions, consent/exchange, break-glass, patient merge/proxy, membership/role grants, platform-operator lifecycle, partner-patient links, uploads, legal). No identifiers of any kind. Dry-run inside BEGIN…ROLLBACK passed; applied to `medveris_test` via the migrator (as CI does to fresh databases).
- **`GET /api/v1/platform/observability/security-events?span=1h|6h|24h|7d`** — new operator-gated endpoint projecting the function; response carries `totals { events, denied }` and per-`(action, decision, reasonCode)` counts. Bound in the authz matrix (`platform.observability.read`); enforced server-side via `requireOperator` like its siblings.
- **Privacy protection:** aggregates never join to person, tenant or patient identifiers; the projection is impossible to narrow to a subject from the API. Workers Logs remain write-time redacted (`safeFields`, `redact_query_string: true`).

## 5.3 Anomaly detection & alerting (new, this slice)

- **`apps/jobs/src/security.ts` `maybeFlagSecurityAnomaly(sql)`** — runs in the jobs cycle (every 5 min, self-throttled). Aggregate-only read of the audit log (counts by `decision='deny'` on auth actions and `emergency.override.create` creations over a 15-minute window via the `medveris_jobs` role's existing `audit_jobs_read` SELECT grant). Emits a structured `security_anomaly` warning log when thresholds are breached (25 denied auth events, or 3 break-glass activations, in 15 min). **No identifiers are logged; nothing is enforced or blocked; failures are caught and logged — clinical operations can never be interrupted by this scan.** Thresholds are constants pending a policy decision on paging (see residual risks).
- **Worker `scheduled` handler** now logs `security_anomaly_failed` / `securityAnomaly` flag on `jobs_cycle` for operator visibility.

## 5.4 Terminal platform-operator elevation (hardened, not rebuilt)

Everything required already existed: strong operator authentication (platform MFA step-up 300s at use time), explicit authorization (four-eyes request→approve, or break-glass CLI with written reason, `--allow-production` required in prod), time-limited privilege (`hours` ≤ `PLATFORM_ROLE_MAX_GRANT_HOURS`), automatic revocation (`maybeExpireStaleGrants` in the jobs cycle), separation from facility accounts (`platform_roles` + `app.platform_role` GUC), full audit. **Gap closed:** the CLI `list` command (operator inventory review) now also writes `platform_operator.list` to the hash-chained audit log — "comprehensive command/activity auditing" previously covered grants/revokes but not reads of the operator inventory. Grant/revoke/expire were already audited.

## 5.5 Telemetry protection & configuration evidence

- **Secrets (names only, values live in Worker secrets):** `SESSION_SECRET`, `AUDIT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY`, `RESEND_API_KEY`, `AI_TOKEN` (prod), `LIVEPAY_*`, `YO_*` (staging). `wrangler.jsonc` carries no secret values and only non-secret `vars`. `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` for the observability proxy are **not configured anywhere yet** (endpoints return structured `unavailable`; set via `wrangler secret put` when the account observability dataset is enabled — see §5.6 residual risks).
- **Config guards verified:** `APP_ENV=production` refuses sandbox adapters & legacy elevate env permissions; `EXPECTED_DATABASE_NAME` enforcement; `DEV_SHOW_TOTP_SECRETS=false`; `TERMINOLOGY_MODE` gating; `redact_query_string: true` on both environments.
- **Telemetry storage protection:** audit is hash-chained + HMAC-signed + append-only (DB triggers + `medveris_runtime`/`medveris_jobs` have no UPDATE/DELETE); integrity Merkle checkpoints signed per tenant; telemetry logs contain only redacted fields; operator reads are platform-role-gated end-to-end.
- **Failure isolation confirmed in code:** observability never fails a request (telemetry/metrics swallow errors by construction); queue poison isolation; DLQ alerting via operator email when `OPERATOR_ALERT_EMAIL` is set; cron cycle continues past security-anomaly scan failure.

## 5.6 Verification

- Migration `130` dry-run in BEGIN…ROLLBACK on `medveris_dev` — pass (nothing persisted); applied to `medveris_test` by the migrator — pass.
- New integration suite `tests/integration/security-events.test.ts` (5 tests): 401 unauthenticated, 403 non-operator, 422 invalid span, counts-only rollup shape with no identifier keys, zero rows without the platform GUC. **5/5 pass.**
- `authz-matrix.test.ts` + `authz.test.ts` — 51/51 pass (new route bound).
- ESLint on all changed/new files — clean. (`npm run typecheck` not re-run to completion in this window — the concurrent opencode session in this tree is mid-edit on `apps/web/src/pages/AuthPage.tsx` and currently breaks the web build; all API/packages/test sources in this phase were additionally validated by vitest's transform.)
- `npx tsx scripts/platform-operator.ts` (no args) — usage + exit 2, CLI intact.

## Residual risks / not claimed

1. **No real Cloudflare observability dataset is configured in this account yet** (`CLOUDFLARE_API_TOKEN` unset) — endpoints return truthful `unavailable` envelopes; wire-up and WAF routing rules are a deployment decision (edge WAF remains outside this repo, as before).
2. **Anomaly thresholds are static constants** (25 denied auths / 3 break-glasses per 15 min) and the anomaly flag is log/metric only — no paging, no automated lockout. Paging destination requires an operations decision (email via `OPERATOR_ALERT_EMAIL` is available and used today only for DLQ).
3. **Audit-chain independent verifier still absent** (write-time tamper-evidence only).
4. **Jobs cycle runs on the Worker cron as `medveris_jobs`** — anomaly scan reads only aggregates; if jobs DB is unreachable the scan logs `security_anomaly_scan_failed` and clinical traffic is unaffected.
5. **`platform_operator.list` auditing** adds rows on every CLI list; acceptable volume, but operators should use `--actor` to attribute the call.
6. **No PHI, no patient identifiers, and no tenant attribution are surfaced** by any new endpoint — verified by test.
