# Deployment environments

This repository deploys to two Cloudflare Workers environments:

| Environment | Worker name | `wrangler.jsonc` section | Origin | Database |
| --- | --- | --- | --- | --- |
| Staging | `medveris-staging` | `env.staging` | `https://medveris-staging.aidomexgroupltd.workers.dev` | `medveris_staging` |
| Production | `medveris-production` | `env.production` | `https://medveris.online` (attached after `npm run domain:production`) | `medveris-prod` |

The top-level keys in `wrangler.jsonc` are local `wrangler dev` only. Staging and production each have their own environment section, bindings, variables, secrets and release scripts. They never share credentials, database servers or secret files.

## Provider and branch strategy

- **Hosting provider:** Cloudflare Workers, with PostgreSQL through Hyperdrive, private R2 bucket storage, Queues/Durable Objects, and a Workers custom domain for production.
- **Account:** `6337ed24a5f8ff4ec3f74517a55a7e6b` (pinned in `wrangler.jsonc` so every remote command targets the MedVeris account regardless of which account Wrangler is logged into).
- **Branch strategy:** this repository currently uses `pr-readiness-20261116` as the staging branch, so the staging deployment workflow is configured to run from that branch. When the repository adopts a dedicated long-lived staging branch, update the workflow `on.push.branches` and the CI environment comment; the deploy scripts and Wrangler config stay the same.
- **Release artifacts:** the existing release scripts (`npm run deploy:staging`, `npm run deploy:production`) use Cloudflare Worker versioning for blue-green releases. The same built Worker artifact that passes staging should be promoted to production through the production workflow, not rebuilt independently.

## Required secrets and environment setup

Never commit secret values. Each environment keeps secrets in a protected directory outside the repository with mode `0700` for the directory and `0600` for the files. The deploy scripts read those files and upload only the names the Worker lacks.

### Common concepts

- **Secrets lives outside the repository.** Protected files are in `~/.config/medveris/<env>/`. The `.gitignore` keeps `*.env`, `.config/medveris/` and similar paths out of the repository.
- **Never reuse production keys in staging, previews or local dev.** Staging and production have independent SESSION_SECRET, AUDIT_SIGNING_KEY and MFA_ENCRYPTION_KEY.
- **Data-bound keys are sensitive.** AUDIT_SIGNING_KEY and MFA_ENCRYPTION_KEY protect existing data. Regenerating them without a rotation procedure breaks MFA decryption or signature verification. The scripts refuse to regenerate data-bound keys when dependent data exists.

### Staging

Protected paths (outside the repository):

- `~/.config/medveris/staging/db.env` — `PGADMIN_URL`, `MIGRATION_DATABASE_URL`, `DATABASE_URL`, `JOBS_DATABASE_URL`, `MIGRATOR_PASSWORD`, `RUNTIME_PASSWORD`, `JOBS_PASSWORD`, `APP_ENV=staging`. Mode `0600`, not committed.
- `~/.config/medveris/staging/secrets.env` — `SESSION_SECRET`, `AUDIT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY`. Mode `0600`.
- `~/.config/medveris/staging/resend.env` — `RESEND_API_KEY` for the staging Resend key.

The staging deploy script also references these optional environment variables for non-default paths:

- `STAGING_SECRETS_FILE`
- `STAGING_RESEND_FILE`

Required staging Worker secrets are declared in `wrangler.jsonc` under `env.staging.secrets.required`:

- `SESSION_SECRET`
- `AUDIT_SIGNING_KEY`
- `MFA_ENCRYPTION_KEY`
- `RESEND_API_KEY`
- `FEATURE_PAYMENTS`
- `YO_MODE`
- `YO_API_USERNAME`
- `YO_API_PASSWORD`
- `YO_PUBLIC_KEY`
- `YO_NOTIFICATION_BASE_URL`
- `LIVEPAY_API_KEY`
- `LIVEPAY_WEBHOOK_SECRET`

Some of those are feature-flag-like values stored as Worker secrets so they are not edited inline; the rest are provider credentials or keys. Configure them directly in Cloudflare Workers secrets for `medveris-staging`, or let the deploy script upload only missing names from the protected files.

Staging also needs:

- Hyperdrive config `medveris-staging-runtime` (user `medveris_runtime`) and `medveris-staging-jobs` (user `medveris_jobs`) on `medveris_staging`, both with query caching disabled. Put the two IDs in `env.staging.hyperdrive`.
- R2 bucket `medveris-staging-uploads`, private (no r2.dev URL, no custom domain).
- Queues `medveris-staging-jobs` and `medveris-staging-jobs-dlq`.
- A PACS VPC service binding only if staging DICOMweb is being tested.

### Production

Protected paths (outside the repository):

- `~/.config/medveris/production/db.env` — `PGADMIN_URL`, `MIGRATION_DATABASE_URL` (database `medveris_production`), `DATABASE_URL`, `JOBS_DATABASE_URL`, `MIGRATOR_PASSWORD`, `RUNTIME_PASSWORD`, `JOBS_PASSWORD`, `APP_ENV=production`. Mode `0600`.
- `~/.config/medveris/production/secrets.env` — `SESSION_SECRET`, `AUDIT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY`, `RESEND_API_KEY`, `AI_TOKEN`, `LIVEPAY_API_KEY`, `LIVEPAY_WEBHOOK_SECRET`, plus any PACS or Yo! secrets when those features are enabled. Mode `0600`.
- `~/.config/medveris/production/resend.env` — production Resend key restricted to `medveris.online`.
- `~/.config/medveris/production/backup-verification.json` — backup attestation with point-in-time recovery and encrypted backups, plus a recorded restore drill.

The production deploy script also references these optional environment variables for non-default paths:

- `PRODUCTION_SECRETS_DIR`

Required production Worker secrets are declared in `wrangler.jsonc` under `env.production.secrets.required`:

- `SESSION_SECRET`
- `AUDIT_SIGNING_KEY`
- `MFA_ENCRYPTION_KEY`
- `RESEND_API_KEY`
- `AI_TOKEN`
- `LIVEPAY_API_KEY`
- `LIVEPAY_WEBHOOK_SECRET`

Production also needs:

- Hyperdrive config `medveris-production-runtime` (user `medveris_runtime`) and `medveris-production-jobs` (user `medveris_jobs`) on `medveris_prod`, both with query caching disabled and `verify-full` TLS.
- R2 bucket `medveris-production-uploads`, private.
- Queues `medveris-production-jobs` and `medveris-production-jobs-dlq`.
- A restore drill recorded in `backup-verification.json` within the last 90 days. The gate refuses to release without it.
- Domain attachment only after production is live and verified, using `npm run domain:production` or the equivalent Cloudflare Workers custom-domain API call. Email, DNS and TLS records are never overwritten by the domain script.

## How to deploy each environment

### Local / preview builds

Local `wrangler dev` uses the top-level section in `wrangler.jsonc`. It is not a deployable environment.

### Staging

Manual local deploy:

```
npm run deploy:staging:check   # gate only; nothing is created, uploaded or deployed
npm run deploy:staging         # gate, then blue-green release
npm run deploy:staging:rollback
```

Automated staging deploy: push to the staging branch triggers `.github/workflows/deploy-staging.yml`. That workflow runs the same quality gates as the local script: runtime dependency audit, lint, typecheck, tests, build, and the staging deployment gate. It then runs `npm run deploy:staging`.

The staging workflow uses `environment: staging`, so you can attach environment-specific reviewers, scoped secrets and deployment branch rules in the repository settings if you want them.

### Production

Production never deploys automatically from push or pull requests. It is triggered manually from the repository UI with `.github/workflows/deploy-production.yml`, which pauses at the protected `production` GitHub Environment until an authorized reviewer approves it.

Manual local deploy:

```
npm run deploy:production:check   # gate only; nothing is created, uploaded, migrated or deployed
npm run deploy:production         # gate, then blue-green release
npm run deploy:production:rollback
```

The production workflow runs the same gates and then `npm run deploy:production:check`. After approval, it runs the production deployment gate and leaves promotion evidence in the run logs and `.wrangler/release-evidence/` on the runner.

### Domain and verification

Production domain attachment is separate from the deploy:

```
npm run domain:production:check
npm run domain:production
```

