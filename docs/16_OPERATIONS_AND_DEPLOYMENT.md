# Operations deployment and recovery

## Environments and provisioning

Local: synthetic PostgreSQL, test identity adapter/mail sink, local object emulator or development bucket and simulated integrations. Staging: isolated managed database, private objects, sandbox identity and integrations, no production patient data. Production: approved database/storage region, vendor agreements, hardened secrets, monitored backups and named support coverage. Keep separate Cloudflare bindings and explicit environment names. Do not reuse production signing keys or adapter credentials in previews.

Provision API/static assets, Hyperdrive binding, PostgreSQL roles and migrations, private object stores, queues/dead-letter handling, signing keys, telemetry and DNS/TLS. Verify current provider limits and regions rather than copying hard-coded quota values. Clinical query caching is disabled. Anonymous static assets may be cached; authenticated data and permission decisions are not. Verify egress and object-delivery paths under real credentials.

### Cloudflare staging (`medveris-staging`)

`wrangler.jsonc` top level is local `wrangler dev` only; `env.staging` is the deployable Worker. `npm run deploy:staging:check` runs every gate without creating, uploading, migrating or deploying anything and exits non-zero while any prerequisite is missing; `npm run deploy:staging` runs the same gate, deploys, then probes `/api/v1/health/live` and `/api/v1/health/ready`. Neither script runs migrations.

1. Staging database: a hosted PostgreSQL 14+ server that is separate from production, contains no real patient data and is reachable by Hyperdrive over TLS. The provider must allow creating `medveris_exchange` (`NOLOGIN BYPASSRLS`) and SECURITY DEFINER ownership by `medveris_migrator`. Migrations are tested on PostgreSQL 14; run the integration suite against the chosen major version first.
2. Roles: put `PGADMIN_URL`, `MIGRATION_DATABASE_URL`, `DATABASE_URL`, `JOBS_DATABASE_URL`, `MIGRATOR_PASSWORD`, `RUNTIME_PASSWORD`, `JOBS_PASSWORD` and `APP_ENV=staging` in a mode-0600 file outside the repository (`~/.config/medveris/staging/db.env`), then run `node --env-file=<file> node_modules/.bin/tsx scripts/db-setup.ts` and the same for `scripts/db-migrate.ts`. Do not `source` the file in a shell: `&` in the connection URLs splits the assignments and the scripts silently fall back to the local `.env`. `db:setup` refuses development passwords and an admin URL on a different server for any database other than `medveris_dev`/`medveris_test`.
3. Hyperdrive: create two configs with query caching disabled, `medveris-staging-runtime` (user `medveris_runtime`) and `medveris-staging-jobs` (user `medveris_jobs`), both on `medveris_staging`. Prefer the dashboard so passwords never appear in process arguments or shell history. Put the two IDs in `env.staging.hyperdrive`.
4. Secrets: `SESSION_SECRET`, `AUDIT_SIGNING_KEY` and `MFA_ENCRYPTION_KEY` live in `~/.config/medveris/staging/secrets.env` (mode 0600). The deploy script uploads them only to fill secrets the Worker lacks and never overwrites existing values; rotating the data-bound keys needs a reviewed rotation procedure.
5. Email: staging sends through Resend from `no-reply@medveris.online` (the Resend-verified domain) with `RESEND_API_KEY` stored as a Worker secret. To provide the key for a new Worker, put `RESEND_API_KEY=re_…` in `~/.config/medveris/staging/resend.env` (mode 0600); the gate uploads only a missing secret and refuses to deploy Resend without a key or with a `.local` sender. Each send's outcome, including the provider's rejection reason, is recorded in `email_tokens.delivery_status`/`delivery_detail`.
6. Objects: `medveris-staging-uploads` is private (no r2.dev URL, no custom domain, no CORS). All object access goes through authenticated Worker routes.

## CI and release pipeline

Pull request → formatting and type checks → domain tests → PostgreSQL migration/isolation/contract tests → browser flows → production build → dependency/secret checks → deploy staging → smoke and migration rehearsal → review release evidence → authorized production rollout → monitored verification. Use least-privilege CI credentials and protected environments. Pin build dependencies and preserve a lockfile. Do not create CI jobs that print all environment variables.

A release artifact records commit, dependency lock hash, migration set, configuration schema version, flags and rollback instructions. Use additive compatible migrations before application changes and defer destructive contraction. A code rollback must not assume an old binary can understand a new destructive schema. Prepare forward fixes and restore plans. Never use database reset as deployment automation.

## Health observability and alerts

Liveness confirms process/service reachability without database details. Restricted readiness checks validate required dependencies. Track API latency/errors, authorization denials, authentication failures, database pool exhaustion, audit persistence failure, outbox age, dead-letter depth, export volume, credential verification backlog, device lag and model failure rates. Logs contain correlation IDs and minimal references, not clinical narratives or bearer tokens. Clinical device alerts and infrastructure alarms have different owners.

Assign an on-call owner and escalation path before clinical use. Audit persistence failure blocks affected protected operations and prompts downtime procedure. An unavailable model, ledger anchor or email delivery must not appear as successful. Keep status messages truthful and avoid revealing sensitive incident details to unprivileged users.

## Backup and recovery

Proposed core targets: RPO ≤15 minutes, RTO ≤4 hours, pending pilot approval. Enable supported point-in-time recovery, encrypted backups, protected separate credentials and documented retention. Include database, object versions, patient identity links, audit events, checkpoint/proof material, configuration and key-recovery strategy. Database backup alone cannot reconstruct missing images or cryptographic keys.

Run a restore drill before pilot and on a defined recurring schedule. Restore into isolated infrastructure; verify patient counts, referential integrity, sample signed-version checks, object availability, grant states and audit continuity. Record actual recovery time and data gap. Reconcile externally delivered payments, notifications and device events before resuming consumers to avoid duplicates. Test loss of a signing key and access to backups without normal production credentials.

## Incident and downtime runbook

Detect → classify → contain affected access/integration → preserve evidence → assign clinical/privacy/security leads → activate clinical downtime workflow → investigate scope → recover and verify → communicate through approved channels → review and improve. Notification obligations and deadlines are jurisdiction-specific and require current legal guidance. Do not invent a universal breach deadline.

Downtime procedure identifies how staff confirm patient identity, document care securely, receive critical results, prescribe/administer medicines and later reconcile records. Paper or local contingency records require controlled entry with original occurrence and later recording times. Do not mark unavailable cloud monitoring as normal observations. Reopening service requires explicit reconciliation of queues, pending orders and critical alerts.

## Cost controls

Budget database/backup capacity, private object storage, imaging/PACS, media minutes, inference, network egress, verification labor and operational support separately. No free-tier production guarantee is assumed. Measure cost per facility, encounter, stored study and AI task using non-identifying metrics. Set quotas that do not silently discard clinical records or block urgent care documentation; provide explicit escalation and continuity procedures.

## Standards services operation

Provision separate FHIR facade/engine configuration, profile-package registry, licensed terminology service/releases, value-set/map versions and private PACS endpoints. Monitor FHIR validation failures, unresolved mappings, terminology query failures, PACS backlog, partial STOW failures and imaging reconciliation. Back up local value sets, reviewed maps, profile packages and external identifier links in addition to clinical data and images. Rehearse terminology upgrades with historical-code compatibility and rollback; do not silently replace releases. Configure entitlement-aware terminology caches separately from forbidden shared clinical caching. Each vendor API requires tested timeout, retries, quotas, circuit breaker and reconciliation.
