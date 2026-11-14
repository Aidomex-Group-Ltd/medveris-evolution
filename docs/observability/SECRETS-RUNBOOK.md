# Secrets Runbook

Per-environment secret management for Medveris. This runbook covers which secrets exist, where they are configured, how they are rotated, and who is responsible.

**Related documents:** `docs/observability/SSOT.md`, `wrangler.jsonc`, `.gitignore`

---

## Principles

1. **No secret values in code, git history, logs, or CI output.** Secret scanning (gitleaks) runs in CI to enforce this.
2. **Secrets live in Cloudflare Worker secrets** for staging/production, and in `~/.config/medveris/<env>/` for local development.
3. **Environment files are gitignored.** `.gitignore` covers `.env`, `.env.local`, `.dev.vars*`, `*.pem`, `secrets.env`, `db.env`, and `~/.config/medveris/`.
4. **Rotation is an operator action.** No automated rotation exists; each secret must be rotated manually via `wrangler secret put` or the Cloudflare dashboard.

---

## Secret Inventory

### Core server secrets

| Secret | Purpose | Staging | Production | Local |
|---|---|---|---|---|
| `SESSION_SECRET` | Signs session cookies (min 24 chars) | Worker secret | Worker secret | `~/.config/medveris/development/secrets.env` |
| `AUDIT_SIGNING_KEY` | HMAC key for audit event signatures | Worker secret | Worker secret | Same |
| `AUDIT_SIGNING_KEY_ID` | Key identifier for audit signatures | `wrangler.jsonc` var | `wrangler.jsonc` var | Env var |
| `MFA_ENCRYPTION_KEY` | Encrypts TOTP secrets at rest (min 24 chars) | Worker secret | Worker secret | Same |

**Rotation:**
- `SESSION_SECRET`: rotate invalidates all active sessions. Run `wrangler secret put SESSION_SECRET`, enter new value, deploy. Users must re-login.
- `AUDIT_SIGNING_KEY`: rotate requires a new `AUDIT_SIGNING_KEY_ID` too. Existing audit events remain verifiable under the old key id. Run `wrangler secret put AUDIT_SIGNING_KEY` followed by `wrangler secret put AUDIT_SIGNING_KEY_ID`.
- `MFA_ENCRYPTION_KEY`: **do not rotate without a migration plan** — existing encrypted TOTP secrets become unreadable. Consult the security lead first.

**Who:** Platform operator with `wrangler` access to the MedVeris Cloudflare account (`6337ed24a5f8ff4ec3f74517a55a7e6b`).

---

### Email

| Secret | Purpose | Staging | Production |
|---|---|---|---|
| `RESEND_API_KEY` | Resend transactional email API key (starts `re_`) | Worker secret | Worker secret |

**Rotation:** Create a new API key in the Resend dashboard, then `wrangler secret put RESEND_API_KEY`. Revoke the old key in Resend after confirming delivery.

**Who:** Platform operator.

---

### AI provider

| Secret | Purpose | Staging | Production |
|---|---|---|---|
| `AI_TOKEN` | Bearer token for the live Ollama provider at `AI_BASE_URL` | Conditionally required | Worker secret (when `FEATURE_AI=true`) |
| `OLLAMA_USERNAME` | HTTP Basic Auth username for Ollama | Optional Worker secret | Optional Worker secret |
| `OLLAMA_PASSWORD` | HTTP Basic Auth password for Ollama | Optional Worker secret | Optional Worker secret |

**Note:** `FEATURE_AI` is `false` in production. When enabling AI, `AI_MODEL` must be set explicitly (no implicit `workers-ai` default) and `AI_TOKEN` must be present.

**Rotation:** Generate a new token on the Ollama VPS, update it with `wrangler secret put AI_TOKEN`, then update the VPS configuration. The `AI_BASE_URL` points to `https://ollama.medveris.online`.

**Who:** Platform operator with VPS access.

---

### Payments