Until the domain is attached, production is verified on `https://medveris-production.aidomexgroupltd.workers.dev`. After attachment, declare the route in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "medveris.online", "custom_domain": true }]
```

The production gate then refuses a declared domain that is not attached, and an attached one that is not declared. `www.medveris.online` is not attached as a second custom domain; redirect it to the apex with a Cloudflare Redirect Rule.

### Promotion model

The intended promotion path is:

1. Staging deploys automatically from the staging branch.
2. The same commit is reviewed in staging evidence.
3. Production is promoted manually from the production workflow after approval.

Because both environments use the same Wrangler build artifact path (`apps/api/src/worker.ts` with the built `apps/web/dist`), the promotion model is: promote the same version, not rebuild production from scratch. The production gate still re-runs its own verification, migration state, Hyperdrive isolation, backup attestation and domain checks before cutover.

## Required approvals

- **Staging:** automated on push to the staging branch. Add reviewers to the GitHub `staging` environment if you want a second pair of eyes before staging deploys.
- **Production:** manual dispatch only, with the `production` GitHub Environment protected by required reviewers. No production deploy runs without that approval.

## Rollback

Code rollback is blue-green and immediate:

- Staging: `npm run deploy:staging:rollback` or `npm run deploy:staging:rollback -- <version-id>`.
- Production: `npm run deploy:production:rollback` or `npm run deploy:production:rollback -- <version-id>`.

Rollback restores the previous fully deployed version and re-verifies it. It does not undo database migrations; blue/green must remain compatible with the current schema, and destructive schema changes must come after the code that depends on them.

Database rollback is separate and manual. The deploy scripts do not run migrations, reset data, or attach the domain. If a migration has already been applied, rollback means:

1. Revert the code to the last known-good version.
2. Restore from the production backup/point-in-time recovery documented in `backup-verification.json`.
3. Re-verify staging or a staging-like environment before touching production again.

Never use `db:reset:synthetic` against production. It is for disposable local/test data only.

## Database changes and migration safety

Database schema is managed with additive, backward-compatible migrations under `packages/db/migrations/*.sql`.

Safe rollout practice:

- Run `npm run db:migrate` against staging first.
- Review each pending migration file before production use.
- Apply migrations only after the production backup check.
- Keep migrations compatible with the currently live blue version; remove old columns/tables in a later release.

Migration workflow for production:

1. Confirm backup attestation is current in `~/.config/medveris/production/backup-verification.json`.
2. Review pending migration files.
3. Apply with `node --env-file=<production db.env> node_modules/.bin/tsx scripts/db-migrate.ts --confirm-database=medveris_prod`.
4. The production gate reads `schema_migrations` read-only and refuses to release while any migration is pending or unknown.

The repository also has synthetic-only reset tooling:

- `npm run db:reset:synthetic`
- `npm run db:seed`

These are for local/test data only and must not be pointed at staging or production.

## What you still need to configure outside the repository

You must configure these separately; they are intentionally not in the repository:

- GitHub repository settings:
  - Enable the `staging` and `production` GitHub Environments and set required reviewers on `production`.
  - Optionally restrict the staging deployment workflow to the staging branch.
  - Grant the CI job the least-privilege permissions it needs.
- Cloudflare, for staging:
  - Wrangler authentication on the CI runner sufficient to deploy `medveris-staging` and manage its secrets.
  - Worker secrets for `medveris-staging`, or the protected staging secret files the deploy script uploads only when missing.
  - Hyperdrive configs, R2 bucket and staging queues matching `wrangler.jsonc`.
- Cloudflare, for production:
  - Wrangler authentication on the CI runner sufficient to deploy `medveris-production` and manage its secrets.
  - Production Worker secrets matching `wrangler.jsonc`, or the protected production secret files.
  - Production Hyperdrive configs, R2 bucket and production queues.
  - A current restore drill recorded in `~/.config/medveris/production/backup-verification.json`.
- DNS and email:
  - `medveris.online` zone in the same Cloudflare account.
  - Existing MX/SPF/DKIM/DMARC and Resend records left untouched by deployment tooling.

## Important limitation

This workspace's local test database could not be re-verified end-to-end in this session because the integration suite timed out repeatedly. The workflows are ready for review, but the staging/production promotion path still depends on the existing local-quality gate (`npm run deploy:staging:check` etc.) passing in CI with a healthy test database. Treat this as configuration and wiring, not a proven live deploy.
