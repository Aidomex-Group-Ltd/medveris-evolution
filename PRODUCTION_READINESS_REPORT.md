# Medveris — Production Readiness Audit Report

- **Audit date:** 2026-11-19
- **Auditor role:** staff engineer / DevOps & security review
- **Mode:** READ-ONLY audit.

## 1. Executive summary

### 1.1 Overall readiness score

**~68 / 100** (weighted engineering/runtime readiness for a synthetic-data MVP deployment).

### 1.2 Go / no-go verdict

- **NO-GO** for launching real patient data or live clinical operations.
- **CONDITIONAL GO** for promoting the current synthetic-data MVP to production public traffic, **only**
  after the P0 items in §5 are closed and the §6 go-live checklist is executed.

### 1.3 Top 5 risks

| # | Risk | Severity | Evidence |
|---|---|---|---|
| 1 | Real-data launch prerequisites not met (terminology licensing, identity proofing, consent, retention, legal) | P0 | `docs/MVP_STATUS.md:65-70`, `docs/implementation/SECURITY_AND_PRIVACY_REVIEW.md` |
| 2 | No dedicated error-tracking vendor wired (structured logs + Workers observability only) | P1 | `package.json`, `apps/api/src/lib/observability.ts` |
| 3 | Secret rotation automation absent; data-bound keys rotation not drilled | P1 | `docs/observability/SECRETS-RUNBOOK.md`, `scripts/production-secrets-lib.mjs` |
| 4 | Working tree dirty at audit time (deploy gate blocks dirty-tree releases) | P0 | `git status --short`, `scripts/production-deploy.mjs` |
| 5 | Production currently holds synthetic data only | P0 | `docs/implementation/PRODUCTION_READINESS.md` |

---

## 2. Architecture overview

- Monorepo: npm workspaces (`apps/*`, `packages/*`); Node `>=22.12`, TypeScript 5.9, ESM.
- Apps: `apps/api` (Hono on Node + Cloudflare Workers; `@hono/node-server` 2.1.8), `apps/web` (React 19 + Vite 6 + Capacitor 8.6.2), `apps/jobs` (outbox drain).
- Packages: `@medveris/{ai,auth,authz,contracts,db,domain,platform,reference,services,ui}`.
- DB: PostgreSQL via Hyperdrive (runtime + jobs roles), 89 migrations in `packages/db/migrations`, forced RLS.
- Auth: session cookie (HttpOnly/Secure/SameSite=Strict) + CSRF (`x-medveris-csrf`) + TOTP + audit HMAC + integrity checkpoints.
- Deploy: Cloudflare Workers (`medveris-staging`, `medveris-production`), R2, Queues, Durable Objects, Workers VPC; GitHub Actions CI + staging branch deploy + manual production deploy with environment approval; blue-green via wrangler versions.
- Key files: `apps/api/src/app.ts`, `apps/api/src/worker.ts`, `apps/api/src/config.ts`, `apps/api/src/auth/`, `apps/api/src/lib/observability.ts`, `apps/api/src/routes/ops.ts`, `scripts/production-deploy.mjs`, `scripts/staging-deploy.mjs`, `scripts/release.mjs`, `scripts/production-gate.mjs`, `scripts/staging-gate.mjs`, `wrangler.jsonc`.

## 3. Environment variable audit

- Scanned `process.env.*`, `env.*`, `import.meta.env.*`, worker bindings, CI env/secrets, wrangler vars/secrets, scripts, tests, docs.
- Compared against `.env.example` (115 keys), `.env` (13 keys), `.env.test`, `wrangler.jsonc`, GitHub secrets, `~/.config/medveris/{staging,production}/*`.
- Values not printed; names and presence/placeholder/empty status reported.

### 3.1 Findings summary

