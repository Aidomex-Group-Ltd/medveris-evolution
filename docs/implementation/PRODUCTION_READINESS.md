# Production readiness record — 2026-10-28

Status: **BLOCKED — NOT DEPLOYED.** `npm run deploy:production:check` exits 1 on the prerequisites below. No production Worker exists and `medveris.online` is not attached. Staging (`medveris-staging`, version `33aaf2ed-b326-4189-a3ed-cb4f889a137b`, commit `06c1611`) was inspected read-only and left unchanged.

## Resources (verified against Cloudflare and PostgreSQL on 2026-10-28)

| Resource | State |
|---|---|
| Cloudflare account `6337ed24a5f8ff4ec3f74517a55a7e6b` | Wrangler session has access |
| Zone `medveris.online` | Active, Free plan, Cloudflare nameservers; no apex or `www` address records; MX, SPF, DKIM (`resend._domainkey`) and DMARC records present and untouched |
| Worker `medveris-production` | Does not exist (API error 10007) |
| R2 `medveris-production-uploads` | Created 2026-10-28, location WEUR, r2.dev disabled, no custom domain, no CORS, empty |
| R2 `medveris` | Pre-existing, empty, private, WEUR, unreferenced by the repository; left untouched |
| Hyperdrive (production) | None. Only `medveris-staging-runtime` and `medveris-staging-jobs` exist |
| PostgreSQL | Only the staging Aiven server (PostgreSQL 18.6) is known; it holds `_aiven`, `defaultdb` and `medveris_staging`, no production database |
| Local secrets | `~/.config/medveris/production/secrets.env` (0600, directory 0700): `SESSION_SECRET`, `AUDIT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY` generated with `openssl rand -hex 32`; not uploaded (no Worker) |

## Quality gates (from `npm run deploy:production:check`)

| Gate | Result |
|---|---|
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| `npm test` (unit and PostgreSQL integration on local PostgreSQL 14.24 with all 28 migrations) | Pass: 32 files, 261 tests |
| `npm audit --omit=dev --audit-level=high` | Pass: 0 vulnerabilities |
| `npm run build` | Pass |
| `wrangler deploy --env production --dry-run` | Packages (2046 KiB, 355 KiB gzip); bindings still hold the Hyperdrive placeholders |

## Migrations

28 migrations (`001`–`028`). Staging has all 28 applied; `027_content_feed_ingestion.sql` on 2026-10-28T04:26Z and `028_email_sign_in_codes.sql` on 2026-10-28T04:45Z, and the live staging version runs on them. `027` is additive: new nullable columns and defaults, partial unique indexes, jobs-role grants and policies, and replacement CHECK constraints that accept every row the previous constraints accepted while also allowing attributed imports. A version built before `027` keeps working against the migrated schema. No migration has been applied to production because no production database exists.

## Blockers (provider-side actions)

1. **Production PostgreSQL server.** Provision a managed PostgreSQL 14+ server separate from staging, with encrypted backups and point-in-time recovery, in a region approved for Ugandan health data. This needs a provider account and billing decision. Then run `db-setup.ts` and the reviewed migrations as described in `docs/16_OPERATIONS_AND_DEPLOYMENT.md`.
2. **Backup and restore drill.** Record it in `~/.config/medveris/production/backup-verification.json`.
3. **Hyperdrive.** Create the runtime and jobs configs (caching disabled, `verify-full`) and replace the `REPLACE_WITH_PRODUCTION_*` IDs.
4. **Resend.** Create a production-only API key restricted to `medveris.online` and save it in `~/.config/medveris/production/resend.env`.
5. **Domain.** After `npm run deploy:production` passes, run `npm run domain:production`, then declare the custom-domain route. Add a Redirect Rule for `www.medveris.online` if wanted.

## Decisions needing qualified review

- Data residency and cross-border transfer under the Uganda Data Protection and Privacy Act, 2019, including registration with the Personal Data Protection Office: the R2 location hint is Western Europe (R2 has no African region), and the database region is not yet chosen.
- Licensed terminology (SNOMED CT affiliate licence, LOINC terms) before enabling `TERMINOLOGY_MODE=production`. Until then coded entries and UCUM unit validation return 503 in production.
- Content governance before enabling `CONTENT_FEEDS_ENABLED`: imports publish without clinical review.
- Map tiles default to the public OpenStreetMap tile service, whose usage policy limits heavy use; confirm or contract a provider.
- Open findings in `SECURITY_AND_PRIVACY_REVIEW.md` (no Content-Security-Policy, per-isolate rate limiting, emailed sign-in codes, global patient identity RLS) must be accepted or fixed before real patient data.
