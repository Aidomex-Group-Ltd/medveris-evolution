# Production readiness record — 2026-10-28

Status: **BLOCKED — NOT DEPLOYED.** `npm run deploy:production:check` exits 1 on the prerequisites below. No production Worker exists and `medveris.online` is not attached. Staging (`medveris-staging`, version `a68516b2-b2c5-434d-8260-86da089b73d0`, commit `01ec417`) was inspected read-only and left unchanged.

## Why https://medveris.online reports DNS_PROBE_FINISHED_NXDOMAIN (verified 2026-10-28 11:15 EAT)

Registration and delegation are healthy: Namecheap registration, active until 2027-08-22, registry status `client transfer prohibited`; the `.online` registry delegates to `donna.ns.cloudflare.com` and `phil.ns.cloudflare.com`, which match the active zone in the MedVeris account (activated 2026-10-27). Both authoritative servers answer `medveris.online` A/AAAA with NOERROR and no answer (only MX, SPF and DMARC exist) and `www.medveris.online` with NXDOMAIN; negative answers are cached for 1800 s (SOA minimum). The hostname has no address because nothing has been published at it: the Worker custom domain that would create the record and certificate can only be attached after `medveris-production` is deployed and verified, and that deployment is blocked below. No manual A/AAAA/CNAME record should be added; `npm run domain:production` creates the record.

## Production PostgreSQL (`medverispro`, inspected read-only 2026-10-28)

`~/.config/medveris/production/db.env` (0600) targets `medverispro-lokangtom2017-78dc.l.aivencloud.com:23226`, a different server from staging, with `sslmode=verify-full` against `~/.config/medveris/production/ca.pem`; all four URLs share that host, and the three role passwords are distinct and at least 20 characters. A read-only admin connection verified the certificate and found PostgreSQL 18.6 with only `_aiven` and `defaultdb`. With approval, `db-setup.ts` then created `medveris_migrator`, `medveris_runtime` and `medveris_jobs` (LOGIN, no superuser, no BYPASSRLS), `medveris_exchange` (NOLOGIN, BYPASSRLS) and `medveris_production` owned by `medveris_migrator`; all three login roles connect with verified TLS. The database is empty (no `schema_migrations`): migrations `001`–`029` have not been applied and need separate approval after the backup check.

## Resources (verified against Cloudflare and PostgreSQL on 2026-10-28)

| Resource | State |
|---|---|
| Cloudflare account `6337ed24a5f8ff4ec3f74517a55a7e6b` | Wrangler session has access |
| Zone `medveris.online` | Active, Free plan, Cloudflare nameservers; no apex or `www` address records; MX, SPF, DKIM (`resend._domainkey`) and DMARC records present and untouched |
| Worker `medveris-production` | Does not exist (API error 10007) |
| R2 `medveris-production-uploads` | Created 2026-10-28, location WEUR, r2.dev disabled, no custom domain, no CORS, empty |
| R2 `medveris` | Pre-existing, empty, private, WEUR, unreferenced by the repository; left untouched |
| Hyperdrive (production) | None. Only `medveris-staging-runtime` and `medveris-staging-jobs` exist |
| PostgreSQL | Staging Aiven server holds `medveris_staging`. Production Aiven server `medverispro` (PostgreSQL 18.6, separate host) is reachable with verified TLS and empty: no `medveris_production`, no `medveris_*` roles |
| Local secrets | `~/.config/medveris/production/secrets.env` (0600, directory 0700): `SESSION_SECRET`, `AUDIT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY` generated with `openssl rand -hex 32`; not uploaded (no Worker) |

## Quality gates (from `npm run deploy:production:check`)

| Gate | Result |
|---|---|
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| `npm test` (unit and PostgreSQL integration on local PostgreSQL 14.24 with all 29 migrations) | Pass: 36 files, 291 tests |
| `npm audit --omit=dev --audit-level=high` | Pass |
| `npm run build` | Pass |
| `wrangler deploy --env production --dry-run` | Packages (2062 KiB, 358 KiB gzip); bindings still hold the Hyperdrive placeholders |

## Migrations

29 migrations (`001`–`029`); `029_invitation_lifecycle.sql` was added after this record was first written and its staging state was not re-checked here. Staging had `001`–`028` applied; `027_content_feed_ingestion.sql` on 2026-10-28T04:26Z and `028_email_sign_in_codes.sql` on 2026-10-28T04:45Z, and the live staging version runs on them. `027` is additive: new nullable columns and defaults, partial unique indexes, jobs-role grants and policies, and replacement CHECK constraints that accept every row the previous constraints accepted while also allowing attributed imports. A version built before `027` keeps working against the migrated schema. No migration has been applied to production: the `medverispro` server has no `medveris_production` database yet.

## Blockers (provider-side actions)

1. **Production migrations (approval required).** Roles and `medveris_production` exist on `medverispro`. Confirm point-in-time recovery and encrypted backups on the Aiven plan, then apply the reviewed migrations `001`–`029` as described in `docs/16_OPERATIONS_AND_DEPLOYMENT.md`.
2. **Backup and restore drill.** Record it in `~/.config/medveris/production/backup-verification.json`.
3. **Hyperdrive.** Create the runtime and jobs configs (caching disabled, `verify-full`) and replace the `REPLACE_WITH_PRODUCTION_*` IDs.
4. **Resend.** Create a production-only API key restricted to `medveris.online` and save it in `~/.config/medveris/production/resend.env`.
5. **Domain.** After `npm run deploy:production` passes, run `npm run domain:production`, then declare the custom-domain route. For `www.medveris.online`, add a proxied placeholder record (`AAAA 100::`) and a Redirect Rule to `https://medveris.online` preserving path and query; the Worker serves assets without running for page requests, so it cannot redirect `www` itself, and the Wrangler session cannot edit DNS records or rulesets.

## Decisions needing qualified review

- Data residency and cross-border transfer under the Uganda Data Protection and Privacy Act, 2019, including registration with the Personal Data Protection Office: the R2 location hint is Western Europe (R2 has no African region), and the database region is not yet chosen.
- Licensed terminology (SNOMED CT affiliate licence, LOINC terms) before enabling `TERMINOLOGY_MODE=production`. Until then coded entries and UCUM unit validation return 503 in production.
- Content governance before enabling `CONTENT_FEEDS_ENABLED`: imports publish without clinical review.
- Map tiles default to the public OpenStreetMap tile service, whose usage policy limits heavy use; confirm or contract a provider.
- Open findings in `SECURITY_AND_PRIVACY_REVIEW.md` (no Content-Security-Policy, per-isolate rate limiting, emailed sign-in codes, global patient identity RLS) must be accepted or fixed before real patient data.