| Category | Note |
|---|---|
| Env keys read by `loadConfig()` | ~140 |
| Env keys in `.env.example` | 115 |
| Env keys present in local `.env` | 13 (6 secret-ish keys non-empty) |
| Env keys used in code but missing from `.env.example` | ~35 plausible names (e.g. `AI_BASE_URL`, `AI_MODE`, `AI_TOKEN`, `CONTENT_FEEDS_ENABLED`, `FEATURE_NHFR`, `FX_LOCK_MINUTES`, `DIRECTORY_*`, `OPERATOR_ALERT_EMAIL`, `INTEGRATION_TOKEN_TTL_MINUTES`, `LEDGER_ANCHOR_DIR`, `JITSI_BASE_URL`, `CLAMD_ADDRESS`, `USAGE_METERING`, `VITE_API_BASE_URL`) |
| Required prod secrets | `SESSION_SECRET`, `AUDIT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY`, `RESEND_API_KEY`, `AI_TOKEN`, `LIVEPAY_API_KEY`, `LIVEPAY_WEBHOOK_SECRET` (+ conditional PACS/YO secrets) |
| Secret-like values committed | **None** (gitleaks full-history scan in CI, `--exit-code 1`) |

### 3.2 Key status entries

| Variable | Where used | Required in prod? | In .env.example? | Prod config/CI? | Status | Notes |
|---|---|---|---|---|---|---|
| `APP_ENV` | `apps/api/src/config.ts`, `wrangler.jsonc` env.production.vars | Yes | Yes | Yes (`production`) | OK | Fail-fast sandbox/synthetic refusal. |
| `APP_ORIGIN` | `apps/api/src/config.ts`, `apps/api/src/auth/middleware.ts`, `apps/api/src/app.ts` | Yes | Yes | Yes (`https://medveris.online`) | OK | Must be HTTPS outside local; placeholder rejected. |
| `DATABASE_URL` | `apps/api/src/server.ts`, `apps/api/src/worker.ts`, `scripts/*` | No (prod: Hyperdrive) | Yes | No | OK | |
| `SESSION_SECRET` / `AUDIT_SIGNING_KEY` / `MFA_ENCRYPTION_KEY` | `apps/api/src/config.ts`, `apps/api/src/auth/*`, `apps/api/src/lib/audit.ts`, `apps/api/src/worker.ts` | **Yes** | Yes | **Yes** (Worker secret) | OK | Min 24 chars, placeholder/test rejected, distinct; data-bound. |
| `STORAGE_ADAPTER` | `apps/api/src/config.ts`, `apps/api/src/worker.ts` | Yes (prod: `r2`) | Yes | Yes (`r2`) | OK | Private R2. |
| `EMAIL_ADAPTER` / `EMAIL_FROM` / `RESEND_API_KEY` | `apps/api/src/config.ts`, `apps/api/src/lib/email.ts`, `wrangler.jsonc` | Yes (prod) | Yes | Yes | OK | Resend key `re_…`; sender verified domain. |
| `OPERATOR_ALERT_EMAIL` | `apps/api/src/config.ts`, `apps/api/src/worker.ts` | No | **No** | No | **MISSING** | Optional; commented out in `.env.example`. |
| `FEATURE_AI` / `AI_MODE` / `AI_BASE_URL` / `AI_TOKEN` / `AI_MODEL` / `OLLAMA_*` | `apps/api/src/config.ts`, `apps/api/src/worker.ts`, `apps/api/src/integrations/ollama.ts`, `apps/api/src/routes/ai.ts` | Yes (off in prod) | **No** (AI_BASE_URL/AI_MODE/AI_TOKEN missing) | **No** (`FEATURE_AI=false`, `AI_BASE_URL` var set) | **PARTIAL** | `AI_BASE_URL` plaintext var (URL only); `AI_TOKEN`/`OLLAMA_USERNAME`/`OLLAMA_PASSWORD` Worker secrets when enabled. |
| `TERMINOLOGY_MODE` / `TERMINOLOGY_PROVIDER_*` / `SNOMED_EDITION_URI` / `LOINC_RELEASE` | `apps/api/src/config.ts`, `apps/api/src/terminology/*` | Yes (prod: `local-reference`) | Yes | Yes | OK | |
| `FHIR_*` | `apps/api/src/config.ts`, `apps/api/src/fhir/*` | No (default false) | Yes | Yes | OK | |
| `FEATURE_DICOMWEB` / `DICOMWEB_*` / `DICOMWEB_TRANSPORT` | `apps/api/src/config.ts`, `apps/api/src/integrations/dicomweb.ts`, `apps/api/src/routes/dicomweb*.ts`, `scripts/fake-pacs.mjs`, `scripts/production-gate.mjs` | Yes (off in prod) | Yes | Yes | OK | Staging VPC transport `http://medveris-pacs/dicom-web`. |
| `UPLOAD_SCAN_MODE` / `CLAMD_ADDRESS` / `UPLOAD_SCAN_TIMEOUT_MS` | `apps/api/src/config.ts`, `apps/api/src/routes/*` | No (must be `off` until clamd wired) | **No** (`CLAMD_ADDRESS` missing) | No | **PARTIAL** | `loadConfig` refuses boot if mode != off; `CLAMD_ADDRESS` not in `.env.example`. |
| `FEATURE_PAYMENTS` / `PAYMENT_PROVIDER` / `YO_MODE` / `YO_API_*` / `YO_PUBLIC_KEY` / `YO_*` | `apps/api/src/config.ts`, `apps/api/src/integrations/yo.ts`, `apps/api/src/routes/payment-callbacks.ts`, `scripts/yo-check.ts` | Yes (off in prod) | Yes | Yes | OK | Yo! sandbox refused in prod. |
| `LIVEPAY_BASE_URL` / `LIVEPAY_WEBHOOK_URL` / `LIVEPAY_API_KEY` / `LIVEPAY_WEBHOOK_SECRET` / `LIVEPAY_TIMEOUT_MS` | `apps/api/src/config.ts`, `apps/api/src/integrations/livepay.ts`, `apps/api/src/routes/payment-callbacks.ts` | Yes (off via flag) | Yes | Yes | OK | LivePay no test mode; HMAC webhook secret. |
| `FEATURE_LAB` / `FEATURE_PHARMACY` / `FEATURE_TELEMEDICINE` / `FEATURE_DEVICES` / `FEATURE_PUBLIC_HEALTH` / `FEATURE_NHFR` / `FEATURE_EHMIS` / `FEATURE_LEDGER_ANCHORING` | `apps/api/src/config.ts`, `apps/api/src/integrations/registry.ts` | Yes (all off in prod) | **No** (`FEATURE_NHFR` missing) | Yes | **PARTIAL** | Gates without verified adapter refuse. |
| `BILLING_ENFORCEMENT` / `USAGE_METERING` | `apps/api/src/config.ts`, `apps/api/src/lib/billing-middleware.ts` | No (default `notify`) | **No** (`USAGE_METERING` missing) | Yes | **PARTIAL** | |
| `REALTIME_ENABLED` / `REALTIME_ALLOWED_ORIGINS` / `REALTIME_EVENT_TYPES` / `REALTIME_TICKET_TTL_SECONDS` / `REALTIME_MAX_CONNECTION_SECONDS` | `apps/api/src/config.ts`, `apps/api/src/realtime/*`, `apps/api/src/routes/realtime.ts` | Yes (off in prod) | Yes | Yes | OK | Disabled in prod until staging sign-off. |
| `RATE_LIMIT_OVERRIDES` / `TRUST_FORWARDED_FOR` | `apps/api/src/config.ts`, `apps/api/src/lib/rate-limit.ts`, `apps/api/src/durable/rate-limiter.ts` | No | Yes | No (default) | OK | X-Forwarded-For only behind trusted proxy. |
| `JOBS_RELAY_BATCH_SIZE` / `JOBS_PER_TENANT_BATCH_LIMIT` | `apps/api/src/config.ts`, `apps/api/src/worker.ts` | No | Yes | No (default) | OK | |
| `DB_REPLICA_ENABLED` / `DB_REPLICA_MAX_LAG_MS` / `DB_READ_YOUR_WRITES_MS` / `DB_REPLICA_HEALTH_TTL_MS` / `DB_REPLICA_HEALTH_TIMEOUT_MS` | `apps/api/src/config.ts`, `apps/api/src/worker.ts`, `apps/api/src/lib/db-health.ts` | No (off) | Yes | No (off) | OK | Replica requires `HYPERDRIVE_REPLICA`. |
| `SHARD_TOPOLOGY` / `CACHE_KEY_EPOCH` / `REQUEST_LOG_SAMPLE_RATE` | `apps/api/src/config.ts`, `apps/api/src/worker.ts`, `apps/api/src/lib/cache-policy.ts` | No | Yes | No (default) | OK | |
| `CLOUDFLARE_OBSERVABILITY_ENABLED` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_TIMEOUT_MS` / `CLOUDFLARE_CACHE_TTL_MS` | `apps/api/src/config.ts`, `apps/api/src/observability/cloudflare-client.ts`, `apps/api/src/routes/platform-observability.ts` | No (off) | Yes | **No** (`false`) | OK | Token is Worker secret; never browser-exposed. |
| `DIRECTORY_DEFAULT_COUNTRY` / `DIRECTORY_MAX_RADIUS_KM` / `DIRECTORY_MAX_RESULTS` / `DIRECTORY_SPONSORED_LISTINGS` | `apps/api/src/config.ts`, `apps/api/src/routes/directory.ts` | No | **No** | No | **MISSING** | Used by config with defaults; absent from `.env.example`. |
| `VITE_API_BASE_URL` | `apps/web/src/lib/api.ts:45`, `apps/web/src/vite-env.d.ts` | Yes (web) | **No** | No (same-origin fallback) | **MISSING** | **EXPOSED-TO-CLIENT** | `VITE_`-prefixed, inlined into browser bundle; base URL only today, but never put a secret here. |
| `CAPACITOR_SERVER_URL` | `apps/web/capacitor.config.ts:7-8` | No (native dev) | **No** | No | **MISSING** | OK-ish | Build-time env, `cleartext: true` when set. |
| `API_PORT` | `apps/web/vite.config.ts:4`, scripts | No (local) | Yes | No (default 8787) | OK | |
| `PLAYWRIGHT_TEST` | `playwright.config.ts`, `apps/web/vite.config.ts:12` | No (test) | Yes | Yes (CI) | OK | |
| `SMOKE_*` / `LOAD_*` / `PURGE_DATABASE_URL` / `FINGERPRINT_DATABASE_URL` / `STAGING_*` / `PRODUCTION_SECRETS_DIR` | scripts | Ops/test | Yes/No | No | OK | |

### 3.3 Specific flags raised by the audit

1. Used in code but missing from `.env.example`: `AI_BASE_URL`, `AI_MODE`, `AI_TOKEN`, `CONTENT_FEEDS_ENABLED`, `FEATURE_NHFR`, `FX_LOCK_MINUTES`, `DIRECTORY_DEFAULT_COUNTRY`, `DIRECTORY_MAX_RADIUS_KM`, `DIRECTORY_MAX_RESULTS`, `DIRECTORY_SPONSORED_LISTINGS`, `OPERATOR_ALERT_EMAIL`, `INTEGRATION_TOKEN_TTL_MINUTES`, `LEDGER_ANCHOR_DIR`, `JITSI_BASE_URL`, `CLAMD_ADDRESS`, `USAGE_METERING`, `VITE_API_BASE_URL`, `MAP_TILE_PROVIDER`, `MAP_TILE_URL`, `MAP_GEOLOCATION_ENABLED`, `MAP_MAX_ZOOM`, `MAP_MIN_ZOOM`, `MAP_ATTRIBUTION`.
2. Placeholder/dev values that must not reach production: `.env.example` carries `REPLACE_WITH_32_RANDOM_CHARS`, `REPLACE_WITH_32_CHAR_PASSWORD`, `REPLACE_WITH_RESEND_KEY`, `REPLACE_WITH_USERNAME`, `REPLACE_WITH_PASSWORD`, `REPLACE_WITH_PEM_CERTIFICATE`, `REPLACE_WITH_API_KEY`, `REPLACE_WITH_WEBHOOK_SECRET`. CI holds `ci-session-secret-ci-session-secret`, `ci-mfa-encryption-key-ci-mfa-encryption-key`, `ci-audit-signing-key-ci-audit-signing-key` — acceptable only for `APP_ENV=test`.
3. Secrets exposed to client: `VITE_API_BASE_URL` (`apps/web/src/lib/api.ts:45`) via `import.meta.env.VITE_*`; `CAPACITOR_SERVER_URL` (`apps/web/capacitor.config.ts:7`).
4. Secrets committed: none found in tracked files (gitleaks full-history scan in CI, `--exit-code 1`).
5. Missing fail-fast validation: **present** in `apps/api/src/config.ts` `loadConfig()` (min-length/placeholder checks, distinctness, origin HTTPS, sandbox refusal, terminology rules, payments/EHR validation, rate-limit override JSON validation).

### 3.4 Copy-ready `.env.production` template (names only, comments, example formats, no real values)

```bash
APP_ENV=production
NODE_ENV=production
APP_ORIGIN=https://medveris.online
API_ORIGIN=https://medveris.online
PORT=8787

