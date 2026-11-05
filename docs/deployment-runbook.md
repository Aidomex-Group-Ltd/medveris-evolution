# Medveris deployment runbook

This runbook is derived from the existing repo scripts and configuration:

- `package.json`
- `wrangler.jsonc`
- `apps/api/src/config.ts`
- `scripts/staging-deploy.mjs`
- `scripts/production-deploy.mjs`
- `scripts/staging-gate.mjs`
- `scripts/production-gate.mjs`

It does not change application behavior, database schema, Wrangler environments, or production secrets.

## Environments

| Environment | Primary script | Gate script | Rollback script | Notes |
|---|---|---|---|---|
| Local dev | `npm run dev` / `npm run dev:api` / `npm run dev:web` or `npm run cf:dev` | manual | manual | Plain Node or local Wrangler dev |
| Staging | `npm run deploy:staging` | `scripts/staging-deploy.mjs` | `npm run deploy:staging:rollback` | Workers workers.dev origin |
| Production | `npm run deploy:production` | `scripts/production-deploy.mjs` | `npm run deploy:production:rollback` | Custom domain is attached separately by `npm run domain:production` |

## Local development workflow

### Run API + web together

```bash
npm run dev
```

This starts:

- API via `npm run dev:api`
- Web via `npm run dev:web`

### Run API only

```bash
npm run dev:api
```

`apps/api/src/server.ts` starts with `@hono/node-server` on port `8787`.

### Run web only

```bash
npm run dev:web
```

Web uses Vite on port `5173` and proxies `/api`, `/fhir`, `/terminology` to `http://localhost:8787`.

### Local Wrangler dev

```bash
npm run cf:dev
```

This runs:

```bash
npm run build:web && wrangler dev
```

It uses the root `wrangler.jsonc`, so it is the local equivalent of the Workers deployment path rather than the plain Node server path.

### Local environment files

The Node server and the standalone jobs runner load `.env` if present:

- `apps/api/src/server.ts`
- `apps/jobs/src/index.ts`
- `scripts/db-setup.ts`, `scripts/db-migrate.ts`, `scripts/seed.ts`, and similar tooling may rely on `.env` for local database URLs and related values

Local development may accept:
- `DATABASE_URL`
- `JOBS_DATABASE_URL`
- `PORT`
- App config via environment variables read by `loadConfig()` in `apps/api/src/config.ts`

In local environments only, `DATABASE_URL` is accepted by the Worker entrypoint as a fallback when no `HYPERDRIVE` binding is present.

## Building

### Web

```bash
npm run build:web
```

This runs:

```bash
vite build --config apps/web/vite.config.ts
```

Output is `apps/web/dist`.

### API

```bash
npm run build:api
```

This runs:

```bash
esbuild apps/api/src/server.ts --bundle --platform=node --format=esm \
  --outfile=apps/api/dist/server.mjs --packages=external
```

and

```bash
esbuild apps/api/src/worker.ts --bundle --platform=node --format=esm \
  --outfile=apps/api/dist/worker.mjs --packages=external
```

### Full build

```bash
npm run build
```

This runs:

```bash
npm run build:web && npm run build:api
```

## Staging deployment procedure

### Dry-run gate first

```bash
npm run deploy:staging:check
```

The staging gate verifies:

- `wrangler.jsonc` staging environment shape
- Account pinning to `6337ed24a5f8ff4ec3f74517a55a7e6b`
- Remote Hyperdrive configs for `HYPERDRIVE` and `HYPERDRIVE_JOBS`
- R2 bucket `medveris-staging-uploads` exists and has no public access or custom domains
- Required queues exist
- Required secrets on the Worker
- Durable Object migration state if the Worker already exists
- Live blue version is not split across multiple versions
- Staging secrets and optional Resend secrets
- Lint, typecheck, tests, and build
- `wrangler deploy --env staging --dry-run`
- No `REPLACE_WITH` or `local-only` placeholders in the packaged staging bindings
- Built web entry bundle is present

The staging deploy script reads secrets from:

- `STAGING_SECRETS_FILE`, defaulting to `~/.config/medveris/staging/secrets.env`
- `STAGING_RESEND_FILE`, defaulting to `~/.config/medveris/staging/resend.env`

Both files must be outside the repository and mode `0600`.

### Deploy staging

```bash
npm run deploy:staging
```

The script can deploy in several modes:

- **First deployment**: uses `wrangler deploy --env staging` because there is no blue version yet
- **Durable Object migration release**: uses `wrangler deploy` when a new migration tag is pending, then verifies and restores the previous version on failure
- **Blue-green release**: otherwise uploads a green version, stages at 0%, verifies with a version override header, promotes to 100%, and verifies on live traffic

### Staging secrets handling

The deploy script:

- lists remote staging secrets
- compares them with required secrets from `env.staging.secrets.required`
- uploads only missing secrets from the protected staging files
- never overwrites existing secrets

### Staging cron triggers

The stage/promote path ends by deploying cron triggers:

```bash
npx wrangler triggers deploy --env staging
```