| Secret | Purpose | Staging | Production |
|---|---|---|---|
| `LIVEPAY_API_KEY` | LivePay Bearer API key | Worker secret | Worker secret |
| `LIVEPAY_WEBHOOK_SECRET` | HMAC key for LivePay webhook signatures | Worker secret | Worker secret |
| `FEATURE_PAYMENTS` | Enables payment processing | Worker secret (`true`/`false`) | Worker secret (`false`) |
| `YO_MODE` | Yo! Payments mode (`disabled`/`sandbox`/`production`) | Worker secret | Worker secret (`disabled`) |
| `YO_API_USERNAME` | Yo! API username | Worker secret | Not configured |
| `YO_API_PASSWORD` | Yo! API password | Worker secret | Not configured |
| `YO_PUBLIC_KEY` | Yo! public certificate (PEM) | Worker secret | Not configured |
| `YO_NOTIFICATION_BASE_URL` | Yo! notification callback URL | Worker secret | Not configured |

**Rotation (LivePay):**
1. Request a new API key from LivePay.
2. `wrangler secret put LIVEPAY_API_KEY --env production`
3. Verify a test payment processes.
4. Revoke the old key in the LivePay merchant portal.

**Rotation (LivePay webhook secret):**
1. Generate a new secret: `openssl rand -hex 32`
2. Update in LivePay merchant portal.
3. `wrangler secret put LIVEPAY_WEBHOOK_SECRET --env production`
4. Verify webhook signature verification succeeds.

**Who:** Platform operator with payments portal access.

---

### Database

| Secret | Purpose | Where |
|---|---|---|
| `HYPERDRIVE` connection string | Runtime database access (`medveris_runtime`) | Cloudflare Hyperdrive binding (encrypted at rest) |
| `HYPERDRIVE_JOBS` connection string | Jobs database access (`medveris_jobs`) | Cloudflare Hyperdrive binding |
| `MIGRATION_DATABASE_URL` | Migration access (`medveris_migrator`) | `~/.config/medveris/<env>/db.env` (0600) |
| `DATABASE_URL` | Local development database | `~/.config/medveris/development/secrets.env` |

**Rotation:**
1. ALTER ROLE password in PostgreSQL.
2. Update the Hyperdrive config in Cloudflare dashboard (or recreate the config).
3. Update `~/.config/medveris/<env>/db.env`.
4. Verify connectivity with `npm run deploy:production:check`.

**Who:** Database administrator.

---

### Storage

| Secret | Purpose | Where |
|---|---|---|
| `UPLOADS` R2 bucket binding | Cloudflare R2 access | Wrangler binding (no secret value) |

**Note:** R2 access uses the Worker's automatic binding; no explicit secret exists.

---

### Observability

| Secret | Purpose | Staging | Production |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Read-only Cloudflare API token for observability proxy | Conditionally required | Conditionally required |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID | `wrangler.jsonc` var | `wrangler.jsonc` var |
| `CLOUDFLARE_OBSERVABILITY_ENABLED` | Enables the observability proxy | `wrangler.jsonc` var | `wrangler.jsonc` var |

**Rotation:** Create a new read-only API token in the Cloudflare dashboard with permissions for Workers Observability read, then `wrangler secret put CLOUDFLARE_API_TOKEN`. Revoke the old token.

**Who:** Platform operator.

---

### Cloudflare Access (observability host)

| Secret | Purpose | Where |
|---|---|---|
| `CLOUDFLARE_ACCESS_TOKEN` | Enables Access JWT validation (default off) | Worker secret |
| `CLOUDFLARE_ACCESS_TEAM_DOMAIN` | Cloudflare team domain (e.g. `medveris.cloudflareaccess.com`) | Worker var or secret |
| `CLOUDFLARE_ACCESS_AUD` | Access application audience tag | Worker var or secret |

**Note:** When `CLOUDFLARE_ACCESS_TOKEN` is set, the observability routes require a valid `Cf-Access-Jwt-Assertion` header. If enabled but misconfigured, all requests are rejected (503).

**Rotation:** Access JWTs are short-lived and issued by Cloudflare; no rotation is needed. To disable, remove the `CLOUDFLARE_ACCESS_TOKEN` secret.

**Who:** Platform operator with Cloudflare Zero Trust access.

---

### Other integrations

| Secret | Purpose | Staging | Production |
|---|---|---|---|
| `TERMINOLOGY_PROVIDER_TOKEN` | Terminology service API token | Not configured | Not configured |
| `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` | ERPNext service account credentials | Not configured | Not configured |
| `DICOMWEB_USERNAME` / `DICOMWEB_PASSWORD` / `DICOMWEB_BEARER_TOKEN` | PACS credentials | Not configured | Not configured |
| `EHMIS_CREDENTIALS_KEY` | Encrypts per-facility DHIS2 credentials (min 32 chars) | Not configured | Not configured |