DATABASE_URL=
MIGRATION_DATABASE_URL=
JOBS_DATABASE_URL=
PGADMIN_URL=
MIGRATOR_PASSWORD=
RUNTIME_PASSWORD=
JOBS_PASSWORD=

SESSION_SECRET=<64-hex-or-base64-random-32+>
AUDIT_SIGNING_KEY=<64-hex-or-base64-random-32+>
MFA_ENCRYPTION_KEY=<64-hex-or-base64-random-32+>
AUDIT_SIGNING_KEY_ID=production-key-1

EMAIL_ADAPTER=resend
EMAIL_FROM=Medveris <no-reply@medveris.online>
RESEND_API_KEY=re_<16+chars>
RESEND_FROM=no-reply@medveris.online
OPERATOR_ALERT_EMAIL=<operator-inbox@example.com>

STORAGE_ADAPTER=r2
LOCAL_UPLOAD_DIR=.data/uploads
MAX_UPLOAD_BYTES=5242880

TERMINOLOGY_MODE=local-reference
TERMINOLOGY_PROVIDER_URL=
TERMINOLOGY_PROVIDER_TOKEN=
TERMINOLOGY_TIMEOUT_MS=5000
SNOMED_EDITION_URI=
LOINC_RELEASE=
FHIR_EXTERNAL_WRITES_ENABLED=false
FHIR_BULK_EXPORT_ENABLED=false