If that step fails, the script warns and tells you to run it manually.

## Staging verification

After deployment, verify:

- Health endpoint responds
- Public config endpoint reports `appEnv=staging`
- Terminology posture is `synthetic`
- Protected routes require authentication
- Missing API routes return structured JSON `404`
- The worker version header reflects the deployed version

You can also run the staging smoke script if the repo provides one for this purpose:

```bash
npm run smoke:clinical
```

and the workers smoke script:

```bash
npm run smoke:workers
```

These are read-only verification commands where present.

If the deployment is blue-green and something is wrong, rollback:

```bash
npm run deploy:staging:rollback
```

## Production deployment procedure

### Dry-run gate first

```bash
npm run deploy:production:check
```

The production gate verifies:

- `wrangler.jsonc` production environment shape
- Account pinning and Wrangler session access to the MedVeris account
- Clean working tree for production releases
- Remote production Hyperdrive configs for `HYPERDRIVE` and `HYPERDRIVE_JOBS`
- Production isolation from staging Hyperdrive configs
- Migration state against `packages/db/migrations`
- Backup verification file in `~/.config/medveris/production/backup-verification.json`
- R2 bucket `medveris-production-uploads`
- Required queues
- Domain state, without attaching the domain
- Production secrets names and required secret declarations
- Lint, typecheck, tests, and dependency audit at high/critical level
- Build
- `wrangler deploy --env production --dry-run`
- No `REPLACE_WITH`, no staging/local references, no placeholder text in packaged bindings
- Built web entry bundle present

### Production secret files

The production deploy script reads from:

- `PRODUCTION_SECRETS_DIR`, defaulting to `~/.config/medveris/production`
- Expected files inside that directory include:
  - `secrets.env`
  - `resend.env`
  - `db.env` with `MIGRATION_DATABASE_URL`

These files must be mode `0600` and stored outside the repository.

### Deploy production

```bash
npm run deploy:production
```

The production deploy script performs the same families of checks as staging, with stronger isolation and safety checks, and then:

- uploads only missing production secrets from the protected files
- performs a blue-green release using `wrangler versions upload`
- stages green at 0%
- verifies green through a version override
- promotes green to 100%
- deploys cron triggers with `npx wrangler triggers deploy --env production`
- verifies green again on live traffic

If verification fails, the script restores blue automatically.

### Production domain handling

The production deploy script does **not** attach the custom domain.

Domain attach is done separately:

```bash
npm run domain:production
```

The deployment gate only verifies that:
- declared domains in `env.production.routes`
- attached domains on the Worker
- `workers_dev` setting

are consistent. It does not attach anything.

### Production release evidence

Production deploys write release evidence to:

```bash
.wrangler/release-evidence/production-<timestamp>.json
```

This includes configuration digests, check outcomes, blue version, secret upload list, and verification outcome, but no secret values.

## Production verification

After deployment, verify:

- Health endpoint responds
- Public config reports `appEnv=production` and terminology posture is not synthetic
- No unverified integration is reported as available in public config
- Protected routes require authentication
- Missing routes return JSON `404`
- Version metadata header reflects the deployed version
- Release evidence was written

If needed, use the production smoke path embedded in the deploy script; it probes:

- `/api/v1/public/config`
- `/api/v1/me`
- an unknown API route

Those checks are safe because they only read public or unauthenticated responses.

If something is wrong, rollback:

```bash
npm run deploy:production:rollback
```

## Environment variables and secrets

### Config source of truth

Runtime configuration is derived in:

- `apps/api/src/config.ts`

Environment variables are mapped into `AppConfig` and validated at startup.

### Top-level required secrets in production

Production expects these secrets:

- `SESSION_SECRET`
- `AUDIT_SIGNING_KEY`
- `MFA_ENCRYPTION_KEY`
- `RESEND_API_KEY`

And these may be required depending on config:

- PACS credentials when `FEATURE_DICOMWEB=true`
- Yo! credentials when `FEATURE_PAYMENTS=true` and `YO_MODE=production`

### Staging required secrets

Staging expects at minimum:

- `SESSION_SECRET`
- `AUDIT_SIGNING_KEY`
- `MFA_ENCRYPTION_KEY`

and `RESEND_API_KEY` when `EMAIL_ADAPTER=resend`.

### Secrets are Worker secrets, not plaintext vars

Production and staging both:
- declare required secrets in `env.<env>.secrets.required`
- forbid secret-like values as plaintext vars
- validate that `SESSION_SECRET`, `AUDIT_SIGNING_KEY`, and `MFA_ENCRYPTION_KEY` are distinct and not placeholder/test values in non-test environments

### Important config variables

Examples from `apps/api/src/config.ts`:

- `APP_ENV`
- `APP_ORIGIN`
- `DATABASE_URL` / `HYPERDRIVE` bindings
- `EXPECTED_DATABASE_NAME`
- `SESSION_SECRET`, `AUDIT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY`
- `RESEND_API_KEY`, `EMAIL_ADAPTER`, `EMAIL_FROM`
- `STORAGE_ADAPTER`, `LOCAL_UPLOAD_DIR`
- `TERMINOLOGY_MODE`, `TERMINOLOGY_PROVIDER_URL`
- `FHIR_EXTERNAL_WRITES_ENABLED`, `FHIR_BULK_EXPORT_ENABLED`
- `DEV_SHOW_TOTP_SECRETS`
- `REALTIME_ENABLED`, `REALTIME_EVENT_TYPES`
- `DB_REPLICA_ENABLED`, `DB_REPLICA_MAX_LAG_MS`, `DB_READ_YOUR_WRITES_MS`
- `FEATURE_DICOMWEB`, `DICOMWEB_BASE_URL`, `DICOMWEB_AUTH`
- `FEATURE_PAYMENTS`, `YO_MODE`, Yo! credentials
- `BILLING_ENFORCEMENT`, `USAGE_METERING`
- `CACHE_KEY_EPOCH`, `REQUEST_LOG_SAMPLE_RATE`

### Local-only exceptions

`DATABASE_URL` is accepted in local Worker development but not treated as a production pattern. Outside local development and tests, app config enforces HTTPS origins, verified email sender domains, and other safety checks.

## Database migration safety

### How migrations are applied

Migrations live in:

- `packages/db/migrations`

They are applied through separate reviewed tooling/scripts, not by the deploy scripts.

### What the deploy scripts do not do

- They do **not** run database migrations
- They do **not** reset data
- They do **not** attach production custom domains

### What the production gate does verify about migrations

The production gate verifies:

- migration files present in `packages/db/migrations`
- migration state in the production database
- that there are no pending migrations unknown to the release
- that there are no migrations applied in production that are not in the current release

### Blue-green compatibility rule

Staging releases share the staging database between blue and green versions. The deploy script expects backward-compatible migrations:

- expand first
- contract later

This is part of the documented staging release notes in `scripts/staging-deploy.mjs`.

### Migration state for production

The production gate connects read-only to the migration database URL from `~/.config/medveris/production/db.env` and checks applied versions against the migration set. It does not apply migrations.

### Replay tooling

For failed jobs, the repo includes replay tooling:

```bash
npm run jobs:dead-letters
npm run jobs:replay
```

These operate on dead letters rather than changing schema or core deployment mechanics.

## Rollback and recovery procedures

### Staging rollback

```bash
npm run deploy:staging:rollback
```

This switches traffic back to the previous version.

### Production rollback

```bash
npm run deploy:production:rollback
```

This is described as code-only rollback; migrations are not reversed.

### When rollback is needed

Use rollback when:

- the current live deployment is split across versions and a new release cannot start cleanly
- a blue-green promotion fails
- a post-promotion verification fails

### Recovery boundaries

- Code rollback restores a previous Worker version.
- Database changes are outside the rollback script.
- Domain state is outside the deploy script.
- Queue dead letters are recorded for operator replay, not auto-replayed by the deploy script.

## Post-deployment health checks

### Minimal set

- Health endpoint: `/api/health`
- Public config: `/api/v1/public/config`
- Unauthenticated access to protected routes should be rejected
- Unknown API routes should return JSON `404`

### Automated checks used by the deploy scripts

The production deploy script runs a safe smoke check against:

- `/api/v1/public/config`
- `/api/v1/me`
- `/api/v1/production-gate-unknown`

It does not depend on authenticated sessions for those probes.

### Observability hooks

Production observability is enabled in `wrangler.jsonc` with query strings redacted. Request logging sample rate is configurable via `REQUEST_LOG_SAMPLE_RATE`.

## Standalone Node jobs vs Worker jobs

The repo contains two job execution paths:

- Standalone Node runner: `apps/jobs/src/index.ts`
- Worker background handling: `apps/api/src/worker.ts` scheduled and queue handlers

Deployments use the Worker path. The standalone runner is a separate local/operational path, not the deployed production mechanism.

## Verified deployment commands

### Local

```bash
npm run dev
npm run dev:api
npm run dev:web
npm run cf:dev
```

### Build

```bash
npm run build
npm run build:web
npm run build:api
```

### Staging

```bash
npm run deploy:staging:check
npm run deploy:staging
npm run deploy:staging:rollback
```

### Production

```bash
npm run deploy:production:check
npm run deploy:production
npm run deploy:production:rollback
npm run domain:production
```

### Quality and verification

```bash
npm run lint
npm run typecheck
npm run test
npm run test:e2e
npm run dependency:audit
```

With runtime verification scripts where present:

```bash
npm run verify:runtime
npm run smoke:workers
npm run smoke:clinical
```

Note: dependency audit is invoked by the production gate as:

```bash
npm audit --omit=dev --audit-level=high
```

## Out of scope for this runbook

This runbook does not cover:

- changing production secrets
- enabling production read replicas
- enabling production realtime
- enabling feature flags that are currently off
- modifying Wrangler bindings or environments
- running migrations
- attaching domains during a deploy
- any change that weakens existing production gates