### Subscription checkout FX (USD/UGX)

Used only to compute and disclose the UGX equivalent for self-service subscription checkout. No payment is requested unless a valid, non-stale rate is available (fail closed). Provider-fetched rates are cached in the database (`subscription_fx_rates`); an operator-set manual rate in the database (`subscription_fx_manual_rates`, with `rate`, `set_by`, `set_at`, `expires_at`) may be used only as fallback when the provider is unset or fails. Never configure a hardcoded fallback rate. The provider API key must never be logged or stored.

| Name | Kind | Purpose | Default | Where set |
|---|---|---|---|---|
| `FX_PROVIDER` | plaintext config/var | Rate provider selector: `openexchangerates` or `none` | `none` | `.env` / Worker var (`wrangler.jsonc` vars or environment) in staging & production |
| `FX_API_KEY` | **secret** | OpenExchangeRates `app_id` | unset | Worker secret in staging & production: `wrangler secret put FX_API_KEY --env <staging|production>` (never in git/wrangler vars) |
| `FX_TIMEOUT_MS` | plaintext config/var | Provider request timeout (ms, 1000–30000) with retries | `8000` | `.env` / Worker var |
| `FX_MAX_AGE_HOURS` | plaintext config/var | Maximum age for any usable rate; older rates refused (1–168) | `24` | `.env` / Worker var |
| `SUBSCRIPTION_MIN_UGX` | plaintext config/var | Minimum UGX collection | `500` | `.env` / Worker var |

**Manual rate (DB, operator-set fallback):** insert/update a non-expired row in `subscription_fx_manual_rates` (columns: `id`, `base='USD'`, `quote='UGX'`, `rate` numeric>0, `set_by` user id, `set_at`, `expires_at`, `note`) via the billing/operator database path; only rows with `expires_at > now()` and within `FX_MAX_AGE_HOURS` of `set_at` are usable, and only when no fresh provider/cached rate is available.

**Rotation:** create a new OpenExchangeRates key, `wrangler secret put FX_API_KEY --env <env>`, verify a checkout quote resolves, then revoke the old key at the provider.

---

## Secret hygiene checks

Run these before any release:

```bash
# 1. Verify no env files are tracked
git ls-files | grep -E '\.env|\.dev\.vars|secrets\.env|db\.env' && echo "FAIL: env files tracked" || echo "OK"

# 2. Verify .gitignore covers secrets
grep -E '^\.env$|^\.dev\.vars\*|^\*\.pem$' .gitignore || echo "FAIL: .gitignore missing patterns"

# 3. Run gitleaks locally (if installed)
gitleaks detect --source . --no-git || echo "gitleaks not installed; CI will run it"
```

CI runs `gitleaks/gitleaks-action@v2` on every push and pull request.

---

## Emergency: suspected secret exposure

1. **Rotate immediately** — do not wait for confirmation.
   - Session secret: `wrangler secret put SESSION_SECRET` (invalidates all sessions)
   - API keys: revoke in provider portal, then set new value
2. **Check audit log** for unauthorized use:
   ```sql
   SELECT occurred_at, actor_user_id, action, resource_type, resource_id
   FROM audit_events
   WHERE occurred_at > now() - interval '24 hours'
   ORDER BY occurred_at DESC;
   ```
3. **Report** to the security lead within 1 hour.
4. **Document** in the incident ticket (support_tickets table) with severity `sev1`.

---

## Who runs what

| Action | Who |
|---|---|
| Rotate `SESSION_SECRET`, `AUDIT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY` | Platform operator (security lead approval for MFA key) |
| Rotate payment secrets | Platform operator + finance lead |
| Rotate database passwords | Database administrator |
| Rotate `CLOUDFLARE_API_TOKEN` | Platform operator |
| Rotate integration tokens (terminology, FX, ERPNext, PACS) | Platform operator + integration owner |
| Emergency rotation | Any platform operator (report after) |

---

## Verification

After any rotation:

```bash
# Staging
npm run deploy:staging:check
curl -sf https://medveris-staging.aidomexgroupltd.workers.dev/api/health

# Production (operator only)
npm run deploy:production:check
curl -sf https://medveris.online/api/health
```

Do not print secret values during verification. Use `wrangler secret list` (shows names only) to confirm presence.