FEATURE_AI=false
AI_MODE=off
AI_BASE_URL=https://ollama.medveris.online
AI_TOKEN=
AI_MODEL=
AI_INPUT_TOKENS_MAX=4096
AI_MAX_TOKENS=1024
AI_TEMPERATURE=0.2
AI_TIMEOUT_MS=15000
OLLAMA_URL=https://ollama.medveris.online
OLLAMA_MODEL=
OLLAMA_USERNAME=
OLLAMA_PASSWORD=
OLLAMA_TIMEOUT_MS=60000

FEATURE_DICOMWEB=false
DICOMWEB_MODE=off
DICOMWEB_TRANSPORT=url
DICOMWEB_BASE_URL=
DICOMWEB_AUTH=none
DICOMWEB_USERNAME=
DICOMWEB_PASSWORD=
DICOMWEB_BEARER_TOKEN=
DICOMWEB_TIMEOUT_MS=15000
DICOMWEB_MAX_IMAGE_BYTES=20971520
DICOMWEB_VERIFICATION_MAX_AGE_DAYS=30

FEATURE_PAYMENTS=false
PAYMENT_PROVIDER=livepay
YO_MODE=disabled
YO_API_USERNAME=
YO_API_PASSWORD=
YO_PUBLIC_KEY=
YO_API_URL=
YO_BACKUP_API_URL=
YO_NOTIFICATION_BASE_URL=
YO_TIMEOUT_MS=30000
LIVEPAY_BASE_URL=https://livepay.me/api
LIVEPAY_WEBHOOK_URL=https://medveris.online/api/v1/public/payments/livepay/webhook
LIVEPAY_API_KEY=
LIVEPAY_WEBHOOK_SECRET=
LIVEPAY_ACCOUNT_NUMBER=
LIVEPAY_TIMEOUT_MS=20000
FEATURE_LEDGER_ANCHORING=false
FX_PROVIDER=none
FX_API_KEY=
FX_TIMEOUT_MS=8000
FX_MAX_AGE_HOURS=24
FX_LOCK_MINUTES=15
SUBSCRIPTION_PRODUCT_DESCRIPTION=Medveris workspace access for all modules enabled in the workspace
SUBSCRIPTION_MIN_UGX=500
SUBSCRIPTION_FX_USD_UGX=
SUBSCRIPTION_FX_MAX_AGE_MINUTES=1440

EMERGENCY_OVERRIDE_MINUTES=60
EMERGENCY_REVIEW_DUE_HOURS=24
RADIOLOGY_CRITICAL_ACK_MINUTES=60

REALTIME_ENABLED=false
REALTIME_ALLOWED_ORIGINS=
REALTIME_EVENT_TYPES=content.published,job.progress
REALTIME_TICKET_TTL_SECONDS=30
REALTIME_MAX_CONNECTION_SECONDS=900
RATE_LIMIT_OVERRIDES=
TRUST_FORWARDED_FOR=false
JOBS_RELAY_BATCH_SIZE=100
JOBS_PER_TENANT_BATCH_LIMIT=25
DB_REPLICA_ENABLED=false
DB_REPLICA_MAX_LAG_MS=5000
DB_READ_YOUR_WRITES_MS=15000
DB_REPLICA_HEALTH_TTL_MS=5000
DB_REPLICA_HEALTH_TIMEOUT_MS=1000
SHARD_TOPOLOGY=
CACHE_KEY_EPOCH=1
REQUEST_LOG_SAMPLE_RATE=0.1
CLOUDFLARE_OBSERVABILITY_ENABLED=false
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=6337ed24a5f8ff4ec3f74517a55a7e6b
CLOUDFLARE_TIMEOUT_MS=10000
CLOUDFLARE_CACHE_TTL_MS=60000
CONTENT_FEEDS_ENABLED=false
```

---

## 4. Readiness scorecard (15 areas)

| # | Area | Rating | Evidence / notes |
|---|---|---|---|
| 1 | Configuration and secrets management | READY (mostly) | Fail-fast config validation, secret files 0700/0600, data-bound key rules, gitleaks; gap: no automated rotation. |
| 2 | Database | PARTIAL | 89 migrations; additive-only; RLS; PITR + restore drill recorded (2026-10-28); RPO/RTO proposed not demonstrated; no recurring drill schedule. |
| 3 | Authentication & authorization | PARTIAL | Session/CSRF/TOTP/RBAC/RLS/rate limits/break-glass present; accepted risks noted. |
| 4 | Security | PARTIAL | Good: security headers incl. CSP via `apps/web/public/_headers`, nosniff, HSTS, frame-deny, cache policy, CSRF, body limit, zod validation, runtime audit 0 findings; gaps noted. |
| 5 | Sensitive / medical data handling | PARTIAL | Synthetic data only; TOTP encryption + audit signing; no PHI yet; compliance regimes likely later. |
| 6 | Error handling and logging | PARTIAL | Structured JSON logs, correlation IDs, redaction, DB breaker events; gap: no Sentry/Bugsnag vendor. |
| 7 | Monitoring and observability | PARTIAL | `/api/health`, `/api/v1/health/live`, `/api/v1/health/ready`, `/api/v1/ops/status`, `/api/v1/platform/observability/*`; alerting queries documented, not wired. |
| 8 | Performance and scalability | PARTIAL | Edge cache allowlist, read-your-writes, replica opt-in, shard topology, DO rate limiter; gaps noted. |
| 9 | Testing | READY | `npm test`: 107 files / **964 tests passed**; lint/typecheck/build pass; runtime audit 0 findings/0 blocking. |
| 10 | CI/CD and deployment | READY | CI + staging/prod workflows; full gates; blue-green; rollback scripts; prod manual approval env. |
| 11 | Infrastructure | PARTIAL | Cloudflare Workers (no Dockerfile/K8s/Terraform/Fly/Railway/Vercel/Netlify IaC in repo); HTTPS via Cloudflare; R2 private; WAF/CDN implicit; gaps noted. |
| 12 | Third-party integrations | PARTIAL | Resend, LivePay (off), Yo! (off), AI (off), PACS (off), DHIS2/eHMIS (off), ERPNext (off), FHIR, terminology; gaps noted. |
| 13 | Documentation | PARTIAL | Extensive docs; gaps noted (API portal, incident response). |
| 14 | Legal and ops basics | PARTIAL | Privacy policy draft; consent flows partial; email deliverability configured; backups/DR partial. |
| 15 | Code quality blockers | READY | No TODO/FIXME/HACK found (false positives only); no hardcoded secrets; gitleaks clean. |

**Weighted overall: PARTIAL readiness, ~68/100.**

## 5. Gap list, prioritized

### P0 — Blockers (must fix before going live)

| # | Item | Evidence | Impact | Concrete fix | Effort |
|---|---|---|---|---|---|
| P0-1 | Real-data launch readiness: licensed terminology, identity proofing, consent/retention/legal sign-off | `docs/MVP_STATUS.md:65-70`, `docs/implementation/SECURITY_AND_PRIVACY_REVIEW.md` | Critical (clinical/legal) | Obtain terminology licence; complete identity proofing; legal review; retention policy | L |
| P0-2 | Working tree dirty at audit time (deploy gate blocks dirty-tree releases) | `git status --short`, `scripts/production-deploy.mjs` | High (release hygiene) | Commit or stash intended changes before `npm run deploy:production` | S |
| P0-3 | No real patient data in production yet — go-live cannot be honestly signed off | `docs/implementation/PRODUCTION_READINESS.md` | Critical | Load synthetic -> real data only after gates | M |
| P0-4 | Recurring backup restore drill schedule (last drill 2026-10-28; >90-day rule) | `scripts/production-gate.mjs` (`RESTORE_DRILL_MAX_AGE_DAYS`), `docs/implementation/PRODUCTION_READINESS.md` | High (DR) | Schedule recurring drills | S |

### P1 — High (fix within first week of launch)

| # | Item | Evidence | Impact | Concrete fix | Effort |
|---|---|---|---|---|---|
| P1-1 | No error-tracking vendor wired | `package.json`, `apps/api/src/lib/observability.ts` | High | Integrate error reporting with structured events | M |
| P1-2 | Secret rotation automation / drilled rotation for data-bound keys | `docs/observability/SECRETS-RUNBOOK.md`, `scripts/production-secrets-lib.mjs` | High | Rotation runbook + drills | M |
| P1-3 | Env vars used in code but missing from `.env.example` | §3.3 | Medium | Add to `.env.example` + staging/prod vars | S |
| P1-4 | No dedicated cookie-consent / marketing-consent capture implementation found (only legal reacceptance) | `apps/web/src/components/LegalReacceptance.tsx`, `apps/api/src/routes/legal.ts`, `apps/api/src/legal/documents.ts` | High (legal) | Implement consent capture per jurisdiction | M |
| P1-5 | Email deliverability (SPF/DKIM/DMARC) operational verification not in repo evidence | `docs/operations/DEPLOYMENT_ENVIRONMENTS.md` | Medium | Verify via Resend/CNAME records | S |

### P2 — Medium / nice-to-have

| # | Item | Evidence | Impact | Concrete fix | Effort |
|---|---|---|---|---|---|
| P2-1 | Dead-letter alert path uses operator inbox (`OPERATOR_ALERT_EMAIL`) — currently unset in prod | `apps/api/src/worker.ts` (dead-letter alert), `OPERATOR_ALERT_EMAIL` missing from `.env.example` | Medium | Set operator inbox | S |
| P2-2 | WebSocket realtime disabled in prod (flag) — accepted pending staging sign-off | `wrangler.jsonc` env.production.vars, `docs/implementation/SECURITY_AND_PRIVACY_REVIEW.md` | Low | Sign-off | S |
| P2-3 | Dev-tooling advisories open (vitest/wrangler/miniflare/concurrently/esbuild) | `docs/implementation/SECURITY_AND_PRIVACY_REVIEW.md` | Low | Tooling-only upgrade | S |
| P2-4 | `www.medveris.online` not routed (documented) | `docs/implementation/PRODUCTION_READINESS.md` | Low | Cloudflare redirect rule | S |
| P2-5 | Read replica not provisioned; scaling roadmap | `docs/implementation/SCALABILITY_AND_RESILIENCE.md` | Medium | Provision + enable | L |

## 6. Go-live checklist (ordered)

1. Infra: confirm Cloudflare account `6337ed24a5f8ff4ec3f74517a55a7e6b`, Workers, R2, Queues, VPC/PACS, DNS zone `medveris.online` active; domain attached via `npm run domain:production`.
2. Secrets: populate `~/.config/medveris/production/{secrets.env,resend.env,db.env,backup-verification.json}` (0600/0700); run `npm run secrets:production:check`; `npm run deploy:production:check`.
3. DB: backup; restore drill (≤90 days); apply pending migrations via `scripts/db-migrate.ts`; verify `schema_migrations`.
4. Quality gates: `npm run lint`, `npm run typecheck`, `npm test`, `npm run audit:runtime`, `npm run build` — all pass today.
5. Smoke tests: `npm run smoke:workers`, `npm run clinical-smoke`, staging smoke; production smoke via deploy gate.
6. DNS/TLS: Cloudflare manages cert for `medveris.online`; verify HTTPS + HSTS + CSP via `apps/web/public/_headers`.
7. Monitoring: configure Workers alerts (see `docs/implementation/RESILIENCE_RUNBOOK.md` §6); uptime check on `/api/v1/health/ready`.
8. Rollback plan: `npm run deploy:production:rollback [-- <version-id>]`; note migrations are not reversed (additive-only required).

## 7. Assumptions and open questions (with exact answers needed)

- **Assumed:** production deployment is live at `https://medveris.online` (docs say deployed 2026-10-30, version `714d0dbc…`).
- **Could not verify:** live Cloudflare resource state, secret values, restore-drill currency, DNS records, whether GitHub `production` environment required-reviewers are configured.

- **Questions for the owner:**
  1. Is the GitHub `production` Environment configured with required reviewers (and is the repo public/private)?
  2. Are `PRODUCTION_SECRETS_ENV`, `PRODUCTION_RESEND_ENV`, `PRODUCTION_DB_ENV`, `PRODUCTION_BACKUP_ATTESTATION`, `CLOUDFLARE_API_TOKEN` GitHub secrets all set, and are the values non-empty?
  3. Is `AI_BASE_URL` (`https://ollama.medveris.online`) the intended production Ollama endpoint, and do `AI_TOKEN`/`OLLAMA_USERNAME`/`OLLAMA_PASSWORD` exist?
  4. When (if ever) will a licensed SNOMED CT/LOINC terminology service be contracted?
  5. Is there an approved legal/privacy review for Uganda DPA 2019 and any applicable HIPAA/GDPR regime before real data?
  6. Which error-reporting vendor (or internal log-based alerting) should be used for P1-1?
  7. Who is the production operator/on-call for dead-letter alerts (`OPERATOR_ALERT_EMAIL`)?
  8. Cookie-consent tooling and marketing-consent capture status.
  9. Backup restore-drill schedule and RPO/RTO actuals.
  10. WAF/rate-limit rules at edge (Cloudflare) level beyond what the Worker enforces.

## 8. Verification performed during this audit (read-only)

- `npm run lint` -> **pass**
- `npm run typecheck` -> **pass**
- `npm test` -> **107 files / 964 tests, all passed** (296s)
- `npm run audit:runtime` -> **0 findings, 0 blocking**
- `npm run build` -> **pass** (web + API esbuild bundles)
- Secret/value scanning: names only; no secret values printed.
- Gitleaks configuration present (`.gitleaks.toml`) with CI enforcement.

---

*End of report. Generated for the Medveris repository at `/home/aidomex/medveris`.*
